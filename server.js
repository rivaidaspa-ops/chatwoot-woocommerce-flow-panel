// v8.1: multitienda tolerante a credenciales faltantes, productos por tienda y mensajes claros.

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const Redis = require('ioredis');
const { Pool } = require('pg');
const FormData = require('form-data');

const app = express();
const PORT = Number(process.env.PORT || 3001);
const WC_URL = String(process.env.WC_URL || '').replace(/\/$/, '');
const FLOW_API_URL = String(process.env.FLOW_API_URL || 'https://www.flow.cl/api').replace(/\/$/, '');
const CHATWOOT_URL = String(process.env.CHATWOOT_URL || '').replace(/\/$/, '');
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 900);
const PAGE_CACHE_SECONDS = Number(process.env.PAGE_CACHE_SECONDS || 120);
const PRODUCT_PAGE_SIZE = Number(process.env.PRODUCT_PAGE_SIZE || 20);
const MAX_PAGE_SIZE = Number(process.env.MAX_PAGE_SIZE || 40);

function parseJsonEnv(name, fallback) { try { return process.env[name] ? JSON.parse(process.env[name]) : fallback; } catch (e) { console.warn(`[WARN] ${name} invalido:`, e.message); return fallback; } }

function defaultPaymentPresets(storeId = 'co') {
  if (storeId !== 'co') return [];
  const configured = parseJsonEnv('CO_PAYMENT_METHOD_PRESETS_JSON', null);
  if (Array.isArray(configured) && configured.length) return configured;
  return [
    { id: getCfg('CO_COD_GATEWAY_ID', 'cod'), title: getCfg('CO_COD_GATEWAY_TITLE', 'Contra entrega'), kind: 'cash_on_delivery', requires_link: false, recommended: true },
    { id: getCfg('CO_WOMPI_GATEWAY_ID', 'wompi'), title: getCfg('CO_WOMPI_GATEWAY_TITLE', 'Wompi'), kind: 'online', requires_link: true, recommended: true },
    { id: getCfg('CO_BOLD_GATEWAY_ID', 'bold'), title: getCfg('CO_BOLD_GATEWAY_TITLE', 'Bold'), kind: 'online', requires_link: true, recommended: true },
    { id: getCfg('CO_PSE_GATEWAY_ID', 'pse'), title: getCfg('CO_PSE_GATEWAY_TITLE', 'PSE'), kind: 'online', requires_link: true, recommended: false },
    { id: getCfg('CO_MERCADO_PAGO_GATEWAY_ID', 'mercadopago'), title: getCfg('CO_MERCADO_PAGO_GATEWAY_TITLE', 'Mercado Pago Colombia'), kind: 'online', requires_link: true, recommended: false },
    { id: getCfg('CO_EPAYCO_GATEWAY_ID', 'epayco'), title: getCfg('CO_EPAYCO_GATEWAY_TITLE', 'ePayco'), kind: 'online', requires_link: true, recommended: false },
    { id: getCfg('CO_PAYU_GATEWAY_ID', 'payu'), title: getCfg('CO_PAYU_GATEWAY_TITLE', 'PayU Colombia'), kind: 'online', requires_link: true, recommended: false },
    { id: getCfg('CO_BANK_TRANSFER_GATEWAY_ID', 'bacs'), title: getCfg('CO_BANK_TRANSFER_GATEWAY_TITLE', 'Transferencia bancaria'), kind: 'manual', requires_link: false, recommended: false }
  ].filter((m) => m.id && m.title);
}
function mergePaymentMethods(wooMethods = [], store) {
  const st = resolveStore(store.id || store);
  const map = new Map();
  for (const g of wooMethods || []) map.set(String(g.id), { ...g, source: 'woocommerce', preset: false });
  const presets = Array.isArray(st.payment_presets) ? st.payment_presets : defaultPaymentPresets(st.id);
  for (const p of presets) {
    const id = String(p.id || '').trim();
    if (!id) continue;
    if (map.has(id)) map.set(id, { ...p, ...map.get(id), title: map.get(id).title || p.title, preset: false, source: 'woocommerce' });
    else map.set(id, { id, title: p.title || id, description: p.description || 'Método sugerido para Colombia. Debe existir/estar activo en WooCommerce para generar links de pago.', enabled: true, preset: true, source: 'preset', kind: p.kind || 'manual', requires_link: Boolean(p.requires_link) });
  }
  return Array.from(map.values());
}


function shippingMethodCost(settings = {}) {
  const candidates = [settings?.cost?.value, settings?.min_amount?.value, settings?.flat_rate_cost?.value];
  for (const raw of candidates) {
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(String(raw).replace(/[^0-9.,-]/g, '').replace(',', '.'));
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}
function normalizeShippingMethod(method = {}, zone = {}) {
  const settings = method.settings || {};
  const title = method.title || settings?.title?.value || method.method_title || method.method_id || 'Metodo de envio';
  return {
    id: String(method.id || method.instance_id || method.method_id || '').trim(),
    instance_id: method.instance_id || method.id || null,
    method_id: method.method_id || method.id || '',
    title,
    method_title: method.method_title || title,
    enabled: method.enabled !== false,
    zone_id: zone.id ?? null,
    zone_name: zone.name || 'General',
    total: shippingMethodCost(settings),
    settings: {
      title: settings?.title?.value || title,
      cost: settings?.cost?.value || '',
      min_amount: settings?.min_amount?.value || ''
    },
    source: 'woocommerce'
  };
}
function defaultShippingFallback(store) {
  const st = resolveStore(store?.id || store);
  const id = st.country === 'CO' ? getCfg('CO_DEFAULT_SHIPPING_METHOD_ID','flat_rate') : getCfg('CL_DEFAULT_SHIPPING_METHOD_ID','flat_rate');
  const title = st.country === 'CO' ? getCfg('CO_DEFAULT_SHIPPING_METHOD_TITLE','Envio Colombia') : getCfg('CL_DEFAULT_SHIPPING_METHOD_TITLE','Despacho a domicilio');
  return [{ id, instance_id:null, method_id:id, title, method_title:title, enabled:true, zone_id:null, zone_name:'Configuracion local', total:0, preset:true, source:'fallback' }];
}

function getCfg(key, fallback = '') { return process.env[key] !== undefined && process.env[key] !== '' ? process.env[key] : fallback; }
function buildDefaultStoreConfig() {
  return {
    cl: { id:'cl', code:'CL', name:getCfg('CL_STORE_NAME','Rivaida Chile'), country:'CL', currency:getCfg('CL_CURRENCY','CLP'), locale:'es-CL', wc_url:String(getCfg('WC_URL','')).replace(/\/$/,''), wc_key:getCfg('WC_KEY',''), wc_secret:getCfg('WC_SECRET',''), document_label:'RUT', document_type:'rut', document_required:getCfg('REQUIRE_RUT','true')!=='false', document_fields:['billing_rut','shipping_rut','_billing_rut','_shipping_rut'], payment_gateway_id:getCfg('WOO_FLOW_GATEWAY_ID','flow'), payment_gateway_title:getCfg('WOO_FLOW_GATEWAY_TITLE','Flow'), postcode_default:getCfg('DEFAULT_POSTCODE','8320000'), state_format:getCfg('CHILE_STATE_FORMAT','name'), chatwoot_labels:['chile','rivaida-cl'] },
    co: { id:'co', code:'CO', name:getCfg('CO_STORE_NAME','Rivaida Colombia'), country:'CO', currency:getCfg('CO_CURRENCY','COP'), locale:'es-CO', wc_url:String(getCfg('CO_WC_URL','')).replace(/\/$/,''), wc_key:getCfg('CO_WC_KEY',''), wc_secret:getCfg('CO_WC_SECRET',''), document_label:getCfg('CO_DOCUMENT_LABEL','CC / NIT'), document_type:'document', document_required:getCfg('CO_REQUIRE_DOCUMENT','true')!=='false', document_fields:['billing_document','shipping_document','billing_cedula','shipping_cedula'], payment_gateway_id:getCfg('CO_WOO_PAYMENT_GATEWAY_ID',getCfg('CO_COD_GATEWAY_ID','cod')), payment_gateway_title:getCfg('CO_WOO_PAYMENT_GATEWAY_TITLE','Contra entrega Colombia'), postcode_default:getCfg('CO_DEFAULT_POSTCODE','110111'), state_format:'code', chatwoot_labels:['colombia','rivaida-co','dropi'], payment_presets: defaultPaymentPresets('co') }
  };
}
function buildStoreConfig() {
  const custom=parseJsonEnv('STORE_CONFIG_JSON',{});
  const merged={...buildDefaultStoreConfig(),...custom};
  Object.keys(merged).forEach((id)=>{ const st=merged[id]||{}; st.id=String(st.id||id).toLowerCase(); st.code=String(st.code||st.country||id).toUpperCase(); st.country=String(st.country||st.code||id).toUpperCase(); st.currency=st.currency||(st.country==='CO'?'COP':'CLP'); st.wc_url=String(st.wc_url||'').replace(/\/$/,''); merged[id]=st; });
  return merged;
}
let STORE_CONFIG = buildStoreConfig();
function currentDefaultStore() { return String(getCfg('DEFAULT_STORE','cl')).toLowerCase(); }
const wcClients = new Map();
function rebuildRuntimeConfig() { STORE_CONFIG = buildStoreConfig(); wcClients.clear(); allowedOrigins = parseAllowedOrigins(); }

function listStores() { return Object.values(STORE_CONFIG).map((s)=>({ id:s.id, code:s.code, name:s.name, country:s.country, currency:s.currency, document_label:s.document_label, document_type:s.document_type, payment_gateway_id:s.payment_gateway_id, payment_presets:s.payment_presets||[], enabled:Boolean(s.wc_url&&s.wc_key&&s.wc_secret) })); }
function resolveStore(input='') { const raw=String(input||'').trim().toLowerCase(); return STORE_CONFIG[raw] || Object.values(STORE_CONFIG).find((s)=>String(s.country||s.code).toLowerCase()===raw) || STORE_CONFIG[currentDefaultStore()] || Object.values(STORE_CONFIG)[0]; }
function storeFromReq(req) { return resolveStore(req.query.store || req.query.country || req.body?.store_id || req.body?.store || req.body?.country || req.headers['x-store-id'] || currentDefaultStore()); }
function missingWooFields(st = {}) {
  const missing = [];
  if (!st.wc_url) missing.push('URL WooCommerce');
  if (!st.wc_key) missing.push('Consumer Key');
  if (!st.wc_secret) missing.push('Consumer Secret');
  return missing;
}
function wcForStore(store) {
  const st = resolveStore(store?.id || store);
  const missing = missingWooFields(st);
  if (missing.length) {
    const e = new Error(`WooCommerce no configurado para tienda ${st?.id || store}. Faltan: ${missing.join(', ')}. Abra Credenciales, complete Woo ${st?.id === 'co' ? 'Colombia' : 'Chile'} y presione Guardar credenciales.`);
    e.status = 400;
    throw e;
  }
  if (!wcClients.has(st.id)) {
    wcClients.set(st.id, axios.create({
      baseURL: `${st.wc_url}/wp-json/wc/v3`,
      auth: { username: st.wc_key, password: st.wc_secret },
      timeout: Number(process.env.WC_TIMEOUT_MS || 30000)
    }));
  }
  return wcClients.get(st.id);
}

const requiredEnv = ['PANEL_USER','PANEL_PASSWORD'];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length) console.warn(`[WARN] Variables faltantes: ${missingEnv.join(', ')}`);

function parseAllowedOrigins() { return (getCfg('ALLOWED_ORIGINS','') || '').split(',').map((x) => x.trim()).filter(Boolean); }
let allowedOrigins = parseAllowedOrigins();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, frameguard: false }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined'));
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Origen no permitido por CORS'));
  },
  credentials: true
}));

const memoryCache = new Map();
const REDIS_URL = process.env.REDIS_URL || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const redis = REDIS_URL ? new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true }) : null;
const pgPool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, max: Number(process.env.PG_POOL_MAX || 5) }) : null;
let dbReady = false;
let redisReady = false;
let syncJob = { running: false, startedAt: null, finishedAt: null, page: 0, total: 0, indexed: 0, error: null };

