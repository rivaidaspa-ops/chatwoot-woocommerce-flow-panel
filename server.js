require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const WC_URL = String(process.env.WC_URL || '').replace(/\/$/, '');
const FLOW_API_URL = String(process.env.FLOW_API_URL || 'https://sandbox.flow.cl/api').replace(/\/$/, '');
const CHATWOOT_URL = String(process.env.CHATWOOT_URL || '').replace(/\/$/, '');

const requiredEnv = ['PANEL_USER','PANEL_PASSWORD','WC_URL','WC_KEY','WC_SECRET'];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length) console.warn(`[WARN] Variables faltantes: ${missingEnv.join(', ')}`);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '3mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined'));
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Origen no permitido por CORS'));
  },
  credentials: true
}));

function safeCompare(a = '', b = '') {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function basicAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Chatwoot WooCommerce Panel"');
    return res.status(401).json({ error: 'Credenciales requeridas' });
  }
  try {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const [user, ...rest] = decoded.split(':');
    const pass = rest.join(':');
    if (!safeCompare(user, process.env.PANEL_USER) || !safeCompare(pass, process.env.PANEL_PASSWORD)) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    req.panelUser = user;
    return next();
  } catch (_) {
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }
}

app.use(basicAuth);
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

const wc = axios.create({
  baseURL: `${WC_URL}/wp-json/wc/v3`,
  auth: { username: process.env.WC_KEY, password: process.env.WC_SECRET },
  timeout: 30000
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

function normalizeText(value = '') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
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

function loadRegiones() {
  const jsonPath = path.join(__dirname, 'data', 'regiones-comunas-chile.json');
  if (!fs.existsSync(jsonPath)) return [];
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}
const comunas = loadComunas();
const regionesBase = loadRegiones();
const comunaMap = new Map(comunas.map((x) => [normalizeText(x.comuna), x.postcode]));
function getPostcode(comuna, fallback = '8320000') { return comunaMap.get(normalizeText(comuna)) || fallback; }
const regiones = regionesBase.map((r) => ({
  ...r,
  comunas: (r.comunas || []).map((nombre) => ({ comuna: nombre, postcode: getPostcode(nombre, process.env.DEFAULT_POSTCODE || '8320000') }))
}));
const comunaRegionMap = new Map();
for (const region of regiones) for (const c of region.comunas) comunaRegionMap.set(normalizeText(c.comuna), { codigo: region.codigo, region: region.region });
const memoryCache = new Map();
const CACHE_TTL_PRODUCTS = Number(process.env.CACHE_TTL_PRODUCTS_MS || 300000);
const CACHE_TTL_CLIENTE = Number(process.env.CACHE_TTL_CLIENTE_MS || 60000);
function cacheGet(key) {
  const item = memoryCache.get(key);
  if (!item || item.expiresAt < Date.now()) { memoryCache.delete(key); return null; }
  return item.value;
}
function cacheSet(key, value, ttlMs) { memoryCache.set(key, { value, expiresAt: Date.now() + ttlMs, createdAt: Date.now() }); return value; }
async function remember(key, ttlMs, factory, force = false) {
  if (!force) { const cached = cacheGet(key); if (cached) return { value: cached, cached: true }; }
  const value = await factory();
  cacheSet(key, value, ttlMs);
  return { value, cached: false };
}


function validateRut(rut = '') {
  const clean = String(rut).replace(/\./g, '').replace(/-/g, '').trim().toUpperCase();
  if (!/^[0-9]+[0-9K]$/.test(clean)) return false;
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  let sum = 0, multiplier = 2;
  for (let i = body.length - 1; i >= 0; i -= 1) {
    sum += Number(body[i]) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }
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

function extractMeta(metaData = []) {
  const result = {};
  for (const m of metaData || []) {
    const key = String(m.key || '').toLowerCase();
    if (key.includes('alids') || key.includes('alidropship') || key.includes('ali') || key.includes('rut') || key.includes('tracking') || key.includes('supplier')) {
      result[m.key] = m.value;
    }
  }
  return result;
}

function normalizeProduct(product, variations = []) {
  return {
    id: product.id,
    type: product.type,
    nombre: product.name,
    descripcion_corta: product.short_description?.replace(/<[^>]*>/g, '').trim() || '',
    sku: product.sku || 'Sin SKU',
    precio: product.price || product.regular_price || '0',
    precio_regular: product.regular_price || '',
    precio_oferta: product.sale_price || '',
    moneda: 'CLP',
    stock: product.stock_quantity,
    stock_status: product.stock_status,
    manage_stock: product.manage_stock,
    imagen: product.images?.[0]?.src || '',
    imagenes: product.images?.map((img) => ({ id: img.id, src: img.src, alt: img.alt })) || [],
    permalink: product.permalink,
    categorias: product.categories?.map((c) => c.name) || [],
    etiquetas: product.tags?.map((t) => t.name) || [],
    atributos: product.attributes?.map((a) => ({ id: a.id, name: a.name, options: a.options || [], variation: a.variation })) || [],
    meta: extractMeta(product.meta_data),
    variations
  };
}

async function getAllProducts() {
  const productos = [];
  let page = 1;
  while (true) {
    const { data } = await wc.get('/products', { params: { per_page: 100, page, status: 'publish' } });
    productos.push(...data);
    if (data.length < 100) break;
    page += 1;
  }
  return productos;
}

async function getVariations(productId) {
  const variations = [];
  let page = 1;
  while (true) {
    const { data } = await wc.get(`/products/${productId}/variations`, { params: { per_page: 100, page } });
    variations.push(...data);
    if (data.length < 100) break;
    page += 1;
  }
  return variations.map((v) => ({
    id: v.id,
    sku: v.sku || '',
    precio: v.price || v.regular_price || '0',
    precio_regular: v.regular_price || '',
    precio_oferta: v.sale_price || '',
    stock: v.stock_quantity,
    stock_status: v.stock_status,
    manage_stock: v.manage_stock,
    imagen: v.image?.src || '',
    atributos: v.attributes?.map((a) => ({ name: a.name, option: a.option })) || [],
    meta: extractMeta(v.meta_data)
  }));
}

async function validateStock(lineItems = []) {
  if (!Array.isArray(lineItems) || !lineItems.length) { const e = new Error('Debe incluir al menos un producto'); e.status = 400; throw e; }
  for (const item of lineItems) {
    const productId = Number(item.product_id);
    const variationId = Number(item.variation_id || 0);
    const qty = Number(item.quantity || 0);
    if (!productId || qty <= 0) { const e = new Error('Producto o cantidad inválida'); e.status = 400; throw e; }
    const endpoint = variationId ? `/products/${productId}/variations/${variationId}` : `/products/${productId}`;
    const { data: product } = await wc.get(endpoint);
    if (product.stock_status !== 'instock') { const e = new Error(`Sin stock disponible para ${product.name || 'variación'}`); e.status = 409; throw e; }
    if (product.manage_stock && product.stock_quantity !== null && qty > Number(product.stock_quantity)) {
      const e = new Error(`Stock insuficiente. Disponible: ${product.stock_quantity}`); e.status = 409; throw e;
    }
  }
}

function normalizeCheckout(body) {
  const rut = String(body.rut || body.billing?.rut || '').trim();
  if (process.env.REQUIRE_RUT !== 'false' && !validateRut(rut)) { const e = new Error('RUT chileno inválido o faltante'); e.status = 400; throw e; }
  const billing = { ...(body.billing || {}) };
  const shipping = { ...(body.shipping || billing) };
  const comuna = body.comuna || billing.city || shipping.city;
  const postcode = body.postcode || getPostcode(comuna, process.env.DEFAULT_POSTCODE || '8320000');
  billing.country = 'CL'; shipping.country = 'CL';
  const region = body.region || body.region_codigo || billing.state || shipping.state || comunaRegionMap.get(normalizeText(comuna || ''))?.codigo || '';
  billing.state = region; shipping.state = region;
  billing.postcode = postcode; shipping.postcode = postcode;
  billing.city = comuna || billing.city; shipping.city = comuna || shipping.city;
  return {
    payment_method: body.payment_method || 'flow',
    payment_method_title: body.payment_method_title || 'Flow - Webpay / Multicaja',
    set_paid: false,
    status: body.status || 'pending',
    billing,
    shipping,
    line_items: (body.line_items || []).map((i) => ({ product_id: Number(i.product_id), variation_id: i.variation_id ? Number(i.variation_id) : undefined, quantity: Number(i.quantity) })),
    shipping_lines: body.shipping_lines || [],
    customer_note: body.customer_note || '',
    meta_data: [
      ...(body.meta_data || []),
      { key: '_billing_rut', value: formatRut(rut) },
      { key: 'rut', value: formatRut(rut) },
      { key: '_billing_region', value: region || '' },
      { key: '_shipping_region', value: region || '' },
      { key: '_billing_comuna', value: comuna || '' },
      { key: '_shipping_comuna', value: comuna || '' },
      { key: '_origen_pedido', value: 'Chatwoot WooCommerce Flow Panel' }
    ]
  };
}

app.get('/health', (req, res) => res.json({ ok: true, service: 'chatwoot-woocommerce-flow-panel-pro-v2', cache_items: memoryCache.size }));
app.get('/comunas', (req, res) => res.json({ comunas }));
app.get('/regiones', (req, res) => res.json({ regiones }));
app.get('/cache/status', (req, res) => res.json({ ok: true, items: memoryCache.size, keys: Array.from(memoryCache.keys()) }));
app.post('/cache/clear', (req, res) => { memoryCache.clear(); res.json({ ok: true, message: 'Cache limpiado' }); });
app.get('/validar-rut', (req, res) => res.json({ rut: formatRut(req.query.rut || ''), valido: validateRut(req.query.rut || '') }));

app.get('/cliente', async (req, res, next) => {
  try {
    const email = String(req.query.email || req.query.email_cliente || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Debe indicar email del cliente' });
    const force = req.query.refresh === 'true';
    const result = await remember(`cliente:${email}`, CACHE_TTL_CLIENTE, async () => {
      const { data: customers } = await wc.get('/customers', { params: { email, per_page: 1 } });
      const customer = customers[0] || null;
      const { data: orders } = await wc.get('/orders', { params: { search: email, per_page: 30, orderby: 'date', order: 'desc' } });
      const billing = customer?.billing || {};
      const rutMeta = customer?.meta_data?.find((m) => String(m.key).toLowerCase().includes('rut'))?.value || '';
      const regionFound = comunaRegionMap.get(normalizeText(billing.city || '')) || null;
      return {
        cliente: customer ? {
          id: customer.id,
          nombre: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
          email: customer.email,
          telefono: billing.phone || '',
          rut: rutMeta || billing.rut || '',
          direccion: { ...billing, region_codigo: regionFound?.codigo || billing.state || '', region_nombre: regionFound?.region || billing.state || '' },
          meta: extractMeta(customer.meta_data)
        } : { nombre: '', email, telefono: '', rut: '', direccion: {} },
        pedidos: orders.map((order) => ({
          id: order.id, numero: order.number, estado: order.status, total: order.total, moneda: order.currency || 'CLP', fecha: order.date_created,
          metodo_pago: order.payment_method_title, rut: order.meta_data?.find((m) => String(m.key).toLowerCase().includes('rut'))?.value || '',
          productos: order.line_items?.map((item) => ({ nombre: item.name, cantidad: item.quantity, total: item.total, sku: item.sku, meta: item.meta_data })) || [],
          meta: extractMeta(order.meta_data)
        }))
      };
    }, force);
    res.json({ ...result.value, cached: result.cached });
  } catch (error) { next(error); }
});

app.get('/productos', async (req, res, next) => {
  try {
    const includeVariations = req.query.variations !== 'false';
    const force = req.query.refresh === 'true';
    const cacheKey = `productos:${includeVariations ? 'with-variations' : 'simple'}`;
    const result = await remember(cacheKey, CACHE_TTL_PRODUCTS, async () => {
      const products = await getAllProducts();
      const normalized = [];
      for (const p of products) {
        const variations = includeVariations && p.type === 'variable' ? await getVariations(p.id) : [];
        normalized.push(normalizeProduct(p, variations));
      }
      return normalized;
    }, force);
    res.json({ productos: result.value, cached: result.cached, cache_ttl_ms: CACHE_TTL_PRODUCTS });
  } catch (error) { next(error); }
});

app.post('/crear-pedido', async (req, res, next) => {
  try {
    const payload = normalizeCheckout(req.body);
    await validateStock(payload.line_items);
    const { data: order } = await wc.post('/orders', payload);
    res.status(201).json({ ok: true, pedido: { id: order.id, numero: order.number, estado: order.status, total: order.total, moneda: order.currency || 'CLP', checkout_url: order.payment_url || order.checkout_payment_url || '' } });
  } catch (error) { next(error); }
});

app.post('/pagar', async (req, res, next) => {
  try {
    if (!process.env.FLOW_API_KEY || !process.env.FLOW_SECRET_KEY) return res.status(400).json({ error: 'Faltan credenciales Flow' });
    const { orderId, amount, subject, email } = req.body;
    if (!orderId || !amount || !email) return res.status(400).json({ error: 'orderId, amount y email son obligatorios' });
    const publicBase = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    const params = { apiKey: process.env.FLOW_API_KEY, commerceOrder: `${orderId}-${Date.now()}`, subject: subject || `Pedido WooCommerce #${orderId}`, currency: 'CLP', amount: Math.round(Number(amount)), email, paymentMethod: process.env.FLOW_PAYMENT_METHOD || '9', urlConfirmation: process.env.FLOW_URL_CONFIRMATION || `${publicBase}/flow/confirmacion`, urlReturn: process.env.FLOW_URL_RETURN || `${publicBase}/flow/retorno`, optional: JSON.stringify({ orderId }) };
    const { data } = await axios.post(`${FLOW_API_URL}/payment/create`, buildFlowPayload(params), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000 });
    if (!data?.url || !data?.token) return res.status(502).json({ error: 'Flow no retornó URL/token', detalle: data });
    res.json({ ok: true, url: `${data.url}?token=${data.token}`, token: data.token, flow_order: data.flowOrder || null });
  } catch (error) { next(error); }
});

app.post('/chatwoot/enviar-producto', async (req, res, next) => {
  try {
    const client = chatwootClient();
    if (!client) return res.status(400).json({ error: 'Faltan credenciales Chatwoot' });
    const { conversationId, product, variation, quantity = 1, privateNote = false } = req.body;
    if (!conversationId || !product?.nombre) return res.status(400).json({ error: 'conversationId y product son obligatorios' });
    const attrs = variation?.atributos?.map((a) => `${a.name}: ${a.option}`).join(', ') || product.atributos?.filter((a) => !a.variation).map((a) => `${a.name}: ${a.options?.join('/')}`).join(', ');
    const content = [`Producto seleccionado: ${product.nombre}`, variation ? `Variación: ${attrs || variation.sku || variation.id}` : attrs ? `Atributos: ${attrs}` : '', `SKU: ${variation?.sku || product.sku || 'Sin SKU'}`, `Precio: $${Number(variation?.precio || product.precio || 0).toLocaleString('es-CL')} CLP`, `Cantidad: ${quantity}`, product.permalink ? `Link: ${product.permalink}` : ''].filter(Boolean).join('\n');
    const { data } = await client.post(`/conversations/${conversationId}/messages`, { content, message_type: 'outgoing', private: Boolean(privateNote) });
    res.json({ ok: true, message: data });
  } catch (error) { next(error); }
});

app.post('/chatwoot/etiquetas', async (req, res, next) => {
  try {
    const client = chatwootClient();
    if (!client) return res.status(400).json({ error: 'Faltan credenciales Chatwoot' });
    const { conversationId, labels = [] } = req.body;
    if (!conversationId) return res.status(400).json({ error: 'conversationId obligatorio' });
    const { data } = await client.post(`/conversations/${conversationId}/labels`, { labels });
    res.json({ ok: true, labels: data });
  } catch (error) { next(error); }
});

app.post('/flow/confirmacion', (req, res) => { console.log('Confirmacion Flow:', req.body); res.sendStatus(200); });
app.get('/flow/retorno', (req, res) => res.sendFile(path.join(__dirname, 'public', 'flow-retorno.html')));
app.use((req, res) => res.status(404).json({ error: 'Endpoint no encontrado' }));
app.use((error, req, res, next) => { const status = error.status || error.response?.status || 500; const message = formatWooError(error); console.error('[ERROR]', message, error.response?.data || ''); res.status(status).json({ error: message }); });
app.listen(PORT, () => console.log(`Panel robusto activo en puerto ${PORT}`));
