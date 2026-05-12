// v7.0: link de pago WooCommerce/Flow, variables limpias y Chatwoot App listo.

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

const app = express();
const PORT = Number(process.env.PORT || 3001);
const WC_URL = String(process.env.WC_URL || '').replace(/\/$/, '');
const FLOW_API_URL = String(process.env.FLOW_API_URL || 'https://www.flow.cl/api').replace(/\/$/, '');
const CHATWOOT_URL = String(process.env.CHATWOOT_URL || '').replace(/\/$/, '');
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 900);
const PAGE_CACHE_SECONDS = Number(process.env.PAGE_CACHE_SECONDS || 120);
const PRODUCT_PAGE_SIZE = Number(process.env.PRODUCT_PAGE_SIZE || 20);
const MAX_PAGE_SIZE = Number(process.env.MAX_PAGE_SIZE || 40);

const requiredEnv = ['PANEL_USER','PANEL_PASSWORD','WC_URL','WC_KEY','WC_SECRET'];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length) console.warn(`[WARN] Variables faltantes: ${missingEnv.join(', ')}`);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
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
  res.json({ ok: true, service: 'chatwoot-woocommerce-flow-panel-v7.3-chatwoot-auto-context-image', port: PORT, redis: redisReady, postgres: dbReady, cache_items: memoryCache.size, sync: syncJob.running ? 'running' : 'idle' });
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

const wc = axios.create({
  baseURL: `${WC_URL}/wp-json/wc/v3`,
  auth: { username: process.env.WC_KEY, password: process.env.WC_SECRET },
  timeout: Number(process.env.WC_TIMEOUT_MS || 30000)
});
function chatwootClient() {
  if (!CHATWOOT_URL || !process.env.CHATWOOT_API_KEY || !process.env.CHATWOOT_ACCOUNT_ID) return null;
  return axios.create({
    baseURL: `${CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}`,
    headers: { api_access_token: process.env.CHATWOOT_API_KEY, 'Content-Type': 'application/json' },
    timeout: 20000
  });
}
function formatWooError(error) {
  const data = error.response?.data;
  return data?.message || data?.error || error.message || 'Error inesperado';
}

function getOrderPayUrl(order = {}) {
  const direct = order.payment_url || order.checkout_payment_url || order.pay_url || '';
  if (direct) return direct;
  const key = order.order_key || order.orderKey || '';
  if (WC_URL && order.id && key) {
    return `${WC_URL}/checkout/order-pay/${order.id}/?pay_for_order=true&key=${encodeURIComponent(key)}`;
  }
  return '';
}

function preferredWooPaymentGateway(body = {}) {
  return body.gateway_id || body.payment_method || process.env.WOO_FLOW_GATEWAY_ID || process.env.WOO_PAYMENT_GATEWAY_ID || 'flow';
}

function loadRegiones() {
  const jsonPath = path.join(__dirname, 'data', 'regiones-comunas-chile.json');
  if (!fs.existsSync(jsonPath)) return [];
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}
function loadComunas() {
  const csvPath = path.join(__dirname, 'data', 'starter-comunas-chile.csv');
  if (!fs.existsSync(csvPath)) return [];
  const rows = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).slice(1).filter(Boolean);
  return rows.map((line) => {
    const [comuna, postcode] = line.split(',');
    return { comuna: (comuna || '').trim(), postcode: (postcode || '').trim() };
  }).filter((x) => x.comuna && x.postcode);
}
const comunas = loadComunas();
const comunaMap = new Map(comunas.map((x) => [normalizeText(x.comuna), x.postcode]));
function getPostcode(comuna, fallback = '8320000') { return comunaMap.get(normalizeText(comuna)) || fallback; }
const rawRegiones = loadRegiones();
const regiones = rawRegiones.map((r) => ({
  ...r,
  region_original: r.region,
  region: normalizeRegionForAli(r.region),
  comunas: (r.comunas || []).map((nombre) => ({ comuna: nombre, postcode: getPostcode(nombre, process.env.DEFAULT_POSTCODE || '8320000') }))
}));
const comunaRegionMap = new Map();
for (const region of regiones) for (const c of region.comunas) comunaRegionMap.set(normalizeText(c.comuna), { codigo: region.codigo, region: region.region, region_original: region.region_original });
const regionMapByCode = new Map(regiones.map((r) => [String(r.codigo || '').toUpperCase(), r]));
const regionMapByName = new Map();
for (const r of regiones) {
  regionMapByName.set(normalizeText(r.region || ''), r);
  regionMapByName.set(normalizeText(r.region_original || ''), r);
}