if (redis) redis.connect().then(() => { redisReady = true; console.log('[Redis] conectado'); }).catch((e) => console.warn('[Redis] no conectado:', e.message));

function safeCompare(a = '', b = '') {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}
function normalizeText(value = '') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}
function removeDiacritics(value = '') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function normalizeRegionForAli(value = '') {
  let s = removeDiacritics(value).replace(/\bRegi[oó]n\b/gi, '').replace(/\s+/g, ' ').trim();
  if (/metropolitana/i.test(s)) return 'Metropolitana de Santiago';
  return s;
}
function hashKey(value) { return crypto.createHash('sha1').update(String(value)).digest('hex'); }
async function cacheGet(key) {
  if (redisReady) {
    try { const raw = await redis.get(key); if (raw) return JSON.parse(raw); } catch (e) { console.warn('[Redis get]', e.message); }
  }
  const item = memoryCache.get(key);
  if (!item || item.expiresAt < Date.now()) { memoryCache.delete(key); return null; }
  return item.value;
}
async function cacheSet(key, value, ttlSeconds = CACHE_TTL_SECONDS) {
  if (redisReady) {
    try { await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds); } catch (e) { console.warn('[Redis set]', e.message); }
  }
  memoryCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000, createdAt: Date.now() });
  return value;
}
async function cacheDelPrefix(prefix) {
  for (const key of Array.from(memoryCache.keys())) if (key.startsWith(prefix)) memoryCache.delete(key);
  if (redisReady) {
    try {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
        cursor = next;
        if (keys.length) await redis.del(keys);
      } while (cursor !== '0');
    } catch (e) { console.warn('[Redis del]', e.message); }
  }
}
async function remember(key, ttlSeconds, factory, force = false) {
  if (!force) { const cached = await cacheGet(key); if (cached) return { value: cached, cached: true }; }
  const value = await factory();
  await cacheSet(key, value, ttlSeconds);
  return { value, cached: false };
}
function publicHealth(req, res) {
  res.json({ ok: true, service: 'chatwoot-woocommerce-flow-panel-v8.3.5-country-auto-ui', port: PORT, redis: redisReady, postgres: dbReady, cache_items: memoryCache.size, sync: syncJob.running ? 'running' : 'idle' });
}
app.get('/health', publicHealth);
app.get('/favicon.ico', (req, res) => res.status(204).end());

function authOkByBasic(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const [user, ...rest] = decoded.split(':');
    const pass = rest.join(':');
    return safeCompare(user, process.env.PANEL_USER || '') && safeCompare(pass, process.env.PANEL_PASSWORD || '');
  } catch (_) { return false; }
}
function authOkByToken(req) {
  const configured = process.env.PANEL_APP_TOKEN || process.env.APP_PANEL_TOKEN || '';
  if (!configured) return false;
  const incoming = req.headers['x-panel-token'] || req.query.panel_token || req.query.token || '';
  return safeCompare(String(incoming), configured);
}
function authMiddleware(req, res, next) {
  if (authOkByToken(req) || authOkByBasic(req)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Chatwoot WooCommerce Panel"');
  return res.status(401).json({ error: 'Credenciales requeridas' });
}

function chatwootClient() {
  const chatwootUrl = String(getCfg('CHATWOOT_URL','')).replace(/\/$/,'');
  const apiKey = getCfg('CHATWOOT_API_KEY','');
  const accountId = getCfg('CHATWOOT_ACCOUNT_ID','');
  if (!chatwootUrl || !apiKey || !accountId) return null;
  return axios.create({
    baseURL: `${chatwootUrl}/api/v1/accounts/${accountId}`,
    headers: { api_access_token: apiKey, 'Content-Type': 'application/json' },
    timeout: 20000
  });
}
function formatWooError(error) {
  const data = error.response?.data;
  return data?.message || data?.error || error.message || 'Error inesperado';
}

function getOrderPayUrl(order = {}, store = null) {
  const direct = order.payment_url || order.checkout_payment_url || order.pay_url || '';
  if (direct) return direct;
  const st = store ? resolveStore(store.id || store) : resolveStore(currentDefaultStore());
  const key = order.order_key || order.orderKey || '';
  if (st?.wc_url && order.id && key) return `${st.wc_url}/checkout/order-pay/${order.id}/?pay_for_order=true&key=${encodeURIComponent(key)}`;
  return '';
}

function preferredWooPaymentGateway(body = {}, store = null) {
  const st = store ? resolveStore(store.id || store) : resolveStore(currentDefaultStore());
  return body.gateway_id || body.payment_method || st.payment_gateway_id || process.env.WOO_FLOW_GATEWAY_ID || process.env.WOO_PAYMENT_GATEWAY_ID || 'flow';
}

function loadJsonFile(relativePath, fallback = []) {
  const filePath = path.join(__dirname, relativePath);
  if (!fs.existsSync(filePath)) return fallback;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) { console.warn('[data json]', relativePath, e.message); return fallback; }
}
function loadRegionesChile() { return loadJsonFile(path.join('data', 'regiones-comunas-chile.json')); }
function loadRegionesColombia() { return loadJsonFile(path.join('data', 'regiones-comunas-colombia-dropi.json')); }
function loadComunasChileCsv() {
  const csvPath = path.join(__dirname, 'data', 'starter-comunas-chile.csv');
  if (!fs.existsSync(csvPath)) return [];
  const rows = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).slice(1).filter(Boolean);
  return rows.map((line) => {
    const [comuna, postcode] = line.split(',');
    return { comuna: (comuna || '').trim(), postcode: (postcode || '').trim() };
  }).filter((x) => x.comuna && x.postcode);
}
const chilePostcodeMap = new Map(loadComunasChileCsv().map((x) => [normalizeText(x.comuna), x.postcode]));
const CO_DEPT_DEFAULT_POSTCODES = {
  AMZ:'910001', ANT:'050001', ARU:'810001', ATL:'080001', BOL:'130001', BOY:'150001', CAL:'170001', CAQ:'180001', CAS:'850001', CAU:'190001', CES:'200001', CHOC:'270001', COR:'230001', CUN:'250001', GUA:'940001', GUV:'950001', HUI:'410001', GUJ:'440001', MAG:'470001', MET:'500001', NAR:'520001', NSA:'540001', PUT:'860001', QUI:'630001', RIS:'660001', SAP:'880001', SAN:'680001', SUC:'700001', TOL:'730001', VAC:'760001', VAU:'970001', VID:'990001', DC:'110111'
};
const CO_CITY_POSTCODES = new Map(Object.entries({
  'bogota':'110111','bogota dc':'110111','bogota d.c.':'110111','medellin':'050001','bello':'051050','itagui':'055410','envigado':'055420','barranquilla':'080001','cartagena':'130001','cali':'760001','palmira':'763531','bucaramanga':'680001','floridablanca':'681001','girón':'687541','giron':'687541','piedecuesta':'681011','pereira':'660001','dosquebradas':'661001','manizales':'170001','armenia':'630001','ibague':'730001','neiva':'410001','villavicencio':'500001','cucuta':'540001','pastо':'520001','pasto':'520001','monteria':'230001','sincelejo':'700001','valledupar':'200001','santa marta':'470001','riohacha':'440001','tunja':'150001','popayan':'190001','yopal':'850001','leticia':'910001','quibdo':'270001','mocoa':'860001','arauca':'810001','florencia':'180001','san andres':'880001','mitu':'970001','puerto carreño':'990001','puerto carreno':'990001','inirida':'940001','san jose del guaviare':'950001'
}).map(([k,v]) => [normalizeText(k), v]));
function getChilePostcode(comuna, fallback = '8320000') { return chilePostcodeMap.get(normalizeText(comuna)) || fallback || '8320000'; }
function getColombiaPostcode(city = '', deptCode = '', fallback = '110111') {
  const cityCode = CO_CITY_POSTCODES.get(normalizeText(city));
  if (cityCode) return cityCode;
  const dept = String(deptCode || '').toUpperCase();
  return CO_DEPT_DEFAULT_POSTCODES[dept] || fallback || '110111';
}
const regionesChile = loadRegionesChile().map((r) => ({
  ...r,
  country: 'CL',
  region_original: r.region,
  region: normalizeRegionForAli(r.region),
  comunas: (r.comunas || []).map((nombre) => ({ comuna: nombre, city: nombre, postcode: getChilePostcode(nombre, process.env.DEFAULT_POSTCODE || '8320000') }))
}));
const regionesColombia = loadRegionesColombia().map((r) => ({
  codigo: r.codigo,
  country: 'CO',
  region_original: r.region,
  region: removeDiacritics(r.region || ''),
  comunas: (r.comunas || []).map((nombre) => ({ comuna: nombre, city: nombre, postcode: getColombiaPostcode(nombre, r.codigo, process.env.CO_DEFAULT_POSTCODE || '110111') }))
}));
function mapsForRegions(regions) {
  const byCity = new Map(); const byCode = new Map(); const byName = new Map();
  for (const region of regions) {
    byCode.set(String(region.codigo || '').toUpperCase(), region);
    byName.set(normalizeText(region.region || ''), region);
    byName.set(normalizeText(region.region_original || ''), region);
    for (const c of region.comunas || []) byCity.set(normalizeText(c.comuna || c.city || ''), { codigo: region.codigo, region: region.region, region_original: region.region_original, postcode: c.postcode });
  }
  return { byCity, byCode, byName };
}
const regionMaps = { CL: mapsForRegions(regionesChile), CO: mapsForRegions(regionesColombia) };
// Compatibilidad histórica para partes antiguas del código.
const regiones = regionesChile;
const comunas = regionesChile.flatMap((r) => r.comunas || []);
const comunaMap = chilePostcodeMap;
const comunaRegionMap = regionMaps.CL.byCity;
const regionMapByCode = regionMaps.CL.byCode;
const regionMapByName = regionMaps.CL.byName;
function getCountryRegions(country = 'CL') { return String(country).toUpperCase() === 'CO' ? regionesColombia : regionesChile; }
function getCountryPostcode(country = 'CL', city = '', fallback = '') {
  const c = String(country || 'CL').toUpperCase();
  if (c === 'CO') {
    const info = resolveRegionInfoCountry('', city, 'CO');
    return getColombiaPostcode(city, info.codigo, fallback || process.env.CO_DEFAULT_POSTCODE || '110111');
  }
  return getChilePostcode(city, fallback || process.env.DEFAULT_POSTCODE || '8320000');
}
function resolveRegionInfoCountry(regionInput = '', city = '', country = 'CL') {
  const c = String(country || 'CL').toUpperCase();
  const maps = regionMaps[c] || regionMaps.CL;
  const raw = String(regionInput || '').trim();
  const codeCandidate = raw.toUpperCase();
  if (codeCandidate && maps.byCode.has(codeCandidate)) {
    const r = maps.byCode.get(codeCandidate);
    return { codigo: r.codigo, region: r.region, region_original: r.region_original };
  }
  const byName = maps.byName.get(normalizeText(raw));
  if (byName) return { codigo: byName.codigo, region: byName.region, region_original: byName.region_original };
  const byCity = maps.byCity.get(normalizeText(city || ''));
  if (byCity) return byCity;
  return { codigo: raw || (c === 'CO' ? 'DC' : ''), region: raw || (c === 'CO' ? 'Bogota D.C.' : '') };
}
function resolveRegionInfo(regionInput = '', comuna = '') { return resolveRegionInfoCountry(regionInput, comuna, 'CL'); }
function regionStateValue(info, store = null) {
  const st = store ? resolveStore(store.id || store) : resolveStore(currentDefaultStore());
  if (st.country === 'CO') return info.codigo || '';
  if (st.state_format === 'code' || process.env.CHILE_STATE_FORMAT === 'code') return info.codigo || '';
  return normalizeRegionForAli(info.region || info.codigo || '');
}


