require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const app = express();
const PORT = Number(process.env.PORT || 3000);

const requiredEnv = [
  'PANEL_USER',
  'PANEL_PASSWORD',
  'WC_URL',
  'WC_KEY',
  'WC_SECRET',
  'FLOW_API_URL',
  'FLOW_API_KEY',
  'FLOW_SECRET_KEY',
  'CHATWOOT_URL',
  'CHATWOOT_API_KEY',
  'CHATWOOT_ACCOUNT_ID'
];

const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length) {
  console.warn(`[WARN] Variables faltantes en .env: ${missingEnv.join(', ')}`);
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined'));
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Origen no permitido por CORS'));
    },
    credentials: true
  })
);

function safeCompare(a = '', b = '') {
  const bufferA = Buffer.from(String(a));
  const bufferB = Buffer.from(String(b));
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

function basicAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Chatwoot WooCommerce Panel"');
    return res.status(401).json({ error: 'Credenciales requeridas' });
  }

  let user = '';
  let pass = '';
  try {
    const decoded = Buffer.from(auth.replace('Basic ', ''), 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    user = decoded.slice(0, separatorIndex);
    pass = decoded.slice(separatorIndex + 1);
  } catch (error) {
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }

  const validUser = safeCompare(user, process.env.PANEL_USER);
  const validPass = safeCompare(pass, process.env.PANEL_PASSWORD);
  if (!validUser || !validPass) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }

  req.panelUser = user;
  return next();
}

app.use(basicAuth);
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

const wc = axios.create({
  baseURL: `${String(process.env.WC_URL).replace(/\/$/, '')}/wp-json/wc/v3`,
  auth: {
    username: process.env.WC_KEY,
    password: process.env.WC_SECRET
  },
  timeout: 20000
});

const chatwoot = axios.create({
  baseURL: `${String(process.env.CHATWOOT_URL).replace(/\/$/, '')}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}`,
  headers: {
    api_access_token: process.env.CHATWOOT_API_KEY,
    'Content-Type': 'application/json'
  },
  timeout: 20000
});

function formatWooError(error) {
  const response = error.response;
  if (!response) return error.message;
  return response.data?.message || response.data?.error || `Error HTTP ${response.status}`;
}

function flowSign(params) {
  const sortedKeys = Object.keys(params).sort();
  const toSign = sortedKeys.map((key) => `${key}${params[key]}`).join('');
  return crypto.createHmac('sha256', process.env.FLOW_SECRET_KEY).update(toSign).digest('hex');
}

function buildFlowPayload(params) {
  const payload = { ...params };
  payload.s = flowSign(payload);
  return new URLSearchParams(payload).toString();
}

async function validateStock(lineItems = []) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    const error = new Error('Debe incluir al menos un producto');
    error.status = 400;
    throw error;
  }

  const validation = [];
  for (const item of lineItems) {
    const productId = Number(item.product_id);
    const quantity = Number(item.quantity || 0);

    if (!productId || quantity <= 0) {
      const error = new Error('Producto o cantidad inválida');
      error.status = 400;
      throw error;
    }

    const { data: product } = await wc.get(`/products/${productId}`);
    const stockQuantity = product.stock_quantity;
    const managesStock = Boolean(product.manage_stock);
    const inStock = product.stock_status === 'instock';

    if (!inStock) {
      const error = new Error(`Sin stock disponible para ${product.name}`);
      error.status = 409;
      throw error;
    }

    if (managesStock && stockQuantity !== null && quantity > Number(stockQuantity)) {
      const error = new Error(`Stock insuficiente para ${product.name}. Disponible: ${stockQuantity}`);
      error.status = 409;
      throw error;
    }

    validation.push({ product_id: productId, quantity, name: product.name, price: product.price });
  }

  return validation;
}

function normalizeCheckout(body) {
  const required = ['billing', 'shipping', 'line_items', 'payment_method', 'payment_method_title'];
  for (const field of required) {
    if (!body[field]) {
      const error = new Error(`Falta el campo requerido: ${field}`);
      error.status = 400;
      throw error;
    }
  }

  return {
    payment_method: body.payment_method,
    payment_method_title: body.payment_method_title,
    set_paid: false,
    status: body.status || 'pending',
    billing: body.billing,
    shipping: body.shipping,
    line_items: body.line_items.map((item) => ({
      product_id: Number(item.product_id),
      variation_id: item.variation_id ? Number(item.variation_id) : undefined,
      quantity: Number(item.quantity)
    })),
    shipping_lines: body.shipping_lines || [],
    customer_note: body.customer_note || '',
    meta_data: [
      ...(body.meta_data || []),
      { key: '_origen_pedido', value: 'Chatwoot WooCommerce Flow Panel' }
    ]
  };
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'chatwoot-woocommerce-flow-panel' });
});