const RUT_META_KEYS = [
  'billing_rut', '_billing_rut', 'shipping_rut', '_shipping_rut',
  'rut', '_rut', 'run', '_run'
];

function getMetaValue(metaData = [], keys = []) {
  const wanted = new Set(keys.map((k) => normalizeText(k)));
  for (const m of metaData || []) {
    const key = normalizeText(m.key || '');
    if (wanted.has(key) && m.value !== undefined && m.value !== null && String(m.value).trim() !== '') return String(m.value).trim();
  }
  return '';
}

function mergeMetaData(meta = []) {
  // Ultimo valor gana. Asi los aliases AliDropship que agregamos reemplazan valores vacios o antiguos enviados desde el frontend.
  const map = new Map();
  for (const item of meta || []) {
    if (!item || !item.key) continue;
    const k = String(item.key);
    const nk = normalizeText(k);
    map.set(nk, { key: k, value: item.value });
  }
  return Array.from(map.values());
}

function buildRutMeta(rutFormatted) {
  if (!rutFormatted) return [];
  // v6.8: solo campos esenciales para no llenar WooCommerce con campos personalizados duplicados.
  return [
    { key: 'billing_rut', value: rutFormatted },
    { key: 'shipping_rut', value: rutFormatted },
    { key: '_billing_rut', value: rutFormatted },
    { key: '_shipping_rut', value: rutFormatted }
  ];
}
function resolveRegionInfo(regionInput = '', comuna = '') {
  const raw = String(regionInput || '').trim();
  const codeCandidate = raw.toUpperCase();
  if (regionMapByCode.has(codeCandidate)) {
    const r = regionMapByCode.get(codeCandidate);
    return { codigo: r.codigo, region: r.region };
  }
  const byName = regionMapByName.get(normalizeText(raw));
  if (byName) return { codigo: byName.codigo, region: byName.region };
  const byComuna = comunaRegionMap.get(normalizeText(comuna || ''));
  if (byComuna) return byComuna;
  return { codigo: raw, region: raw };
}

function regionStateValue(info) {
  if (process.env.CHILE_STATE_FORMAT === 'code') return info.codigo || '';
  return normalizeRegionForAli(info.region || info.codigo || '');
}