const CONFIG_KEYS = [
  'PUBLIC_BASE_URL','ALLOWED_ORIGINS','PANEL_APP_TOKEN','DEFAULT_STORE',
  'WC_URL','WC_KEY','WC_SECRET','WOO_FLOW_GATEWAY_ID','WOO_FLOW_GATEWAY_TITLE',
  'CO_WC_URL','CO_WC_KEY','CO_WC_SECRET','CO_STORE_NAME','CO_WOO_PAYMENT_GATEWAY_ID','CO_WOO_PAYMENT_GATEWAY_TITLE',
  'CO_COD_GATEWAY_ID','CO_COD_GATEWAY_TITLE','CO_WOMPI_GATEWAY_ID','CO_WOMPI_GATEWAY_TITLE','CO_BOLD_GATEWAY_ID','CO_BOLD_GATEWAY_TITLE','CO_PSE_GATEWAY_ID','CO_PSE_GATEWAY_TITLE','CO_MERCADO_PAGO_GATEWAY_ID','CO_MERCADO_PAGO_GATEWAY_TITLE','CO_EPAYCO_GATEWAY_ID','CO_EPAYCO_GATEWAY_TITLE','CO_PAYU_GATEWAY_ID','CO_PAYU_GATEWAY_TITLE','CO_BANK_TRANSFER_GATEWAY_ID','CO_BANK_TRANSFER_GATEWAY_TITLE','CO_PAYMENT_METHOD_PRESETS_JSON','CL_DEFAULT_SHIPPING_METHOD_ID','CL_DEFAULT_SHIPPING_METHOD_TITLE','CO_DEFAULT_SHIPPING_METHOD_ID','CO_DEFAULT_SHIPPING_METHOD_TITLE',
  'CHATWOOT_URL','CHATWOOT_API_KEY','CHATWOOT_ACCOUNT_ID',
  'PAYMENT_LINK_PROVIDER','FLOW_API_URL','FLOW_API_KEY','FLOW_SECRET_KEY','FLOW_URL_CONFIRMATION','FLOW_URL_RETURN','AI_RECOMMENDATION_WEBHOOK_URL',
  'CACHE_TTL_SECONDS','PRODUCT_PAGE_SIZE','MAX_PAGE_SIZE','SYNC_PER_PAGE','VARIATION_CACHE_SECONDS','CHATWOOT_SEND_IMAGE_ATTACHMENT','CHATWOOT_INBOX_STORE_MAP','CL_CHATWOOT_INBOX_IDS','CO_CHATWOOT_INBOX_IDS','AUTO_STORE_BY_PHONE','AI_PROVIDER','OPENAI_API_KEY','OPENAI_MODEL','DEEPSEEK_API_KEY','DEEPSEEK_MODEL','GEMINI_API_KEY','GEMINI_MODEL','GLOBAL_AI_PROMPT','CL_AI_PROMPT','CO_AI_PROMPT','AI_TIMEOUT_MS'
];
async function ensureAppSettingsTable() {
  if (!pgPool) return false;
  await pgPool.query(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ DEFAULT now()
  )`);
  return true;
}
async function loadAppSettingsFromDb() {
  if (!pgPool) return;
  try {
    await ensureAppSettingsTable();
    const { rows } = await pgPool.query('SELECT key,value FROM app_settings');
    for (const row of rows) process.env[row.key] = row.value;
    rebuildRuntimeConfig();
  } catch (e) { console.warn('[Settings load]', e.message); }
}
async function saveAppSettingsToDb(settings = {}) {
  if (!pgPool || !dbReady) return false;
  await ensureAppSettingsTable();
  const entries = Object.entries(settings).filter(([key]) => CONFIG_KEYS.includes(key));
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    for (const [key, value] of entries) {
      await client.query('INSERT INTO app_settings(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()', [key, String(value ?? '')]);
    }
    await client.query('COMMIT');
    return true;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
function readRuntimeSettings() {
  const out = {};
  for (const key of CONFIG_KEYS) out[key] = process.env[key] || '';
  return out;
}
async function testWooStore(storeId) {
  const st = resolveStore(storeId);
  const wc = wcForStore(st);
  const { data } = await wc.get('/system_status');
  return { ok:true, store: st.id, name: st.name, url: st.wc_url, currency: st.currency, environment: data?.environment?.home_url || st.wc_url };
}
async function testChatwootConnection() {
  const client = chatwootClient();
  if (!client) { const e = new Error('Faltan credenciales Chatwoot'); e.status=400; throw e; }
  const { data } = await client.get('/inboxes');
  return { ok:true, inboxes: Array.isArray(data?.payload) ? data.payload.length : (Array.isArray(data) ? data.length : 0) };
}

async function initDb() {
  if (!pgPool) return false;
  try {
    await pgPool.query(`CREATE TABLE IF NOT EXISTS product_index (
      store_id TEXT NOT NULL DEFAULT 'cl',
      id BIGINT NOT NULL,
      type TEXT, nombre TEXT, sku TEXT, precio NUMERIC, precio_regular NUMERIC, precio_oferta NUMERIC,
      stock INTEGER, stock_status TEXT, imagen TEXT, permalink TEXT,
      categorias TEXT[], etiquetas TEXT[], variation_count INTEGER DEFAULT 0,
      search_text TEXT, payload JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (store_id, id)
    )`);
    await pgPool.query(`ALTER TABLE product_index ADD COLUMN IF NOT EXISTS store_id TEXT NOT NULL DEFAULT 'cl'`);
    try {
      await pgPool.query(`ALTER TABLE product_index DROP CONSTRAINT IF EXISTS product_index_pkey`);
      await pgPool.query(`ALTER TABLE product_index ADD PRIMARY KEY (store_id, id)`);
    } catch (e) { console.warn('[Postgres migrate product_index]', e.message); }
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_product_index_store ON product_index (store_id)`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_product_index_search_text ON product_index (store_id, search_text)`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_product_index_sku ON product_index (sku)`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_product_index_categories ON product_index USING gin(categorias)`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_product_index_sale ON product_index (precio_oferta)`);
    await ensureAppSettingsTable();
    dbReady = true;
    await loadAppSettingsFromDb();
    console.log('[Postgres] indice de productos y configuracion listo');
    return true;
  } catch (e) { console.warn('[Postgres] no disponible:', e.message); return false; }
}
initDb();
async function productIndexCount(store = currentDefaultStore()) {
  if (!pgPool || !dbReady) return 0;
  try { const st = resolveStore(store); const { rows } = await pgPool.query('SELECT COUNT(*)::int AS count FROM product_index WHERE store_id=$1', [st.id]); return Number(rows[0]?.count || 0); } catch { return 0; }
}
function extractMeta(metaData = []) {
  const result = {};
  for (const m of metaData || []) {
    const key = String(m.key || '').toLowerCase();
    if (key.includes('alids') || key.includes('alidropship') || key.includes('ali') || key.includes('rut') || key.includes('tracking') || key.includes('supplier')) result[m.key] = m.value;
  }
  return result;
}
function cleanHtml(s='') { return String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(); }
function isNoisyAttributeName(name='') {
  const n = normalizeText(name);
  const noisy = ['size_info','sizelist','shipping','logistics','product chemical','producto quimico','origen','cn','fujian','lugar aplicable','numero de modelo','model','department','departamento'];
  return noisy.some(x => n.includes(x));
}
function normalizeProduct(product, variations = null, store = null) {
  const st = store ? resolveStore(store.id || store) : resolveStore(currentDefaultStore());
  const attrs = (product.attributes || []).filter(a => a && a.name && !isNoisyAttributeName(a.name)).map((a) => ({ id: a.id, name: a.name, options: Array.isArray(a.options) ? a.options.slice(0, 30) : [], variation: a.variation }));
  return {
    id: product.id,
    type: product.type,
    nombre: product.name,
    descripcion_corta: cleanHtml(product.short_description),
    sku: product.sku || 'Sin SKU',
    precio: product.price || product.regular_price || '0',
    precio_regular: product.regular_price || '',
    precio_oferta: product.sale_price || '',
    en_oferta: Boolean(product.on_sale || Number(product.sale_price || 0) > 0),
    moneda: st.currency || 'CLP',
    store_id: st.id,
    country: st.country,
    stock: product.stock_quantity,
    stock_status: product.stock_status,
    manage_stock: product.manage_stock,
    imagen: product.images?.[0]?.src || '',
    imagenes: product.images?.slice(0, 6).map((img) => ({ id: img.id, src: img.src, alt: img.alt })) || [],
    permalink: product.permalink,
    categorias: product.categories?.map((c) => c.name) || [],
    etiquetas: product.tags?.map((t) => t.name) || [],
    atributos: attrs,
    variation_count: Array.isArray(product.variations) ? product.variations.length : 0,
    meta: extractMeta(product.meta_data),
    variations: Array.isArray(variations) ? variations : undefined
  };
}
function normalizeVariation(v) {
  return {
    id: v.id,
    sku: v.sku || '',
    precio: v.price || v.regular_price || '0',
    precio_regular: v.regular_price || '',
    precio_oferta: v.sale_price || '',
    en_oferta: Boolean(v.on_sale || Number(v.sale_price || 0) > 0),
    stock: v.stock_quantity,
    stock_status: v.stock_status,
    manage_stock: v.manage_stock,
    imagen: v.image?.src || '',
    atributos: (v.attributes || []).filter(a => a && a.name && a.option && !isNoisyAttributeName(a.name)).map((a) => ({ name: a.name, option: a.option })),
    meta: extractMeta(v.meta_data)
  };
}
function productSearchText(p) {
  return normalizeText([p.nombre, p.sku, ...(p.categorias || []), ...(p.etiquetas || []), ...(p.atributos || []).map(a => `${a.name} ${(a.options || []).join(' ')}`)].join(' '));
}
async function upsertProductsIndex(products=[]) {
  if (!pgPool || !dbReady || !products.length) return;
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    for (const p of products) {
      const searchText = productSearchText(p);
      await client.query(`INSERT INTO product_index (store_id,id,type,nombre,sku,precio,precio_regular,precio_oferta,stock,stock_status,imagen,permalink,categorias,etiquetas,variation_count,search_text,payload,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now())
        ON CONFLICT (store_id,id) DO UPDATE SET type=EXCLUDED.type,nombre=EXCLUDED.nombre,sku=EXCLUDED.sku,precio=EXCLUDED.precio,precio_regular=EXCLUDED.precio_regular,precio_oferta=EXCLUDED.precio_oferta,stock=EXCLUDED.stock,stock_status=EXCLUDED.stock_status,imagen=EXCLUDED.imagen,permalink=EXCLUDED.permalink,categorias=EXCLUDED.categorias,etiquetas=EXCLUDED.etiquetas,variation_count=EXCLUDED.variation_count,search_text=EXCLUDED.search_text,payload=EXCLUDED.payload,updated_at=now()`,
        [p.store_id || p.store || 'cl',p.id,p.type,p.nombre,p.sku,Number(p.precio||0),Number(p.precio_regular||0),Number(p.precio_oferta||0),p.stock,p.stock_status,p.imagen,p.permalink,p.categorias||[],p.etiquetas||[],Number(p.variation_count || 0),searchText,JSON.stringify(p)]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); console.warn('[Postgres upsert]', e.message); }
  finally { client.release(); }
}
async function searchProductsIndex({ q='', category='', sale=false, stock='', limit=PRODUCT_PAGE_SIZE, offset=0 } = {}, store = currentDefaultStore()) {
  if (!pgPool || !dbReady) return null;
  const st = resolveStore(store);
  if (await productIndexCount(st.id) === 0) return null;
  const clauses=['store_id = $1']; const values=[st.id];
  if (q) { values.push(`%${normalizeText(q)}%`); clauses.push(`search_text ILIKE $${values.length}`); }
  if (category) { values.push(category); clauses.push(`$${values.length} = ANY(categorias)`); }
  if (sale) clauses.push(`(COALESCE(precio_oferta,0) > 0 OR payload->>'en_oferta' = 'true')`);
  if (stock === 'instock') clauses.push(`stock_status = 'instock'`);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  values.push(Number(limit)); const limitIdx=values.length; values.push(Number(offset)); const offsetIdx=values.length;
  const { rows } = await pgPool.query(`SELECT payload, count(*) OVER() AS total FROM product_index ${where} ORDER BY CASE WHEN stock_status = 'instock' THEN 0 ELSE 1 END, nombre ASC LIMIT $${limitIdx} OFFSET $${offsetIdx}`, values);
  return { productos: rows.map(r => r.payload), total: Number(rows[0]?.total || 0), source: 'postgres' };
}
async function getVariations(productId, store = resolveStore(currentDefaultStore()), force=false) {
  const st = resolveStore(store.id || store);
  const wc = wcForStore(st);
  const key = `variations:${st.id}:${productId}`;
  return (await remember(key, Number(process.env.VARIATION_CACHE_SECONDS || 3600), async () => {
    const variations = [];
    let page = 1;
    while (true) {
      const { data } = await wc.get(`/products/${productId}/variations`, { params: { per_page: 100, page } });
      variations.push(...data.map(normalizeVariation));
      if (data.length < 100) break;
      page += 1;
    }
    return variations;
  }, force)).value;
}
async function buildProductsPage({ q='', limit=PRODUCT_PAGE_SIZE, offset=0 } = {}, store = resolveStore(currentDefaultStore())) {
  const st = resolveStore(store.id || store);
  const wc = wcForStore(st);
  const page = Math.floor(Number(offset || 0) / Number(limit || PRODUCT_PAGE_SIZE)) + 1;
  const params = { per_page: Math.min(Number(limit || PRODUCT_PAGE_SIZE), 100), page, status: 'publish' };
  if (q) params.search = q;
  const response = await wc.get('/products', { params });
  const total = Number(response.headers['x-wp-total'] || 0);
  const normalized = response.data.map((p) => normalizeProduct(p, null, st)).sort((a,b)=>((b.stock_status === 'instock') - (a.stock_status === 'instock')) || String(a.nombre).localeCompare(String(b.nombre),'es'));
  upsertProductsIndex(normalized).catch((e) => console.warn('[index async]', e.message));
  return { productos: normalized, total: total || (Number(offset) + normalized.length + (normalized.length === Number(limit) ? 1 : 0)), source: 'woocommerce_page' };
}
function filterProductsLocal(products, { q='', category='', sale=false, stock='', limit=PRODUCT_PAGE_SIZE, offset=0 } = {}) {
  const nq = normalizeText(q);
  let filtered = products.filter(p => {
    if (category && !(p.categorias || []).includes(category)) return false;
    if (sale && !p.en_oferta && !Number(p.precio_oferta || 0)) return false;
    if (stock === 'instock' && p.stock_status !== 'instock') return false;
    if (!nq) return true;
    return productSearchText(p).includes(nq);
  });
  const total = filtered.length;
  return { productos: filtered.slice(Number(offset), Number(offset)+Number(limit)), total, source: 'memory' };
}
async function runCatalogSync(store = resolveStore(currentDefaultStore())) {
  const st = resolveStore(store.id || store);
  const wc = wcForStore(st);
  if (syncJob.running) return;
  syncJob = { running: true, startedAt: new Date().toISOString(), finishedAt: null, page: 0, total: 0, indexed: 0, error: null };
  try {
    await cacheDelPrefix('productos:');
    let page = 1;
    const perPage = Number(process.env.SYNC_PER_PAGE || 50);
    while (true) {
      syncJob.page = page;
      const response = await wc.get('/products', { params: { per_page: perPage, page, status: 'publish' } });
      const products = response.data.map((p) => normalizeProduct(p, null, st));
      syncJob.store = st.id;
      syncJob.total = Number(response.headers['x-wp-total'] || syncJob.total || 0);
      await upsertProductsIndex(products);
      syncJob.indexed += products.length;
      if (products.length < perPage) break;
      page += 1;
    }
    syncJob.finishedAt = new Date().toISOString();
  } catch (e) {
    syncJob.error = e.message;
    syncJob.finishedAt = new Date().toISOString();
  } finally {
    syncJob.running = false;
  }
}