app.get('/cliente', async (req, res, next) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Debe indicar email del cliente' });

    const { data: customers } = await wc.get('/customers', { params: { email, per_page: 1 } });
    const customer = customers[0] || null;

    const { data: orders } = await wc.get('/orders', {
      params: {
        search: email,
        per_page: 20,
        orderby: 'date',
        order: 'desc'
      }
    });

    res.json({
      cliente: customer
        ? {
            id: customer.id,
            nombre: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
            email: customer.email,
            telefono: customer.billing?.phone || '',
            direccion: customer.billing || {}
          }
        : { nombre: '', email, telefono: '', direccion: {} },
      pedidos: orders.map((order) => ({
        id: order.id,
        numero: order.number,
        estado: order.status,
        total: order.total,
        moneda: order.currency || 'CLP',
        fecha: order.date_created,
        metodo_pago: order.payment_method_title,
        productos: order.line_items?.map((item) => ({ nombre: item.name, cantidad: item.quantity, total: item.total })) || []
      }))
    });
  } catch (error) {
    next(error);
  }
});

app.get('/productos', async (req, res, next) => {
  try {
    const productos = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const { data } = await wc.get('/products', {
        params: { per_page: perPage, page, status: 'publish' }
      });
      productos.push(...data);
      if (data.length < perPage) break;
      page += 1;
    }

    res.json({
      productos: productos.map((product) => ({
        id: product.id,
        nombre: product.name,
        sku: product.sku || 'Sin SKU',
        precio: product.price || product.regular_price || '0',
        moneda: 'CLP',
        stock: product.stock_quantity,
        stock_status: product.stock_status,
        manage_stock: product.manage_stock,
        imagen: product.images?.[0]?.src || '',
        permalink: product.permalink
      }))
    });
  } catch (error) {
    next(error);
  }
});

app.post('/crear-pedido', async (req, res, next) => {
  try {
    const orderPayload = normalizeCheckout(req.body);
    await validateStock(orderPayload.line_items);

    const { data: order } = await wc.post('/orders', orderPayload);
    res.status(201).json({
      ok: true,
      pedido: {
        id: order.id,
        numero: order.number,
        estado: order.status,
        total: order.total,
        moneda: order.currency || 'CLP',
        checkout_url: order.payment_url || order.checkout_payment_url || ''
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post('/pagar', async (req, res, next) => {
  try {
    const { orderId, amount, subject, email } = req.body;
    if (!orderId || !amount || !email) {
      return res.status(400).json({ error: 'orderId, amount y email son obligatorios' });
    }

    const commerceOrder = `${orderId}-${Date.now()}`;
    const publicBase = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    const params = {
      apiKey: process.env.FLOW_API_KEY,
      commerceOrder,
      subject: subject || `Pedido WooCommerce #${orderId}`,
      currency: process.env.FLOW_CURRENCY || 'CLP',
      amount: Math.round(Number(amount)),
      email,
      paymentMethod: process.env.FLOW_PAYMENT_METHOD || '9',
      urlConfirmation: process.env.FLOW_URL_CONFIRMATION || `${publicBase}/flow/confirmacion`,
      urlReturn: process.env.FLOW_URL_RETURN || `${publicBase}/flow/retorno`,
      optional: JSON.stringify({ orderId })
    };

    const body = buildFlowPayload(params);
    const { data } = await axios.post(`${String(process.env.FLOW_API_URL).replace(/\/$/, '')}/payment/create`, body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 20000
    });

    if (!data?.url || !data?.token) {
      return res.status(502).json({ error: 'Flow no retornó URL/token de pago', detalle: data });
    }

    res.json({
      ok: true,
      url: `${data.url}?token=${data.token}`,
      token: data.token,
      flow_order: data.flowOrder || null,
      commerce_order: commerceOrder
    });
  } catch (error) {
    next(error);
  }
});

app.post('/chatwoot/enviar-producto', async (req, res, next) => {
  try {
    const { conversationId, product, quantity = 1 } = req.body;
    if (!conversationId || !product?.nombre) {
      return res.status(400).json({ error: 'conversationId y product son obligatorios' });
    }

    const content = [
      `Producto seleccionado desde panel: ${product.nombre}`,
      `SKU: ${product.sku || 'Sin SKU'}`,
      `Precio: $${Number(product.precio || 0).toLocaleString('es-CL')} CLP`,
      `Cantidad: ${quantity}`,
      product.permalink ? `Link: ${product.permalink}` : ''
    ]
      .filter(Boolean)
      .join('\n');

    const { data } = await chatwoot.post(`/conversations/${conversationId}/messages`, {
      content,
      message_type: 'outgoing',
      private: false
    });

    res.json({ ok: true, message: data });
  } catch (error) {
    next(error);
  }
});

app.post('/flow/confirmacion', async (req, res) => {
  // Flow enviará token a este endpoint. Aquí puedes consultar payment/getStatus y actualizar el pedido en WooCommerce.
  console.log('Confirmacion Flow:', req.body);
  res.sendStatus(200);
});

app.get('/flow/retorno', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'flow-retorno.html'));
});

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint no encontrado' });
});

app.use((error, req, res, next) => {
  const status = error.status || error.response?.status || 500;
  const message = formatWooError(error);
  console.error('[ERROR]', message, error.response?.data || '');
  res.status(status).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`Panel activo en puerto ${PORT}`);
});