async function initDb() {
  if (!pgPool) return false;
  try {
    await pgPool.query(`CREATE TABLE IF NOT EXISTS product_index (
      id BIGINT PRIMARY KEY,
      type TEXT, nombre TEXT, sku TEXT, precio NUMERIC, precio_regular NUMERIC, precio_oferta NUMERIC,
      stock INTEGER, stock_status TEXT, imagen TEXT, permalink TEXT,
      categorias TEXT[], etiquetas TEXT[], variation_count INTEGER DEFAULT 0,
      search_text TEXT, payload JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now()
    )`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_product_index_search_text ON product_index (search_text)`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_product_index_sku ON product_index (sku)`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_product_index_categories ON product_index USING gin(categorias)`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_product_index_sale ON product_index (precio_oferta)`);
    dbReady = true;
    console.log('[Postgres] indice de productos listo');
    return true;
  } catch (e) { console.warn('[Postgres] no disponible:', e.message); return false; }
}
initDb();
async function productIndexCount() {
  if (!pgPool || !dbReady) return 0;
  try { const { rows } = await pgPool.query('SELECT COUNT(*)::int AS count FROM product_index'); return Number(rows[0]?.count || 0); } catch { return 0; }
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
function normalizeProduct(product, variations = null) {
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
    moneda: 'CLP',
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
      await client.query(`INSERT INTO product_index (id,type,nombre,sku,precio,precio_regular,precio_oferta,stock,stock_status,imagen,permalink,categorias,etiquetas,variation_count,search_text,payload,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
        ON CONFLICT (id) DO UPDATE SET type=EXCLUDED.type,nombre=EXCLUDED.nombre,sku=EXCLUDED.sku,precio=EXCLUDED.precio,precio_regular=EXCLUDED.precio_regular,precio_oferta=EXCLUDED.precio_oferta,stock=EXCLUDED.stock,stock_status=EXCLUDED.stock_status,imagen=EXCLUDED.imagen,permalink=EXCLUDED.permalink,categorias=EXCLUDED.categorias,etiquetas=EXCLUDED.etiquetas,variation_count=EXCLUDED.variation_count,search_text=EXCLUDED.search_text,payload=EXCLUDED.payload,updated_at=now()`,
        [p.id,p.type,p.nombre,p.sku,Number(p.precio||0),Number(p.precio_regular||0),Number(p.precio_oferta||0),p.stock,p.stock_status,p.imagen,p.permalink,p.categorias||[],p.etiquetas||[],Number(p.variation_count || 0),searchText,JSON.stringify(p)]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); console.warn('[Postgres upsert]', e.message); }
  finally { client.release(); }
}
async function searchProductsIndex({ q='', category='', sale=false, stock='', limit=PRODUCT_PAGE_SIZE, offset=0 } = {}) {
  if (!pgPool || !dbReady) return null;
  if (await productIndexCount() === 0) return null;
  const clauses=[]; const values=[];
  if (q) { values.push(`%${normalizeText(q)}%`); clauses.push(`search_text ILIKE $${values.length}`); }
  if (category) { values.push(category); clauses.push(`$${values.length} = ANY(categorias)`); }
  if (sale) clauses.push(`COALESCE(precio_oferta,0) > 0`);
  if (stock === 'instock') clauses.push(`stock_status = 'instock'`);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  values.push(Number(limit)); const limitIdx=values.length; values.push(Number(offset)); const offsetIdx=values.length;
  const { rows } = await pgPool.query(`SELECT payload, count(*) OVER() AS total FROM product_index ${where} ORDER BY updated_at DESC, nombre ASC LIMIT $${limitIdx} OFFSET $${offsetIdx}`, values);
  return { productos: rows.map(r => r.payload), total: Number(rows[0]?.total || 0), source: 'postgres' };
}
async function getVariations(productId, force=false) {
  const key = `variations:${productId}`;
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
async function buildProductsPage({ q='', limit=PRODUCT_PAGE_SIZE, offset=0 } = {}) {
  const page = Math.floor(Number(offset || 0) / Number(limit || PRODUCT_PAGE_SIZE)) + 1;
  const params = { per_page: Math.min(Number(limit || PRODUCT_PAGE_SIZE), 100), page, status: 'publish' };
  if (q) params.search = q;
  const response = await wc.get('/products', { params });
  const total = Number(response.headers['x-wp-total'] || 0);
  const normalized = response.data.map((p) => normalizeProduct(p));
  upsertProductsIndex(normalized).catch((e) => console.warn('[index async]', e.message));
  return { productos: normalized, total: total || (Number(offset) + normalized.length + (normalized.length === Number(limit) ? 1 : 0)), source: 'woocommerce_page' };
}
function filterProductsLocal(products, { q='', category='', sale=false, stock='', limit=PRODUCT_PAGE_SIZE, offset=0 } = {}) {
  const nq = normalizeText(q);
  let filtered = products.filter(p => {
    if (category && !(p.categorias || []).includes(category)) return false;
    if (sale && !Number(p.precio_oferta || 0)) return false;
    if (stock === 'instock' && p.stock_status !== 'instock') return false;
    if (!nq) return true;
    return productSearchText(p).includes(nq);
  });
  const total = filtered.length;
  return { productos: filtered.slice(Number(offset), Number(offset)+Number(limit)), total, source: 'memory' };
}
async function runCatalogSync() {
  if (syncJob.running) return;
  syncJob = { running: true, startedAt: new Date().toISOString(), finishedAt: null, page: 0, total: 0, indexed: 0, error: null };
  try {
    await cacheDelPrefix('productos:');
    let page = 1;
    const perPage = Number(process.env.SYNC_PER_PAGE || 50);
    while (true) {
      syncJob.page = page;
      const response = await wc.get('/products', { params: { per_page: perPage, page, status: 'publish' } });
      const products = response.data.map((p) => normalizeProduct(p));
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
function normalizeCheckout(body) {
  const rut = String(body.rut || body.billing?.rut || getMetaValue(body.meta_data, RUT_META_KEYS) || '').trim();
  if (process.env.REQUIRE_RUT !== 'false' && !validateRut(rut)) { const e = new Error('RUT chileno invalido o faltante'); e.status = 400; throw e; }
  const rutFormatted = formatRut(rut);
  const billing = { ...(body.billing || {}) };
  const shipping = { ...(body.shipping || billing) };
  const comuna = body.comuna || billing.city || shipping.city;
  const postcode = body.postcode || getPostcode(comuna, process.env.DEFAULT_POSTCODE || '8320000');
  const regionInfo = resolveRegionInfo(body.region_nombre || body.region || body.region_codigo || billing.state || shipping.state, comuna);
  const stateValue = regionStateValue(regionInfo);
  billing.country = 'CL'; shipping.country = 'CL';
  billing.state = stateValue; shipping.state = stateValue;
  billing.postcode = postcode; shipping.postcode = postcode;
  billing.city = comuna || billing.city; shipping.city = comuna || shipping.city;

  const safeIncomingMeta = (body.meta_data || []).filter((m) => {
    const k = normalizeText(m?.key || '');
    return ['_chatwoot_conversation_id','chatwoot_conversation_id'].includes(k);
  });
  const metaData = mergeMetaData([
    ...safeIncomingMeta,
    ...buildRutMeta(rutFormatted)
  ]);

  return {
    payment_method: body.payment_method || process.env.WOO_FLOW_GATEWAY_ID || 'flow',
    payment_method_title: body.payment_method_title || process.env.WOO_FLOW_GATEWAY_TITLE || 'Flow - Webpay / Multicaja',
    set_paid: false,
    status: body.status || 'pending',
    billing,
    shipping,
    line_items: (body.line_items || []).map((i) => ({ product_id: Number(i.product_id), variation_id: i.variation_id ? Number(i.variation_id) : undefined, quantity: Number(i.quantity) })),
    shipping_lines: body.shipping_lines || [],
    customer_note: body.customer_note || '',
    meta_data: metaData
  };
}
async function validateStock(lineItems = []) {
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


function buildRecommendations(payload = {}) {
  const cliente = payload.cliente || {};
  const pedidos = Array.isArray(payload.pedidos) ? payload.pedidos : [];
  const cart = Array.isArray(payload.cart) ? payload.cart : [];
  const rut = String(payload.rut || cliente.rut || '').trim();
  const comuna = String(payload.comuna || cliente.direccion?.city || '').trim();
  const region = String(payload.region || cliente.direccion?.region_codigo || cliente.direccion?.state || '').trim();
  const email = String(payload.email || cliente.email || '').trim();
  const labels = new Set(['panel_chatwoot', 'woo_panel']);
  const reasons = [];
  if (rut && validateRut(rut)) { labels.add('rut_validado'); reasons.push('RUT validado correctamente.'); }
  else { labels.add('rut_pendiente'); reasons.push('Conviene solicitar o validar RUT antes de crear el pedido.'); }
  if (comuna) { labels.add(`comuna_${normalizeText(comuna).replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'').slice(0,32)}`); reasons.push(`Comuna detectada: ${comuna}.`); }
  if (region) { labels.add(`region_${normalizeText(region).replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'').slice(0,32)}`); }
  if (cart.length) { labels.add('carrito_activo'); reasons.push(`${cart.length} item(s) en carrito.`); }
  if (pedidos.length) {
    labels.add('cliente_recurrente');
    const last = pedidos[0];
    if (last?.estado) labels.add(`ultimo_pedido_${String(last.estado).replace(/[^a-z0-9_]+/gi,'_').toLowerCase()}`);
    reasons.push('Cliente con historial de pedidos en WooCommerce.');
  } else labels.add('cliente_nuevo');
  const totalCart = cart.reduce((sum, item) => sum + Number(item?.variation?.precio || item?.product?.precio || 0) * Number(item?.quantity || 1), 0);
  if (totalCart >= 50000) labels.add('ticket_alto');
  if (payload.stockStatus === 'outofstock') labels.add('sin_stock');
  const messageLines = [];
  messageLines.push('Hola, revisé la disponibilidad y puedo ayudarle a finalizar su compra.');
  if (cart.length) messageLines.push(`Tengo seleccionado ${cart.length} producto(s) para cotizar o crear el pedido.`);
  if (!rut || !validateRut(rut)) messageLines.push('Para emitir correctamente el pedido en Chile, me puede confirmar su RUT.');
  if (!comuna) messageLines.push('También necesito comuna y dirección completa para validar despacho.');
  messageLines.push('Cuando confirme los datos, puedo generar el pedido y el link de pago en CLP.');
  return {
    labels: Array.from(labels).filter(Boolean).slice(0, 12),
    reasons,
    suggested_message: messageLines.join('\n'),
    next_actions: [
      !rut || !validateRut(rut) ? 'Solicitar RUT valido' : 'RUT listo',
      !comuna ? 'Solicitar comuna de despacho' : 'Comuna lista',
      cart.length ? 'Crear pedido desde el carrito' : 'Agregar producto recomendado al carrito',
      'Enviar link de pago Flow si el cliente confirma'
    ],
    ai: false
  };
}

app.get('/flow/retorno', (req, res) => res.sendFile(path.join(__dirname, 'public', 'flow-retorno.html')));
app.post('/flow/confirmacion', (req, res) => res.status(200).send('OK'));

app.use(authMiddleware);
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

app.get('/regiones', (req, res) => res.json({ regiones }));
app.get('/comunas', (req, res) => res.json({ comunas }));
app.get('/validar-rut', (req, res) => res.json({ rut: formatRut(req.query.rut || ''), valido: validateRut(req.query.rut || '') }));
app.get('/cache/status', async (req, res) => res.json({ ok: true, memory_items: memoryCache.size, redis: redisReady, postgres: dbReady, sync: syncJob }));
app.post('/cache/clear', async (req, res) => { memoryCache.clear(); await cacheDelPrefix('productos:'); await cacheDelPrefix('cliente:'); await cacheDelPrefix('variations:'); res.json({ ok: true, message: 'Cache limpiado' }); });

app.get('/cliente', async (req, res, next) => {
  try {
    const email = String(req.query.email || req.query.email_cliente || req.query.customer_email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Debe indicar email del cliente' });
    const force = req.query.refresh === 'true';
    const result = await remember(`cliente:${email}`, 60, async () => {
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
          moneda: order.currency || 'CLP',
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
    const cacheKey = `productos:search:${hashKey(JSON.stringify(params))}`;
    const force = req.query.refresh === 'true';
    const result = await remember(cacheKey, PAGE_CACHE_SECONDS, async () => {
      let found = await searchProductsIndex(params);
      if (!found) {
        found = await buildProductsPage(params);
        if (params.category || params.sale || params.stock === 'instock') found = filterProductsLocal(found.productos, { ...params, offset: 0 });
      }
      return found;
    }, force);
    res.json({ ...result.value, cached: result.cached, limit: params.limit, offset: params.offset, redis: redisReady, postgres: dbReady, index_count: await productIndexCount(), sync: syncJob });
  } catch (error) { next(error); }
});
app.get('/productos/:id/variaciones', async (req, res, next) => {
  try {
    const force = req.query.refresh === 'true';
    const variations = await getVariations(req.params.id, force);
    res.json({ product_id: Number(req.params.id), variations, total: variations.length, cached: !force });
  } catch (error) { next(error); }
});
app.post('/productos/sync', async (req, res) => {
  if (syncJob.running) return res.json({ ok: true, started: false, message: 'Sincronizacion ya en ejecucion', sync: syncJob });
  runCatalogSync();
  res.json({ ok: true, started: true, message: 'Sincronizacion iniciada en segundo plano', sync: syncJob });
});
app.get('/productos/sync/status', (req, res) => res.json({ ok: true, sync: syncJob }));
app.get('/categorias', async (req, res, next) => {
  try {
    const result = await remember('categorias:wc', 3600, async () => {
      const { data } = await wc.get('/products/categories', { params: { per_page: 100, hide_empty: false } });
      return data.map(c => ({ id: c.id, name: c.name, slug: c.slug, count: c.count })).filter(c => c.name).sort((a,b)=>a.name.localeCompare(b.name,'es'));
    }, req.query.refresh === 'true');
    res.json({ categorias: result.value, cached: result.cached });
  } catch (error) { next(error); }
});

app.get('/payment-methods', async (req, res, next) => {
  try {
    const result = await remember('payment_gateways:wc', 3600, async () => {
      const { data } = await wc.get('/payment_gateways');
      return (data || []).filter((g) => g.enabled).map((g) => ({ id: g.id, title: g.title || g.method_title || g.id, description: cleanHtml(g.description || ''), enabled: g.enabled }));
    }, req.query.refresh === 'true');
    res.json({ methods: result.value, cached: result.cached });
  } catch (error) { next(error); }
});

app.get('/pedidos/buscar', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const email = String(req.query.email || '').trim();
    const params = { per_page: Math.min(Number(req.query.limit || 20), 50), orderby: 'date', order: 'desc' };
    if (q) params.search = q;
    if (email && !q) params.search = email;
    const { data } = await wc.get('/orders', { params });
    res.json({ pedidos: data.map((order) => ({ id: order.id, numero: order.number, estado: order.status, total: order.total, fecha: order.date_created, metodo_pago: order.payment_method_title, email: order.billing?.email || '', nombre: `${order.billing?.first_name || ''} ${order.billing?.last_name || ''}`.trim(), productos: order.line_items?.map((i) => ({ nombre: i.name, cantidad: i.quantity, total: i.total, sku: i.sku })) || [] })) });
  } catch (error) { next(error); }
});

app.get('/pedidos/:id', async (req, res, next) => {
  try {
    const { data: order } = await wc.get(`/orders/${Number(req.params.id)}`);
    res.json({ pedido: order });
  } catch (error) { next(error); }
});

app.post('/pedidos/:id/link-pago-woo', async (req, res, next) => {
  try {
    const orderId = Number(req.params.id);
    const gatewayId = preferredWooPaymentGateway(req.body || {});
    const gatewayTitle = req.body?.payment_method_title || req.body?.gateway_title || process.env.WOO_FLOW_GATEWAY_TITLE || 'Flow - Webpay / Multicaja';

    let order;
    if (gatewayId) {
      const updatePayload = { payment_method: gatewayId, payment_method_title: gatewayTitle, status: req.body?.status || 'pending' };
      const updated = await wc.put(`/orders/${orderId}`, updatePayload);
      order = updated.data;
    } else {
      const current = await wc.get(`/orders/${orderId}`);
      order = current.data;
    }

    const url = getOrderPayUrl(order);
    if (!url) return res.status(502).json({ error: 'WooCommerce no retorno link de pago. Verifique que el pedido tenga order_key y que Checkout esté activo.' });
    res.json({ ok: true, provider: 'woocommerce', gateway_id: gatewayId, url, pedido: { id: order.id, numero: order.number, estado: order.status, total: order.total, moneda: order.currency || 'CLP', payment_method: order.payment_method, payment_method_title: order.payment_method_title } });
  } catch (error) { next(error); }
});

app.get('/pedidos/:id/link-pago-woo', async (req, res, next) => {
  try {
    const { data: order } = await wc.get(`/orders/${Number(req.params.id)}`);
    const url = getOrderPayUrl(order);
    if (!url) return res.status(502).json({ error: 'WooCommerce no retorno link de pago.' });
    res.json({ ok: true, provider: 'woocommerce', url, pedido: { id: order.id, numero: order.number, estado: order.status, total: order.total, moneda: order.currency || 'CLP', payment_method: order.payment_method, payment_method_title: order.payment_method_title } });
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
      await validateStock(body.line_items);
      allowed.line_items = body.line_items.map((i) => ({ product_id: Number(i.product_id), variation_id: i.variation_id ? Number(i.variation_id) : undefined, quantity: Number(i.quantity) }));
    }
    if (body.rut && validateRut(body.rut)) allowed.meta_data = buildRutMeta(formatRut(body.rut));
    const { data: order } = await wc.put(`/orders/${Number(req.params.id)}`, allowed);
    await cacheDelPrefix('cliente:');
    res.json({ ok: true, pedido: { id: order.id, numero: order.number, estado: order.status, total: order.total, moneda: order.currency || 'CLP' } });
  } catch (error) { next(error); }
});

app.post('/pedidos/:id/cancelar', async (req, res, next) => {
  try {
    const { data: order } = await wc.put(`/orders/${Number(req.params.id)}`, { status: 'cancelled', customer_note: req.body?.customer_note || undefined });
    await cacheDelPrefix('cliente:');
    res.json({ ok: true, pedido: { id: order.id, numero: order.number, estado: order.status, total: order.total, moneda: order.currency || 'CLP' } });
  } catch (error) { next(error); }
});

app.delete('/pedidos/:id', async (req, res, next) => {
  try {
    const force = req.query.force === 'true';
    const { data: order } = await wc.delete(`/orders/${Number(req.params.id)}`, { params: { force } });
    await cacheDelPrefix('cliente:');
    res.json({ ok: true, deleted: true, force, pedido: { id: order.id, numero: order.number || order.id, estado: order.status || 'trash' } });
  } catch (error) { next(error); }
});

app.post('/crear-pedido', async (req, res, next) => {
  try {
    const payload = normalizeCheckout(req.body);
    await validateStock(payload.line_items);
    const { data: order } = await wc.post('/orders', payload);
    res.status(201).json({ ok: true, pedido: { id: order.id, numero: order.number, estado: order.status, total: order.total, moneda: order.currency || 'CLP', checkout_url: getOrderPayUrl(order), payment_method: order.payment_method, payment_method_title: order.payment_method_title } });
  } catch (error) { next(error); }
});
app.post('/pagar', async (req, res, next) => {
  try {
    const { orderId, amount, subject, email, mode } = req.body;
    if (!orderId) return res.status(400).json({ error: 'orderId es obligatorio' });

    if (mode === 'woocommerce' || process.env.PAYMENT_LINK_PROVIDER === 'woocommerce') {
      const gatewayId = preferredWooPaymentGateway(req.body || {});
      const gatewayTitle = req.body?.payment_method_title || req.body?.gateway_title || process.env.WOO_FLOW_GATEWAY_TITLE || 'Flow - Webpay / Multicaja';
      const { data: order } = await wc.put(`/orders/${Number(orderId)}`, { payment_method: gatewayId, payment_method_title: gatewayTitle, status: 'pending' });
      const url = getOrderPayUrl(order);
      if (!url) return res.status(502).json({ error: 'WooCommerce no retorno link de pago.' });
      return res.json({ ok: true, provider: 'woocommerce', url, pedido: { id: order.id, numero: order.number, total: order.total, moneda: order.currency || 'CLP', payment_method: order.payment_method, payment_method_title: order.payment_method_title } });
    }

    if (!process.env.FLOW_API_KEY || !process.env.FLOW_SECRET_KEY) return res.status(400).json({ error: 'Faltan credenciales Flow' });
    if (!amount || !email) return res.status(400).json({ error: 'amount y email son obligatorios para Flow directo' });
    const publicBase = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    const urlConfirmation = process.env.FLOW_URL_CONFIRMATION || `${publicBase}/flow/confirmacion`;
    const urlReturn = process.env.FLOW_URL_RETURN || `${publicBase}/flow/retorno`;
    if (!/^https:\/\/[^\s]+/i.test(urlConfirmation) || !/^https:\/\/[^\s]+/i.test(urlReturn)) return res.status(400).json({ error: 'FLOW_URL_CONFIRMATION y FLOW_URL_RETURN deben ser URLs publicas HTTPS validas.' });
    const params = { apiKey: process.env.FLOW_API_KEY, commerceOrder: `${orderId}-${Date.now()}`, subject: subject || `Pedido WooCommerce #${orderId}`, currency: 'CLP', amount: Math.round(Number(amount)), email, paymentMethod: process.env.FLOW_PAYMENT_METHOD || '9', urlConfirmation, urlReturn, optional: JSON.stringify({ orderId }) };
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
      img ? `Imagen: ${img}` : '',
      `Producto: ${product.nombre}`,
      attrs ? `Variacion: ${attrs}` : '',
      `SKU: ${variation?.sku || product.sku || 'N/D'}`,
      `Precio: $${Number(price || 0).toLocaleString('es-CL')} CLP`,
      `Cantidad sugerida: ${quantity}`,
      product.permalink ? `Link: ${product.permalink}` : ''
    ].filter(Boolean).join('\n');
    await client.post(`/conversations/${conversationId}/messages`, {
      content,
      message_type: 'outgoing',
      private: Boolean(privateNote),
      content_type: 'text',
      content_attributes: { image_url: img || undefined, product_id: product.id, variation_id: variation?.id || undefined, sku: variation?.sku || product.sku || '', price: Number(price || 0) }
    });
    if (autoLabels) {
      const existing = await getConversationLabels(client, conversationId);
      await client.post(`/conversations/${conversationId}/labels`, { labels: Array.from(new Set([...existing, 'rivaida_interesado', 'rivaida_producto_enviado'])) });
    }
    const attrsPayload = { rivaida_estado: 'producto_enviado', rivaida_ultimo_producto: product.nombre, rivaida_ultimo_sku: variation?.sku || product.sku || '', rivaida_ultima_imagen: img || '', ...custom_attributes };
    try { await client.post(`/conversations/${conversationId}/custom_attributes`, { custom_attributes: attrsPayload }); } catch (e) { console.warn('[Chatwoot atributos envio]', e.response?.data || e.message); }
    res.json({ ok: true, message: 'Producto enviado a Chatwoot', image_sent_as_url: Boolean(img), imageUrl: img });
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
    const aiUrl = process.env.AI_RECOMMENDATION_WEBHOOK_URL || '';
    if (aiUrl) {
      try { const { data } = await axios.post(aiUrl, { ...req.body, base_recommendations: recommendations }, { timeout: Number(process.env.AI_TIMEOUT_MS || 15000) }); recommendations = { ...recommendations, ...(data || {}), ai: true }; }
      catch (e) { recommendations.ai_error = e.message; }
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
  res.status(status).json({ error: formatWooError(error), status });
});
const server = app.listen(PORT, '0.0.0.0', () => console.log(`Panel v7.3 activo en puerto ${PORT}`));
process.on('SIGTERM', () => { console.log('SIGTERM recibido, cerrando servidor'); server.close(() => process.exit(0)); });