function validateRut(rut = '') {
  const clean = String(rut).replace(/\./g, '').replace(/-/g, '').trim().toUpperCase();
  if (!/^[0-9]+[0-9K]$/.test(clean)) return false;
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  let sum = 0, multiplier = 2;
  for (let i = body.length - 1; i >= 0; i -= 1) { sum += Number(body[i]) * multiplier; multiplier = multiplier === 7 ? 2 : multiplier + 1; }
  const expectedNum = 11 - (sum % 11);
  const expected = expectedNum === 11 ? '0' : expectedNum === 10 ? 'K' : String(expectedNum);
  return dv === expected;
}
function formatRut(rut = '') {
  const clean = String(rut).replace(/\./g, '').replace(/-/g, '').trim().toUpperCase();
  if (clean.length < 2) return rut;
  return `${clean.slice(0, -1).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}-${clean.slice(-1)}`;
}
function flowSign(params) {
  const toSign = Object.keys(params).sort().map((key) => `${key}${params[key]}`).join('');
  return crypto.createHmac('sha256', process.env.FLOW_SECRET_KEY || '').update(toSign).digest('hex');
}
function buildFlowPayload(params) { const p = { ...params }; p.s = flowSign(p); return new URLSearchParams(p).toString(); }
function normalizeDocument(value = '') { return String(value || '').replace(/[.\-\s]/g, '').trim().toUpperCase(); }
function buildDocumentMeta(documentValue, store) {
  const st = resolveStore(store.id || store);
  if (!documentValue) return [];
  const formatted = st.document_type === 'rut' ? formatRut(documentValue) : String(documentValue).trim();
  const fields = Array.isArray(st.document_fields) && st.document_fields.length ? st.document_fields : (st.country === 'CL' ? ['billing_rut','shipping_rut'] : ['billing_document','shipping_document']);
  return fields.map((key) => ({ key, value: formatted }));
}
function normalizeCheckout(body, store = resolveStore(currentDefaultStore())) {
  const st = resolveStore(store.id || store);
  const documentValue = String(body.document || body.rut || body.billing?.rut || body.billing?.document || getMetaValue(body.meta_data, RUT_META_KEYS) || '').trim();
  if (st.document_required !== false && st.document_type === 'rut' && !validateRut(documentValue)) { const e = new Error('RUT chileno invalido o faltante'); e.status = 400; throw e; }
  if (st.document_required !== false && st.document_type !== 'rut' && !normalizeDocument(documentValue)) { const e = new Error(`${st.document_label || 'Documento'} faltante`); e.status = 400; throw e; }
  const billing = { ...(body.billing || {}) };
  const shipping = { ...(body.shipping || billing) };
  const ciudad = body.comuna || body.city || billing.city || shipping.city;
  const postcode = body.postcode || getCountryPostcode(st.country, ciudad, st.postcode_default);
  const regionInfo = resolveRegionInfoCountry(body.region_nombre || body.region || body.region_codigo || billing.state || shipping.state, ciudad, st.country);
  const stateValue = regionStateValue(regionInfo, st);
  billing.country = st.country; shipping.country = st.country;
  billing.state = stateValue; shipping.state = stateValue;
  billing.postcode = postcode; shipping.postcode = postcode;
  billing.city = ciudad || billing.city; shipping.city = ciudad || shipping.city;
  const safeIncomingMeta = (body.meta_data || []).filter((m)=>['_chatwoot_conversation_id','chatwoot_conversation_id','rivaida_store','rivaida_country'].includes(normalizeText(m?.key||'')));
  const metaData = mergeMetaData([...safeIncomingMeta,{key:'rivaida_store',value:st.id},{key:'rivaida_country',value:st.country},...buildDocumentMeta(documentValue, st)]);
  return { payment_method: body.payment_method || st.payment_gateway_id || process.env.WOO_FLOW_GATEWAY_ID || 'flow', payment_method_title: body.payment_method_title || st.payment_gateway_title || process.env.WOO_FLOW_GATEWAY_TITLE || 'Pago WooCommerce', set_paid:false, status:body.status||'pending', billing, shipping, line_items:(body.line_items||[]).map((i)=>({ product_id:Number(i.product_id), variation_id:i.variation_id?Number(i.variation_id):undefined, quantity:Number(i.quantity) })), shipping_lines:body.shipping_lines||[], coupon_lines:(body.coupon_lines||body.coupons||[]).filter(Boolean).map((c)=>({ code:String(c.code||c).trim() })), customer_note:body.customer_note||'', meta_data:metaData };
}
async function validateStock(lineItems = [], store = resolveStore(currentDefaultStore())) {
  const wc = wcForStore(store);
  if (!Array.isArray(lineItems) || !lineItems.length) { const e = new Error('Debe incluir al menos un producto'); e.status = 400; throw e; }
  for (const item of lineItems) {
    const productId = Number(item.product_id);
    const variationId = Number(item.variation_id || 0);
    const qty = Number(item.quantity || 0);
    if (!productId || qty <= 0) { const e = new Error('Producto o cantidad invalida'); e.status = 400; throw e; }
    const endpoint = variationId ? `/products/${productId}/variations/${variationId}` : `/products/${productId}`;
    const { data: product } = await wc.get(endpoint);
    if (product.stock_status !== 'instock') { const e = new Error(`Sin stock disponible para ${product.name || 'variacion'}`); e.status = 409; throw e; }
    if (product.manage_stock && product.stock_quantity !== null && qty > Number(product.stock_quantity)) { const e = new Error(`Stock insuficiente. Disponible: ${product.stock_quantity}`); e.status = 409; throw e; }
  }
}


function countryPrompt(country = 'CL') {
  const globalPrompt = getCfg('GLOBAL_AI_PROMPT', 'Actua como asesor comercial experto para ecommerce, WooCommerce y atencion por WhatsApp. Debes ayudar al agente a cerrar la venta de forma clara, honesta y sin prometer stock o despacho que no este confirmado.');
  const clPrompt = getCfg('CL_AI_PROMPT', 'Chile: validar RUT antes de crear pedido, usar comuna/region y codigo postal, recomendar link de pago WooCommerce con Flow cuando el pedido este confirmado. Mantener tono cordial chileno, precios en CLP y despacho segun metodos Woo disponibles.');
  const coPrompt = getCfg('CO_AI_PROMPT', 'Colombia: validar documento CC/NIT, departamento/ciudad Dropi, telefono y direccion completa. Considerar contra entrega, Wompi, Bold, PSE u otros metodos Woo disponibles. Precios en COP y datos listos para copiar a Dropi.');
  return [globalPrompt, String(country).toUpperCase() === 'CO' ? coPrompt : clPrompt].filter(Boolean).join('\n');
}
function normalizeLabelPart(value = '') { return normalizeText(value).replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'').slice(0,32); }
function buildRecommendations(payload = {}) {
  const cliente = payload.cliente || {};
  const pedidos = Array.isArray(payload.pedidos) ? payload.pedidos : [];
  const cart = Array.isArray(payload.cart) ? payload.cart : [];
  const country = String(payload.country || payload.store_country || '').toUpperCase() === 'CO' || String(payload.store || '').toLowerCase() === 'co' ? 'CO' : 'CL';
  const st = resolveStore(country === 'CO' ? 'co' : 'cl');
  const documentValue = String(payload.rut || payload.document || cliente.rut || cliente.document || '').trim();
  const comuna = String(payload.comuna || payload.city || cliente.direccion?.city || '').trim();
  const region = String(payload.region || payload.state || cliente.direccion?.region_codigo || cliente.direccion?.state || '').trim();
  const email = String(payload.email || cliente.email || '').trim();
  const payment = payload.payment || {};
  const shipping = payload.shipping || {};
  const availablePayments = Array.isArray(payload.payment_methods) ? payload.payment_methods : [];
  const availableShipping = Array.isArray(payload.shipping_methods) ? payload.shipping_methods : [];
  const labels = new Set(['panel_chatwoot', 'woo_panel', country === 'CO' ? 'pais_colombia' : 'pais_chile']);
  const reasons = [];
  const next = [];
  if (country === 'CL') {
    if (documentValue && validateRut(documentValue)) { labels.add('rut_validado'); reasons.push('RUT validado correctamente para Chile.'); }
    else { labels.add('rut_pendiente'); reasons.push('Falta solicitar o validar RUT antes de crear el pedido chileno.'); next.push('Solicitar RUT valido'); }
  } else {
    if (documentValue) { labels.add('documento_colombia_ok'); reasons.push('Documento colombiano informado para Dropi/WooCommerce.'); }
    else { labels.add('documento_colombia_pendiente'); reasons.push('Falta documento CC/NIT para la venta en Colombia.'); next.push('Solicitar CC/NIT'); }
  }
  if (comuna) { labels.add(`${country === 'CO' ? 'ciudad' : 'comuna'}_${normalizeLabelPart(comuna)}`); reasons.push(`${country === 'CO' ? 'Ciudad' : 'Comuna'} detectada: ${comuna}.`); }
  else next.push(country === 'CO' ? 'Solicitar ciudad de envio' : 'Solicitar comuna de despacho');
  if (region) { labels.add(`${country === 'CO' ? 'departamento' : 'region'}_${normalizeLabelPart(region)}`); }
  if (cart.length) { labels.add('carrito_activo'); reasons.push(`${cart.length} item(s) en carrito.`); next.push('Crear pedido desde el carrito'); }
  else next.push('Agregar producto recomendado al carrito');
  if (pedidos.length) { labels.add('cliente_recurrente'); reasons.push('Cliente con historial de pedidos en WooCommerce.'); }
  else labels.add('cliente_nuevo');
  const totalCart = cart.reduce((sum, item) => sum + Number(item?.variation?.precio || item?.product?.precio || 0) * Number(item?.quantity || 1), 0);
  if (totalCart >= (country === 'CO' ? 180000 : 50000)) labels.add('ticket_alto');
  const selectedPaymentTitle = payment.title || payment.method_title || payment.method_id || '';
  if (selectedPaymentTitle) reasons.push(`Metodo de pago seleccionado: ${selectedPaymentTitle}.`);
  if (shipping?.method_title || shipping?.title) {
    const isFree = Number(shipping.total || 0) === 0 || /gratis|free/i.test(`${shipping.method_title || shipping.title}`);
    reasons.push(`Envio seleccionado: ${shipping.method_title || shipping.title}${isFree ? ' (gratis)' : ''}.`);
    if (isFree) labels.add('envio_gratis');
  }
  if (availablePayments.length) reasons.push(`Metodos de pago Woo disponibles: ${availablePayments.map(m=>m.title||m.id).filter(Boolean).slice(0,5).join(', ')}.`);
  if (availableShipping.length) reasons.push(`Metodos de envio Woo disponibles: ${availableShipping.map(m=>m.title||m.method_title||m.id).filter(Boolean).slice(0,4).join(', ')}.`);
  const messageLines = [];
  if (country === 'CO') {
    messageLines.push('Hola, revisé la disponibilidad y puedo ayudarle a finalizar su compra en Colombia.');
    if (cart.length) messageLines.push(`Tengo seleccionado ${cart.length} producto(s) para crear o copiar la venta a Dropi/WooCommerce.`);
    if (!documentValue) messageLines.push('Para completar la venta, me confirma su CC/NIT, ciudad, departamento y direccion completa.');
    messageLines.push('Cuando confirme los datos, puedo dejar el pedido listo con el metodo de pago y envio disponible.');
  } else {
    messageLines.push('Hola, revisé la disponibilidad y puedo ayudarle a finalizar su compra.');
    if (cart.length) messageLines.push(`Tengo seleccionado ${cart.length} producto(s) para crear el pedido.`);
    if (!documentValue || !validateRut(documentValue)) messageLines.push('Para emitir correctamente el pedido en Chile, me puede confirmar su RUT.');
    if (!comuna) messageLines.push('También necesito comuna y dirección completa para validar despacho.');
    messageLines.push('Cuando confirme los datos, puedo generar el pedido y el link de pago en CLP.');
  }
  next.push(country === 'CO' ? 'Elegir metodo de pago Woo Colombia disponible' : 'Elegir metodo de pago Woo Chile disponible');
  next.push('Validar metodo de envio antes de confirmar');
  const couponSuggestion = totalCart ? {
    code: `${country === 'CO' ? 'CO' : 'CL'}${Math.round(totalCart).toString().slice(-4)}${Math.floor(10 + Math.random()*89)}`,
    amount: totalCart >= (country === 'CO' ? 250000 : 80000) ? '10' : '5',
    discount_type: 'percent',
    free_shipping: Boolean(shipping && (Number(shipping.total || 0) === 0 || /gratis|free/i.test(`${shipping.method_title || shipping.title || ''}`))),
    reason: totalCart >= (country === 'CO' ? 250000 : 80000) ? 'Ticket alto: sugerir cupón de cierre.' : 'Cupón moderado para ayudar al cierre.'
  } : null;
  return {
    country,
    store: st.id,
    prompt_used: countryPrompt(country),
    labels: Array.from(labels).filter(Boolean).slice(0, 14),
    reasons,
    suggested_message: messageLines.join('\n'),
    next_actions: Array.from(new Set(next)).filter(Boolean).slice(0, 8),
    coupon_suggestion: couponSuggestion,
    available_payment_methods: availablePayments.map(m => ({ id:m.id, title:m.title })).slice(0,8),
    available_shipping_methods: availableShipping.map(m => ({ id:m.id || m.method_id, title:m.title || m.method_title, total:m.total })).slice(0,8),
    ai: false
  };
}
function extractJsonObject(text = '') {
  const raw = String(text || '').trim();
  try { return JSON.parse(raw); } catch (_) {}
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch (_) {} }
  return null;
}
async function callAiRecommendations(provider, payload, baseRecommendations) {
  const p = String(provider || 'local').toLowerCase();
  const country = baseRecommendations.country || payload.country || 'CL';
  const prompt = `${countryPrompt(country)}\n\nDevuelve SOLO JSON valido con estas claves opcionales: labels (array), reasons (array), next_actions (array), suggested_message (string), coupon_suggestion (object con code, amount, discount_type, free_shipping, reason). No uses markdown.`;
  const data = { country, payload, base_recommendations: baseRecommendations };
  const timeout = Number(process.env.AI_TIMEOUT_MS || 20000);
  if (p === 'webhook') {
    const aiUrl = process.env.AI_RECOMMENDATION_WEBHOOK_URL || '';
    if (!aiUrl) throw new Error('Webhook IA no configurado');
    const resp = await axios.post(aiUrl, { ...payload, base_recommendations: baseRecommendations, country_prompt: countryPrompt(country) }, { timeout });
    return resp.data || {};
  }
  if (p === 'openai') {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY no configurada');
    const resp = await axios.post('https://api.openai.com/v1/chat/completions', { model: process.env.OPENAI_MODEL || 'gpt-4o-mini', temperature: 0.3, messages: [{ role:'system', content: prompt }, { role:'user', content: JSON.stringify(data).slice(0, 20000) }] }, { timeout, headers: { Authorization:`Bearer ${process.env.OPENAI_API_KEY}` } });
    return extractJsonObject(resp.data?.choices?.[0]?.message?.content) || {};
  }
  if (p === 'deepseek') {
    if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY no configurada');
    const resp = await axios.post('https://api.deepseek.com/chat/completions', { model: process.env.DEEPSEEK_MODEL || 'deepseek-chat', temperature: 0.3, messages: [{ role:'system', content: prompt }, { role:'user', content: JSON.stringify(data).slice(0, 20000) }] }, { timeout, headers: { Authorization:`Bearer ${process.env.DEEPSEEK_API_KEY}` } });
    return extractJsonObject(resp.data?.choices?.[0]?.message?.content) || {};
  }
  if (p === 'gemini') {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY no configurada');
    const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
    const resp = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, { contents: [{ parts: [{ text: `${prompt}\n\nDatos:\n${JSON.stringify(data).slice(0, 20000)}` }] }] }, { timeout });
    return extractJsonObject(resp.data?.candidates?.[0]?.content?.parts?.[0]?.text) || {};
  }
  return {};
}

app.get('/flow/retorno', (req, res) => res.sendFile(path.join(__dirname, 'public', 'flow-retorno.html')));
app.post('/flow/confirmacion', (req, res) => res.status(200).send('OK'));

app.use(authMiddleware);

app.get('/admin/settings', async (req, res) => {
  res.json({ ok:true, settings: readRuntimeSettings(), stores: listStores(), postgres: dbReady, redis: redisReady });
});
app.post('/admin/settings', async (req, res, next) => {
  try {
    const settings = req.body?.settings || req.body || {};
    for (const [key, value] of Object.entries(settings)) if (CONFIG_KEYS.includes(key)) process.env[key] = String(value ?? '');
    rebuildRuntimeConfig();
    await saveAppSettingsToDb(settings);
    await cacheDelPrefix('productos:'); await cacheDelPrefix('cliente:'); await cacheDelPrefix('payment_methods:'); await cacheDelPrefix('shipping_methods:');
    res.json({ ok:true, message:'Configuracion guardada', stores:listStores(), saved_keys:Object.keys(settings).filter(k=>CONFIG_KEYS.includes(k)) });
  } catch (error) { next(error); }
});
app.post('/admin/settings/test', async (req, res, next) => {
  try {
    const incomingSettings = req.body?.settings || {};
    for (const [key, value] of Object.entries(incomingSettings)) {
      if (CONFIG_KEYS.includes(key)) process.env[key] = String(value ?? '');
    }
    if (Object.keys(incomingSettings).length) rebuildRuntimeConfig();

    const target = req.body?.target || 'chatwoot';
    if (target === 'chatwoot') return res.json(await testChatwootConnection());
    if (target === 'woo') return res.json(await testWooStore(req.body?.store || 'cl'));
    return res.status(400).json({ error:'target no soportado' });
  } catch (error) { next(error); }
});

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

app.get('/stores', (req,res)=>res.json({ stores:listStores(), default_store:currentDefaultStore() }));
app.get('/paises', (req,res)=>res.json({ stores:listStores(), default_store:currentDefaultStore() }));
app.get('/regiones', (req, res) => { const st=storeFromReq(req); res.json({ store:st.id, country:st.country, regiones:getCountryRegions(st.country) }); });
app.get('/comunas', (req, res) => { const st=storeFromReq(req); const regs=getCountryRegions(st.country); const region=String(req.query.region||'').toUpperCase(); const selected=regs.find(r=>String(r.codigo).toUpperCase()===region||normalizeText(r.region)===normalizeText(req.query.region||'')); const comunasOut=selected?selected.comunas:regs.flatMap(r=>r.comunas||[]); res.json({ store:st.id, country:st.country, comunas:comunasOut }); });
app.get('/validar-rut', (req, res) => res.json({ rut: formatRut(req.query.rut || ''), valido: validateRut(req.query.rut || '') }));
app.get('/cache/status', async (req, res) => res.json({ ok: true, memory_items: memoryCache.size, redis: redisReady, postgres: dbReady, sync: syncJob }));
app.post('/cache/clear', async (req, res) => { memoryCache.clear(); await cacheDelPrefix('productos:'); await cacheDelPrefix('cliente:'); await cacheDelPrefix('variations:'); res.json({ ok: true, message: 'Cache limpiado' }); });

app.get('/cliente', async (req, res, next) => {
  try {
    const email = String(req.query.email || req.query.email_cliente || req.query.customer_email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Debe indicar email del cliente' });
    const force = req.query.refresh === 'true';
    const st = storeFromReq(req);
    const wc = wcForStore(st);
    const result = await remember(`cliente:${st.id}:${email}`, 60, async () => {
      const { data: customers } = await wc.get('/customers', { params: { email, per_page: 1 } });
      const customer = customers[0] || null;
      const { data: orders } = await wc.get('/orders', { params: { search: email, per_page: 30, orderby: 'date', order: 'desc' } });
      const billing = customer?.billing || {};
      const rutMeta = getMetaValue(customer?.meta_data || [], RUT_META_KEYS) || '';
      const regionFound = comunaRegionMap.get(normalizeText(billing.city || '')) || null;
      return {
        cliente: customer ? { id: customer.id, nombre: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(), email: customer.email, telefono: billing.phone || '', rut: rutMeta || billing.rut || '', direccion: { ...billing, region_codigo: regionFound?.codigo || billing.state || '', region_nombre: regionFound?.region || billing.state || '' }, meta: extractMeta(customer.meta_data) } : { nombre: '', email, telefono: '', rut: '', direccion: {} },
        pedidos: orders.map((order) => ({
          id: order.id,
          numero: order.number,
          estado: order.status,
          total: order.total,
          moneda: order.currency || st.currency || 'CLP',
          store_id: st.id,
          country: st.country,
          fecha: order.date_created,
          metodo_pago: order.payment_method_title,
          payment_method: order.payment_method,
          rut: getMetaValue(order.meta_data || [], RUT_META_KEYS) || '',
          billing: order.billing || {},
          shipping: order.shipping || {},
          productos: order.line_items?.map((item) => ({ id: item.id, product_id: item.product_id, variation_id: item.variation_id, nombre: item.name, cantidad: item.quantity, total: item.total, subtotal: item.subtotal, sku: item.sku, meta: item.meta_data })) || [],
          meta: extractMeta(order.meta_data),
          customer_note: order.customer_note || ''
        }))
      };
    }, force);
    res.json({ ...result.value, cached: result.cached });
  } catch (error) { next(error); }
});
app.get('/productos', async (req, res, next) => {
  req.url = `/productos/search?${new URLSearchParams(req.query).toString()}`;
  return app._router.handle(req, res, next);
});
app.get('/productos/search', async (req, res, next) => {
  try {
    const params = { q: String(req.query.q || '').trim(), category: String(req.query.category || '').trim(), sale: req.query.sale === 'true', stock: String(req.query.stock || ''), limit: Math.min(Number(req.query.limit || PRODUCT_PAGE_SIZE), MAX_PAGE_SIZE), offset: Number(req.query.offset || 0) };
    const st = storeFromReq(req);
    const cacheKey = `productos:${st.id}:search:${hashKey(JSON.stringify(params))}`;
    const force = req.query.refresh === 'true';
    const result = await remember(cacheKey, PAGE_CACHE_SECONDS, async () => {
      let found = await searchProductsIndex(params, st);
      if (!found) {
        found = await buildProductsPage(params, st);
        if (params.category || params.sale || params.stock === 'instock') found = filterProductsLocal(found.productos, { ...params, offset: 0 });
      }
      return found;
    }, force);
    res.json({ ...result.value, store:st.id, country:st.country, currency:st.currency, cached:result.cached, limit:params.limit, offset:params.offset, redis:redisReady, postgres:dbReady, index_count: await productIndexCount(st.id), sync:syncJob });
  } catch (error) { next(error); }
});
app.get('/productos/:id/variaciones', async (req, res, next) => {
  try {
    const force = req.query.refresh === 'true';
    const st = storeFromReq(req);
    const variations = await getVariations(req.params.id, st, force);
    res.json({ product_id: Number(req.params.id), variations, total: variations.length, cached: !force });
  } catch (error) { next(error); }
});
app.post('/productos/sync', async (req, res) => {
  if (syncJob.running) return res.json({ ok: true, started: false, message: 'Sincronizacion ya en ejecucion', sync: syncJob });
  runCatalogSync(storeFromReq(req));
  res.json({ ok: true, started: true, message: 'Sincronizacion iniciada en segundo plano', sync: syncJob });
});
app.get('/productos/sync/status', (req, res) => res.json({ ok: true, sync: syncJob }));
app.get('/categorias', async (req, res, next) => {
  try {
    const st=storeFromReq(req);
    const result = await remember(`categorias:${st.id}:wc`, 3600, async () => {
      const { data } = await wcForStore(st).get('/products/categories', { params: { per_page: 100, hide_empty: false } });
      return data.map(c => ({ id: c.id, name: c.name, slug: c.slug, count: c.count })).filter(c => c.name).sort((a,b)=>a.name.localeCompare(b.name,'es'));
    }, req.query.refresh === 'true');
    res.json({ categorias: result.value, cached: result.cached });
  } catch (error) { next(error); }
});


app.get('/cupones', async (req, res, next) => {
  try {
    const st = storeFromReq(req); const wc = wcForStore(st);
    const search = String(req.query.search || req.query.q || '').trim();
    const params = { per_page: Math.min(Number(req.query.limit || 50), 100), page: Number(req.query.page || 1), orderby: 'date', order: 'desc' };
    if (search) params.search = search;
    const { data } = await wc.get('/coupons', { params });
    res.json({ store: st.id, country: st.country, cupones: data.map((c)=>({ id:c.id, code:c.code, amount:c.amount, discount_type:c.discount_type, description:c.description, free_shipping:c.free_shipping, minimum_amount:c.minimum_amount, maximum_amount:c.maximum_amount, usage_limit:c.usage_limit, usage_count:c.usage_count, date_expires:c.date_expires, status:c.status || (c.date_expires ? 'con fecha' : 'activo') })) });
  } catch (error) { next(error); }
});
app.get('/cupones/validar', async (req, res, next) => {
  try {
    const st = storeFromReq(req); const wc = wcForStore(st);
    const code = String(req.query.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Debe indicar codigo de cupon' });
    const { data } = await wc.get('/coupons', { params: { code, per_page: 1 } });
    const c = data[0] || null;
    if (!c) return res.status(404).json({ ok:false, error:'Cupon no encontrado' });
    res.json({ ok:true, store:st.id, coupon:{ id:c.id, code:c.code, amount:c.amount, discount_type:c.discount_type, description:c.description, free_shipping:c.free_shipping, minimum_amount:c.minimum_amount, maximum_amount:c.maximum_amount, usage_limit:c.usage_limit, usage_count:c.usage_count, date_expires:c.date_expires } });
  } catch (error) { next(error); }
});
app.post('/cupones', async (req, res, next) => {
  try {
    const st = storeFromReq(req); const wc = wcForStore(st);
    const body = req.body || {};
    const code = String(body.code || '').trim();
    if (!code) return res.status(400).json({ error:'Codigo de cupon obligatorio' });
    const payload = {
      code,
      discount_type: body.discount_type || 'fixed_cart',
      amount: String(body.amount || '0'),
      description: body.description || `Cupon creado desde panel Rivaida ${st.name}`,
      free_shipping: Boolean(body.free_shipping),
      individual_use: body.individual_use !== false,
      usage_limit: body.usage_limit ? Number(body.usage_limit) : undefined,
      minimum_amount: body.minimum_amount ? String(body.minimum_amount) : undefined,
      maximum_amount: body.maximum_amount ? String(body.maximum_amount) : undefined,
      date_expires: body.date_expires || undefined
    };
    Object.keys(payload).forEach((k)=>payload[k] === undefined && delete payload[k]);
    const { data } = await wc.post('/coupons', payload);
    res.status(201).json({ ok:true, store:st.id, coupon:{ id:data.id, code:data.code, amount:data.amount, discount_type:data.discount_type, description:data.description, free_shipping:data.free_shipping, date_expires:data.date_expires } });
  } catch (error) { next(error); }
});

app.get('/payment-methods', async (req, res, next) => {
  try {
    const st=storeFromReq(req);
    const result = await remember(`payment_gateways:${st.id}:wc`, 3600, async () => {
      const { data } = await wcForStore(st).get('/payment_gateways');
      const wooMethods = (data || []).filter((g) => g.enabled).map((g) => ({ id: g.id, title: g.title || g.method_title || g.id, description: cleanHtml(g.description || ''), enabled: g.enabled, source: 'woocommerce' }));
      return mergePaymentMethods(wooMethods, st);
    }, req.query.refresh === 'true');
    res.json({ store:st.id, country:st.country, methods:result.value, cached:result.cached, note: st.country === 'CO' ? 'Incluye metodos activos de WooCommerce mas sugeridos Colombia (Wompi, Bold, contra entrega, PSE, PayU, ePayco, Mercado Pago).' : '' });
  } catch (error) { next(error); }
});


app.get('/shipping-methods', async (req, res, next) => {
  try {
    const st = storeFromReq(req);
    const result = await remember(`shipping_methods:${st.id}:wc`, 3600, async () => {
      const wc = wcForStore(st);
      const methods = [];
      try {
        const { data: zones } = await wc.get('/shipping/zones');
        const zoneList = Array.isArray(zones) ? zones : [];
        for (const zone of zoneList) {
          try {
            const { data: zoneMethods } = await wc.get(`/shipping/zones/${zone.id}/methods`);
            for (const m of (zoneMethods || [])) if (m.enabled !== false) methods.push(normalizeShippingMethod(m, zone));
          } catch (e) { console.warn('[shipping zone methods]', zone?.id, e.response?.data || e.message); }
        }
      } catch (e) { console.warn('[shipping zones]', e.response?.data || e.message); }
      try {
        const { data: restOfWorld } = await wc.get('/shipping/zones/0/methods');
        for (const m of (restOfWorld || [])) if (m.enabled !== false) methods.push(normalizeShippingMethod(m, { id:0, name:'Resto del mundo' }));
      } catch (e) { /* algunos Woo no exponen zona 0 */ }
      const unique = [];
      const seen = new Set();
      for (const m of methods) {
        const key = `${m.method_id}:${m.instance_id}:${m.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(m);
      }
      return unique.length ? unique : defaultShippingFallback(st);
    }, req.query.refresh === 'true');
    res.json({ store: st.id, country: st.country, methods: result.value, cached: result.cached, note: 'Metodos de envio activos leidos desde zonas de envio WooCommerce.' });
  } catch (error) { next(error); }
});

app.get('/pedidos/buscar', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const email = String(req.query.email || '').trim();
    const params = { per_page: Math.min(Number(req.query.limit || 20), 50), orderby: 'date', order: 'desc' };
    if (q) params.search = q;
    if (email && !q) params.search = email;
    const st=storeFromReq(req);
    const { data } = await wcForStore(st).get('/orders', { params });
    res.json({ pedidos: data.map((order) => ({ id: order.id, numero: order.number, estado: order.status, total: order.total, fecha: order.date_created, metodo_pago: order.payment_method_title, email: order.billing?.email || '', nombre: `${order.billing?.first_name || ''} ${order.billing?.last_name || ''}`.trim(), productos: order.line_items?.map((i) => ({ nombre: i.name, cantidad: i.quantity, total: i.total, sku: i.sku })) || [] })) });
  } catch (error) { next(error); }
});

app.get('/pedidos/:id', async (req, res, next) => {
  try {
    const st=storeFromReq(req);
    const { data: order } = await wcForStore(st).get(`/orders/${Number(req.params.id)}`);
    res.json({ pedido: order });
  } catch (error) { next(error); }
});

app.post('/pedidos/:id/link-pago-woo', async (req, res, next) => {
  try {
    const orderId = Number(req.params.id);
    const st=storeFromReq(req);
    const gatewayId = preferredWooPaymentGateway(req.body || {}, st);
    const gatewayTitle = req.body?.payment_method_title || req.body?.gateway_title || process.env.WOO_FLOW_GATEWAY_TITLE || 'Flow - Webpay / Multicaja';

    let order;
    if (gatewayId) {
      const updatePayload = { payment_method: gatewayId, payment_method_title: gatewayTitle, status: req.body?.status || 'pending' };
      const updated = await wcForStore(st).put(`/orders/${orderId}`, updatePayload);
      order = updated.data;
    } else {
      const current = await wcForStore(st).get(`/orders/${orderId}`);
      order = current.data;
    }

    const url = getOrderPayUrl(order, st);
    if (!url) return res.status(502).json({ error: 'WooCommerce no retorno link de pago. Verifique que el pedido tenga order_key y que Checkout esté activo.' });
    res.json({ ok: true, provider: 'woocommerce', gateway_id: gatewayId, url, pedido: { id: order.id, numero: order.number, estado: order.status, total: order.total, moneda: order.currency || st.currency || 'CLP',
          store_id: st.id,
          country: st.country, payment_method: order.payment_method, payment_method_title: order.payment_method_title } });
  } catch (error) { next(error); }
});

app.get('/pedidos/:id/link-pago-woo', async (req, res, next) => {
  try {
    const st=storeFromReq(req);
    const { data: order } = await wcForStore(st).get(`/orders/${Number(req.params.id)}`);
    const url = getOrderPayUrl(order, st);
    if (!url) return res.status(502).json({ error: 'WooCommerce no retorno link de pago.' });
    res.json({ ok: true, provider: 'woocommerce', url, pedido: { id: order.id, numero: order.number, estado: order.status, total: order.total, moneda: order.currency || st.currency || 'CLP',
          store_id: st.id,
          country: st.country, payment_method: order.payment_method, payment_method_title: order.payment_method_title } });
  } catch (error) { next(error); }
});

app.patch('/pedidos/:id', async (req, res, next) => {
  try {
    const allowed = {};
    const body = req.body || {};
    if (body.status) allowed.status = body.status;
    if (body.customer_note !== undefined) allowed.customer_note = body.customer_note;
    if (body.billing) allowed.billing = body.billing;
    if (body.shipping) allowed.shipping = body.shipping;
    if (Array.isArray(body.line_items)) {
      await validateStock(body.line_items, storeFromReq(req));
      allowed.line_items = body.line_items.map((i) => ({ product_id: Number(i.product_id), variation_id: i.variation_id ? Number(i.variation_id) : undefined, quantity: Number(i.quantity) }));
    }
    if (body.rut && validateRut(body.rut)) allowed.meta_data = buildRutMeta(formatRut(body.rut));
    const st=storeFromReq(req);
    const { data: order } = await wcForStore(st).put(`/orders/${Number(req.params.id)}`, allowed);
    await cacheDelPrefix('cliente:');
    res.json({ ok: true, pedido: { id: order.id, numero: order.number, estado: order.status, total: order.total, moneda: order.currency || 'CLP' } });
  } catch (error) { next(error); }
});

app.post('/pedidos/:id/cancelar', async (req, res, next) => {
  try {
    const st=storeFromReq(req);
    const { data: order } = await wcForStore(st).put(`/orders/${Number(req.params.id)}`, { status: 'cancelled', customer_note: req.body?.customer_note || undefined });
    await cacheDelPrefix('cliente:');
    res.json({ ok: true, pedido: { id: order.id, numero: order.number, estado: order.status, total: order.total, moneda: order.currency || 'CLP' } });
  } catch (error) { next(error); }
});

app.delete('/pedidos/:id', async (req, res, next) => {
  try {
    const force = req.query.force === 'true';
    const st=storeFromReq(req);
    const { data: order } = await wcForStore(st).delete(`/orders/${Number(req.params.id)}`, { params: { force } });
    await cacheDelPrefix('cliente:');
    res.json({ ok: true, deleted: true, force, pedido: { id: order.id, numero: order.number || order.id, estado: order.status || 'trash' } });
  } catch (error) { next(error); }
});


function buildPlatformSalePayload(body = {}, store = resolveStore(currentDefaultStore())) {
  const st = resolveStore(store.id || store);
  const checkout = normalizeCheckout(body, st);
  const fullName = `${checkout.billing.first_name || ''} ${checkout.billing.last_name || ''}`.trim();
  const documentValue = String(body.document || body.rut || body.billing?.document || body.billing?.rut || '').trim();
  const paymentTitle = body.payment_method_title || body.gateway_title || st.payment_gateway_title || checkout.payment_method_title;
  const products = (body.cart || []).map((item) => ({
    product_id: item.product?.id || item.product_id,
    variation_id: item.variation?.id || item.variation_id || null,
    name: item.product?.nombre || item.name || '',
    sku: item.variation?.sku || item.product?.sku || item.sku || '',
    quantity: Number(item.quantity || 1),
    price: Number(item.variation?.precio || item.product?.precio || item.price || 0),
    variation: Array.isArray(item.variation?.atributos) ? item.variation.atributos.map((a) => `${a.name}: ${a.option}`).join(' / ') : '',
    image: item.variation?.imagen || item.product?.imagen || item.image || '',
    permalink: item.product?.permalink || item.permalink || ''
  }));
  const total = products.reduce((sum, p) => sum + Number(p.price || 0) * Number(p.quantity || 1), 0);
  return {
    platform: st.country === 'CO' ? 'dropi_colombia' : 'woocommerce',
    store_id: st.id,
    country: st.country,
    currency: st.currency,
    customer: {
      full_name: fullName,
      first_name: checkout.billing.first_name || '',
      last_name: checkout.billing.last_name || '',
      email: checkout.billing.email || '',
      phone_number: checkout.billing.phone || '',
      document: documentValue,
      address: checkout.billing.address_1 || '',
      address_2: checkout.billing.address_2 || '',
      city: checkout.billing.city || '',
      state: checkout.billing.state || '',
      country: checkout.billing.country || st.country,
      postal_code: checkout.billing.postcode || st.postcode_default || ''
    },
    payment: {
      method_id: checkout.payment_method,
      method_title: paymentTitle,
      mode: checkout.payment_method === 'cod' ? 'contra_entrega' : 'online_o_manual'
    },
    products,
    total,
    note: checkout.customer_note || '',
    copy_text: ''
  };
}
function platformPayloadToText(payload = {}) {
  const c = payload.customer || {};
  const products = (payload.products || []).map((p) => `- ${p.quantity}x ${p.name}${p.variation ? ` (${p.variation})` : ''} | SKU ${p.sku || 'N/D'} | ${p.price || 0}`).join('\n');
  return [
    `PLATAFORMA: ${payload.platform || ''}`,
    `PAIS: ${payload.country || ''}`,
    `NOMBRE: ${c.full_name || ''}`,
    `DOCUMENTO: ${c.document || ''}`,
    `TELEFONO: ${c.phone_number || ''}`,
    `EMAIL: ${c.email || ''}`,
    `DIRECCION: ${c.address || ''} ${c.address_2 || ''}`.trim(),
    `CIUDAD: ${c.city || ''}`,
    `DEPARTAMENTO/REGION: ${c.state || ''}`,
    `CODIGO POSTAL: ${c.postal_code || ''}`,
    `METODO PAGO: ${payload.payment?.method_title || payload.payment?.method_id || ''}`,
    `TOTAL: ${payload.total || 0} ${payload.currency || ''}`,
    'PRODUCTOS:',
    products || '- Sin productos',
    payload.note ? `NOTA: ${payload.note}` : ''
  ].filter(Boolean).join('\n');
}
app.post('/platform/export-sale', async (req, res, next) => {
  try {
    const st = storeFromReq(req);
    const payload = buildPlatformSalePayload(req.body || {}, st);
    payload.copy_text = platformPayloadToText(payload);
    res.json({ ok: true, payload, copy_text: payload.copy_text });
  } catch (error) { next(error); }
});
app.post('/chatwoot/enviar-resumen-venta', async (req, res, next) => {
  try {
    const client = chatwootClient();
    if (!client) return res.status(400).json({ error: 'Faltan credenciales Chatwoot' });
    const { conversationId, message, privateNote = false, labels = [] } = req.body || {};
    if (!conversationId || !message) return res.status(400).json({ error: 'conversationId y message son obligatorios' });
    const { data } = await client.post(`/conversations/${conversationId}/messages`, { content: message, message_type: 'outgoing', private: Boolean(privateNote), content_type: 'text' });
    if (labels.length) {
      const existing = await getConversationLabels(client, conversationId);
      await client.post(`/conversations/${conversationId}/labels`, { labels: Array.from(new Set([...existing, ...labels.map(cleanLabel).filter(Boolean)])) });
    }
    res.json({ ok: true, data });
  } catch (error) { next(error); }
});

app.post('/crear-pedido', async (req, res, next) => {
  try {
    const st = storeFromReq(req);
    const payload = normalizeCheckout(req.body, st);
    await validateStock(payload.line_items, st);
    const { data: order } = await wcForStore(st).post('/orders', payload);
    res.status(201).json({ ok: true, store: st.id, country: st.country, pedido: { id: order.id, numero: order.number, estado: order.status, total: order.total, moneda: order.currency || st.currency || 'CLP', checkout_url: getOrderPayUrl(order, st), payment_method: order.payment_method, payment_method_title: order.payment_method_title } });
  } catch (error) { next(error); }
});
app.post('/pagar', async (req, res, next) => {
  try {
    const { orderId, amount, subject, email, mode } = req.body;
    if (!orderId) return res.status(400).json({ error: 'orderId es obligatorio' });

    if (mode === 'woocommerce' || process.env.PAYMENT_LINK_PROVIDER === 'woocommerce') {
      const st=storeFromReq(req);
    const gatewayId = preferredWooPaymentGateway(req.body || {}, st);
      const gatewayTitle = req.body?.payment_method_title || req.body?.gateway_title || process.env.WOO_FLOW_GATEWAY_TITLE || 'Flow - Webpay / Multicaja';
      const { data: order } = await wcForStore(st).put(`/orders/${Number(orderId)}`, { payment_method: gatewayId, payment_method_title: gatewayTitle, status: 'pending' });
      const url = getOrderPayUrl(order, st);
      if (!url) return res.status(502).json({ error: 'WooCommerce no retorno link de pago.' });
      return res.json({ ok: true, provider: 'woocommerce', url, pedido: { id: order.id, numero: order.number, total: order.total, moneda: order.currency || st.currency || 'CLP',
          store_id: st.id,
          country: st.country, payment_method: order.payment_method, payment_method_title: order.payment_method_title } });
    }

    if (!process.env.FLOW_API_KEY || !process.env.FLOW_SECRET_KEY) return res.status(400).json({ error: 'Faltan credenciales Flow' });
    if (!amount || !email) return res.status(400).json({ error: 'amount y email son obligatorios para Flow directo' });
    const publicBase = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    const urlConfirmation = process.env.FLOW_URL_CONFIRMATION || `${publicBase}/flow/confirmacion`;
    const urlReturn = process.env.FLOW_URL_RETURN || `${publicBase}/flow/retorno`;
    if (!/^https:\/\/[^\s]+/i.test(urlConfirmation) || !/^https:\/\/[^\s]+/i.test(urlReturn)) return res.status(400).json({ error: 'FLOW_URL_CONFIRMATION y FLOW_URL_RETURN deben ser URLs publicas HTTPS validas.' });
    const params = { apiKey: process.env.FLOW_API_KEY, commerceOrder: `${orderId}-${Date.now()}`, subject: subject || `Pedido WooCommerce #${orderId}`, currency: (storeFromReq(req).currency || 'CLP'), amount: Math.round(Number(amount)), email, paymentMethod: process.env.FLOW_PAYMENT_METHOD || '9', urlConfirmation, urlReturn, optional: JSON.stringify({ orderId }) };
    const { data } = await axios.post(`${FLOW_API_URL}/payment/create`, buildFlowPayload(params), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000 });
    if (!data?.url || !data?.token) return res.status(502).json({ error: 'Flow no retorno URL/token', detalle: data });
    res.json({ ok: true, provider: 'flow_direct', url: `${data.url}?token=${data.token}`, token: data.token, flow_order: data.flowOrder || null });
  } catch (error) { next(error); }
});

function extractEmailFromTextBlock(value = '') {
  const match = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : '';
}
function extractPhoneFromTextBlock(value = '') {
  const match = String(value || '').match(/(?:\+?56)?\s?9\s?\d{4}\s?\d{4}|(?:\+?56)?\s?\d{8,9}/);
  return match ? match[0].replace(/\s+/g, '') : '';
}
function extractConversationEmail(conversation = {}) {
  const sender = conversation?.meta?.sender || conversation?.contact || conversation?.sender || {};
  const direct = sender.email || conversation.contact_email || conversation.email || '';
  if (direct) return String(direct).toLowerCase();
  const pools = [];
  for (const msg of conversation.messages || []) pools.push(msg.content, msg.processed_message_content, msg.sender?.email, msg.sender?.identifier);
  pools.push(sender.identifier, sender.name, sender.phone_number);
  for (const item of pools) {
    const email = extractEmailFromTextBlock(item);
    if (email) return email;
  }
  return '';
}
function normalizeConversationContext(conversation = {}) {
  const sender = conversation?.meta?.sender || conversation?.contact || conversation?.sender || {};
  const messages = conversation.messages || [];
  const email = extractConversationEmail(conversation);
  let phone = sender.phone_number || sender.phone || '';
  if (!phone) {
    for (const msg of messages) {
      phone = extractPhoneFromTextBlock(msg.content || msg.processed_message_content || '');
      if (phone) break;
    }
  }
  return {
    conversationId: conversation.id || conversation.conversation_id || '',
    email,
    phone,
    name: sender.name || sender.available_name || '',
    labels: conversation.labels || conversation.label_list || [],
    custom_attributes: conversation.custom_attributes || {},
    contact: sender,
    conversation
  };
}
async function getConversationLabels(client, conversationId) {
  try {
    const { data } = await client.get(`/conversations/${conversationId}/labels`);
    return Array.isArray(data?.payload) ? data.payload : (Array.isArray(data) ? data : []);
  } catch { return []; }
}
function cleanLabel(label='') {
  return String(label).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9_\-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,64);
}
const DEFAULT_CHATWOOT_LABELS = [
  { title:'rivaida_interesado', description:'Cliente interesado en productos', color:'#2563eb' },
  { title:'rivaida_pendiente_pago', description:'Pedido pendiente de pago', color:'#f59e0b' },
  { title:'rivaida_link_pago_enviado', description:'Se envio link de pago', color:'#22c55e' },
  { title:'rivaida_producto_enviado', description:'Producto enviado desde panel', color:'#06b6d4' },
  { title:'rivaida_rut_validado', description:'RUT validado en panel', color:'#14b8a6' },
  { title:'rivaida_sin_stock', description:'Consulta por producto sin stock', color:'#ef4444' },
  { title:'rivaida_postventa', description:'Consulta postventa o seguimiento', color:'#8b5cf6' }
];
const DEFAULT_CHATWOOT_ATTRIBUTES = [
  { attribute_display_name:'Rivaida estado', attribute_key:'rivaida_estado', attribute_description:'Estado comercial desde panel Rivaida', attribute_display_type:0, attribute_model:0 },
  { attribute_display_name:'Rivaida email detectado', attribute_key:'rivaida_email_detectado', attribute_description:'Email tomado del contacto o detectado en la conversacion', attribute_display_type:0, attribute_model:0 },
  { attribute_display_name:'Rivaida ultimo producto', attribute_key:'rivaida_ultimo_producto', attribute_description:'Ultimo producto enviado al chat', attribute_display_type:0, attribute_model:0 },
  { attribute_display_name:'Rivaida ultimo SKU', attribute_key:'rivaida_ultimo_sku', attribute_description:'SKU del ultimo producto enviado', attribute_display_type:0, attribute_model:0 },
  { attribute_display_name:'Rivaida carrito total', attribute_key:'rivaida_carrito_total', attribute_description:'Total estimado del carrito', attribute_display_type:1, attribute_model:0 },
  { attribute_display_name:'Rivaida rut validado', attribute_key:'rivaida_rut_validado', attribute_description:'RUT validado desde el panel', attribute_display_type:7, attribute_model:0 }
];

async function sendChatwootProductMessage(client, conversationId, content, img, privateNote, contentAttributes) {
  const wantsAttachment = img && getCfg('CHATWOOT_SEND_IMAGE_ATTACHMENT','true') !== 'false';
  if (wantsAttachment) {
    try {
      const imageResp = await axios.get(img, { responseType: 'arraybuffer', timeout: Number(getCfg('IMAGE_FETCH_TIMEOUT_MS','15000')), maxContentLength: Number(getCfg('IMAGE_MAX_BYTES','8000000')) });
      const mime = String(imageResp.headers['content-type'] || 'image/jpeg').split(';')[0];
      if (!mime.startsWith('image/')) throw new Error(`La URL no retorno imagen valida: ${mime}`);
      const filename = `producto-${Date.now()}.${mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg'}`;
      const form = new FormData();
      form.append('content', content);
      form.append('message_type', 'outgoing');
      form.append('private', String(Boolean(privateNote)));
      form.append('content_type', 'text');
      form.append('content_attributes', JSON.stringify(contentAttributes || {}));
      form.append('attachments[]', Buffer.from(imageResp.data), { filename, contentType: mime });
      const { data } = await client.post(`/conversations/${conversationId}/messages`, form, { headers: form.getHeaders() });
      return { data, sentAsAttachment: true, imageFallback: false };
    } catch (e) {
      console.warn('[Chatwoot imagen adjunta] fallback texto:', e.response?.data || e.message);
    }
  }
  const fallbackContent = [content, img ? `Imagen: ${img}` : ''].filter(Boolean).join('\n');
  const { data } = await client.post(`/conversations/${conversationId}/messages`, {
    content: fallbackContent,
    message_type: 'outgoing',
    private: Boolean(privateNote),
    content_type: 'text',
    content_attributes: { ...(contentAttributes || {}), image_url: img || undefined }
  });
  return { data, sentAsAttachment: false, imageFallback: Boolean(img) };
}

function productImageUrl(product = {}, variation = null) { return variation?.imagen || product?.imagen || product?.imagenes?.[0]?.src || ''; }

app.post('/chatwoot/enviar-producto', async (req, res, next) => {
  try {
    const client = chatwootClient();
    if (!client) return res.status(400).json({ error: 'Faltan credenciales Chatwoot' });
    const { conversationId, product, variation, quantity = 1, privateNote = false, imageUrl = '', autoLabels = true, custom_attributes = {} } = req.body;
    if (!conversationId || !product?.nombre) return res.status(400).json({ error: 'conversationId y producto son obligatorios' });
    const price = variation?.precio || product.precio || 0;
    const attrs = variation?.atributos?.map(a => `${a.name}: ${a.option}`).join(' / ') || '';
    const img = imageUrl || productImageUrl(product, variation);
    const content = [
      `Producto: ${product.nombre}`,
      attrs ? `Variacion: ${attrs}` : '',
      `SKU: ${variation?.sku || product.sku || 'N/D'}`,
      `Precio: $${Number(price || 0).toLocaleString('es-CL')} CLP`,
      `Cantidad sugerida: ${quantity}`,
      product.permalink ? `Link: ${product.permalink}` : ''
    ].filter(Boolean).join('\n');
    const mediaResult = await sendChatwootProductMessage(client, conversationId, content, img, privateNote, { product_id: product.id, variation_id: variation?.id || undefined, sku: variation?.sku || product.sku || '', price: Number(price || 0) });
    if (autoLabels) {
      const existing = await getConversationLabels(client, conversationId);
      await client.post(`/conversations/${conversationId}/labels`, { labels: Array.from(new Set([...existing, 'rivaida_interesado', 'rivaida_producto_enviado'])) });
    }
    const attrsPayload = { rivaida_estado: 'producto_enviado', rivaida_ultimo_producto: product.nombre, rivaida_ultimo_sku: variation?.sku || product.sku || '', rivaida_ultima_imagen: img || '', ...custom_attributes };
    try { await client.post(`/conversations/${conversationId}/custom_attributes`, { custom_attributes: attrsPayload }); } catch (e) { console.warn('[Chatwoot atributos envio]', e.response?.data || e.message); }
    res.json({ ok: true, message: mediaResult.sentAsAttachment ? 'Producto enviado a Chatwoot con imagen adjunta' : 'Producto enviado a Chatwoot con enlace de imagen', image_sent_as_attachment: mediaResult.sentAsAttachment, image_fallback_url: mediaResult.imageFallback, imageUrl: img });
  } catch (error) { next(error); }
});

app.post('/chatwoot/etiquetas', async (req, res, next) => {
  try {
    const client = chatwootClient();
    if (!client) return res.status(400).json({ error: 'Faltan credenciales Chatwoot' });
    const { conversationId, labels = [], merge = true } = req.body;
    if (!conversationId || !Array.isArray(labels)) return res.status(400).json({ error: 'conversationId y labels son obligatorios' });
    const incoming = labels.map(cleanLabel).filter(Boolean);
    const existing = merge ? await getConversationLabels(client, conversationId) : [];
    const finalLabels = Array.from(new Set([...existing, ...incoming]));
    await client.post(`/conversations/${conversationId}/labels`, { labels: finalLabels });
    res.json({ ok: true, labels: finalLabels, merged: Boolean(merge) });
  } catch (error) { next(error); }
});

app.post('/chatwoot/etiquetas/setup', async (req, res, next) => {
  try {
    const client = chatwootClient();
    if (!client) return res.status(400).json({ error: 'Faltan credenciales Chatwoot' });
    const results = [];
    for (const item of DEFAULT_CHATWOOT_LABELS) {
      try { const { data } = await client.post('/labels', { ...item, show_on_sidebar: true }); results.push({ title: item.title, ok: true, data }); }
      catch (e) { results.push({ title: item.title, ok: false, exists: e.response?.status === 422 || e.response?.status === 409, error: e.response?.data || e.message }); }
    }
    res.json({ ok: true, results });
  } catch (error) { next(error); }
});

app.post('/chatwoot/atributos/setup', async (req, res, next) => {
  try {
    const client = chatwootClient();
    if (!client) return res.status(400).json({ error: 'Faltan credenciales Chatwoot' });
    const results = [];
    for (const item of DEFAULT_CHATWOOT_ATTRIBUTES) {
      try { const { data } = await client.post('/custom_attribute_definitions', item); results.push({ key: item.attribute_key, ok: true, data }); }
      catch (e) { results.push({ key: item.attribute_key, ok: false, exists: e.response?.status === 422 || e.response?.status === 409, error: e.response?.data || e.message }); }
    }
    res.json({ ok: true, results });
  } catch (error) { next(error); }
});

app.post('/chatwoot/atributos/conversacion', async (req, res, next) => {
  try {
    const client = chatwootClient();
    if (!client) return res.status(400).json({ error: 'Faltan credenciales Chatwoot' });
    const { conversationId, custom_attributes = {} } = req.body;
    if (!conversationId || typeof custom_attributes !== 'object') return res.status(400).json({ error: 'conversationId y custom_attributes son obligatorios' });
    const { data } = await client.post(`/conversations/${conversationId}/custom_attributes`, { custom_attributes });
    res.json({ ok: true, custom_attributes, data });
  } catch (error) { next(error); }
});

app.get('/chatwoot/conversacion/:id/contexto', async (req, res, next) => {
  try {
    const client = chatwootClient();
    if (!client) return res.status(400).json({ error: 'Faltan credenciales Chatwoot' });
    const { data } = await client.get(`/conversations/${req.params.id}`);
    const ctx = normalizeConversationContext(data || {});
    res.json({ ok: true, ...ctx, email_detected_from_message: Boolean(ctx.email && !(ctx.contact?.email)) });
  } catch (error) { next(error); }
});

app.post('/chatwoot/recomendaciones', async (req, res, next) => {
  try {
    let recommendations = buildRecommendations(req.body || {});
    const provider = String(process.env.AI_PROVIDER || 'local').toLowerCase();
    if (provider && provider !== 'local') {
      try {
        const aiData = await callAiRecommendations(provider, req.body || {}, recommendations);
        recommendations = { ...recommendations, ...(aiData || {}), labels: Array.from(new Set([...(recommendations.labels || []), ...((aiData || {}).labels || [])])), ai: true, ai_provider: provider };
      } catch (e) { recommendations.ai_error = e.message; }
    }
    res.json({ ok: true, recommendations });
  } catch (error) { next(error); }
});

app.post('/chatwoot/aplicar-recomendaciones', async (req, res, next) => {
  try {
    const client = chatwootClient();
    if (!client) return res.status(400).json({ error: 'Faltan credenciales Chatwoot' });
    const { conversationId, labels = [], message = '', privateNote = true } = req.body;
    if (!conversationId) return res.status(400).json({ error: 'conversationId es obligatorio' });
    if (Array.isArray(labels) && labels.length) { const existing = await getConversationLabels(client, conversationId); await client.post(`/conversations/${conversationId}/labels`, { labels: Array.from(new Set([...existing, ...labels.map(cleanLabel).filter(Boolean)])) }); }
    if (message) await client.post(`/conversations/${conversationId}/messages`, { content: message, message_type: 'outgoing', private: Boolean(privateNote) });
    res.json({ ok: true, labels, message_sent: Boolean(message) });
  } catch (error) { next(error); }
});

app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
app.use((error, req, res, next) => {
  console.error('[ERROR]', error.response?.data || error.message);
  const status = error.status || error.response?.status || 500;
  res.status(status).json({ error: formatWooError(error), status, store_config_missing: /WooCommerce no configurado/.test(String(error.message || '')) });
});
const server = app.listen(PORT, '0.0.0.0', () => console.log(`Panel v8.3.5 activo en puerto ${PORT}`));
process.on('SIGTERM', () => { console.log('SIGTERM recibido, cerrando servidor'); server.close(() => process.exit(0)); });
