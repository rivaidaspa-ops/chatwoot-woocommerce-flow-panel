const state = {
  auth: localStorage.getItem('panelAuth') || '',
  cliente: null,
  pedidos: [],
  productos: [],
  cart: [],
  lastOrder: null
};

const $ = (id) => document.getElementById(id);
const money = (value) => `$${Number(value || 0).toLocaleString('es-CL')} CLP`;

function authHeaders() {
  return { Authorization: `Basic ${state.auth}`, 'Content-Type': 'application/json' };
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error de servidor');
  return data;
}

function showApp() {
  $('loginScreen').classList.add('hidden');
  $('app').classList.remove('hidden');
}

function showLogin() {
  $('loginScreen').classList.remove('hidden');
  $('app').classList.add('hidden');
}

async function testAuth() {
  try {
    await api('/health');
    showApp();
    readChatwootParams();
  } catch (_) {
    localStorage.removeItem('panelAuth');
    state.auth = '';
    showLogin();
  }
}

function readChatwootParams() {
  const params = new URLSearchParams(window.location.search);
  const email = params.get('email') || params.get('email_cliente') || '';
  const conversationId = params.get('conversation_id') || params.get('conversationId') || '';
  if (email) $('customerEmail').value = email;
  if (conversationId) $('conversationId').value = conversationId;
  if (email) loadPanel();
}

function renderClient() {
  const c = state.cliente;
  if (!c) return;
  const d = c.direccion || {};
  $('clientInfo').innerHTML = `
    <div class="client-row"><strong>Nombre</strong><span>${c.nombre || 'No registrado'}</span></div>
    <div class="client-row"><strong>Email</strong><span>${c.email || ''}</span></div>
    <div class="client-row"><strong>Teléfono</strong><span>${c.telefono || d.phone || ''}</span></div>
    <div class="client-row"><strong>Dirección</strong><span>${[d.address_1, d.city, d.state, d.country].filter(Boolean).join(', ') || 'Sin dirección'}</span></div>
  `;

  $('billingFirstName').value = d.first_name || c.nombre?.split(' ')[0] || '';
  $('billingLastName').value = d.last_name || c.nombre?.split(' ').slice(1).join(' ') || '';
  $('billingPhone').value = c.telefono || d.phone || '';
  $('billingAddress').value = d.address_1 || '';
  $('billingCity').value = d.city || '';
  $('billingRegion').value = d.state || '';
}

function renderOrders() {
  if (!state.pedidos.length) {
    $('ordersList').innerHTML = '<span class="muted">Este cliente no registra pedidos.</span>';
    return;
  }
  $('ordersList').innerHTML = state.pedidos.map((order) => `
    <article class="order-card">
      <div class="order-head">
        <div>
          <h3>Pedido #${order.numero}</h3>
          <p class="muted">${new Date(order.fecha).toLocaleDateString('es-CL')} · ${order.metodo_pago || 'Sin método'}</p>
        </div>
        <span class="badge ${order.estado}">${order.estado}</span>
      </div>
      <p class="price">${money(order.total)}</p>
      <p class="muted">${order.productos.map((p) => `${p.cantidad}x ${p.nombre}`).join(', ')}</p>
    </article>
  `).join('');
}

function renderCart() {
  if (!state.cart.length) {
    $('cartBox').innerHTML = 'Seleccione productos para el pedido.';
    return;
  }
  const total = state.cart.reduce((sum, item) => sum + Number(item.precio || 0) * item.quantity, 0);
  $('cartBox').innerHTML = state.cart.map((item) => `
    <div class="cart-item">
      <span>${item.quantity}x ${item.nombre}</span>
      <strong>${money(Number(item.precio || 0) * item.quantity)}</strong>
    </div>
  `).join('') + `<p class="price">Total: ${money(total)}</p>`;
}

function addToCart(product, quantity) {
  const existing = state.cart.find((item) => item.id === product.id);
  if (existing) existing.quantity += quantity;
  else state.cart.push({ ...product, quantity });
  renderCart();
}

async function sendToConversation(product, quantity) {
  const conversationId = $('conversationId').value.trim();
  if (!conversationId) return alert('Ingrese el ID de conversación de Chatwoot.');
  await api('/chatwoot/enviar-producto', {
    method: 'POST',
    body: JSON.stringify({ conversationId, product, quantity })
  });
  alert('Producto enviado a la conversación.');
}

function renderProducts() {
  const query = $('productFilter').value.trim().toLowerCase();
  const filtered = state.productos.filter((p) => `${p.nombre} ${p.sku}`.toLowerCase().includes(query));
  if (!filtered.length) {
    $('productsList').innerHTML = '<span class="muted">No hay productos disponibles.</span>';
    return;
  }

  $('productsList').innerHTML = filtered.map((p) => `
    <article class="product-card">
      <img src="${p.imagen || 'https://placehold.co/300x300?text=Producto'}" alt="${p.nombre}" />
      <div>
        <div class="product-head">
          <div>
            <h3>${p.nombre}</h3>
            <p class="muted">SKU: ${p.sku} · Stock: ${p.stock ?? p.stock_status}</p>
          </div>
          <span class="price">${money(p.precio)}</span>
        </div>
        <div class="product-actions">
          <input class="qty" id="qty-${p.id}" type="number" min="1" value="1" />
          <button data-add="${p.id}">Agregar</button>
          <button class="secondary" data-send="${p.id}">Enviar a conversación</button>
        </div>
      </div>
    </article>
  `).join('');

  document.querySelectorAll('[data-add]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const product = state.productos.find((p) => String(p.id) === btn.dataset.add);
      const quantity = Math.max(1, Number($(`qty-${product.id}`).value || 1));
      addToCart(product, quantity);
    });
  });

  document.querySelectorAll('[data-send]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const product = state.productos.find((p) => String(p.id) === btn.dataset.send);
      const quantity = Math.max(1, Number($(`qty-${product.id}`).value || 1));
      try { await sendToConversation(product, quantity); } catch (error) { alert(error.message); }
    });
  });
}

async function loadPanel() {
  const email = $('customerEmail').value.trim();
  if (!email) return alert('Ingrese el email del cliente.');
  $('loadBtn').disabled = true;
  try {
    const [clientData, productsData] = await Promise.all([
      api(`/cliente?email=${encodeURIComponent(email)}`),
      api('/productos')
    ]);
    state.cliente = clientData.cliente;
    state.pedidos = clientData.pedidos || [];
    state.productos = productsData.productos || [];
    renderClient();
    renderOrders();
    renderProducts();
  } catch (error) {
    alert(error.message);
  } finally {
    $('loadBtn').disabled = false;
  }
}

function buildOrderPayload() {
  const email = $('customerEmail').value.trim();
  const firstName = $('billingFirstName').value.trim();
  const lastName = $('billingLastName').value.trim();
  const address = $('billingAddress').value.trim();
  const city = $('billingCity').value.trim();
  const region = $('billingRegion').value.trim();
  const phone = $('billingPhone').value.trim();
  const paymentMethod = $('paymentMethod').value;

  if (!state.cart.length) throw new Error('Agregue al menos un producto.');
  if (!email || !firstName || !lastName || !address || !city || !phone) {
    throw new Error('Complete los datos principales del checkout.');
  }

  const billing = {
    first_name: firstName,
    last_name: lastName,
    email,
    phone,
    address_1: address,
    city,
    state: region,
    country: 'CL'
  };

  return {
    billing,
    shipping: billing,
    payment_method: paymentMethod,
    payment_method_title: paymentMethod === 'flow' ? 'Flow - Webpay / Multicaja' : paymentMethod,
    line_items: state.cart.map((item) => ({ product_id: item.id, quantity: item.quantity })),
    customer_note: 'Pedido creado desde panel Chatwoot.'
  };
}

async function createOrder() {
  $('orderStatus').textContent = '';
  try {
    const payload = buildOrderPayload();
    const data = await api('/crear-pedido', { method: 'POST', body: JSON.stringify(payload) });
    state.lastOrder = data.pedido;
    $('orderStatus').style.color = '#15803d';
    $('orderStatus').textContent = `Pedido #${data.pedido.numero} creado por ${money(data.pedido.total)}.`;
    await loadPanel();
  } catch (error) {
    $('orderStatus').style.color = '#b91c1c';
    $('orderStatus').textContent = error.message;
  }
}

async function payOrder() {
  try {
    if (!state.lastOrder) await createOrder();
    if (!state.lastOrder) return;
    const email = $('customerEmail').value.trim();
    const data = await api('/pagar', {
      method: 'POST',
      body: JSON.stringify({
        orderId: state.lastOrder.id,
        amount: state.lastOrder.total,
        email,
        subject: `Pedido #${state.lastOrder.numero}`
      })
    });
    window.open(data.url, '_blank', 'noopener,noreferrer');
  } catch (error) {
    alert(error.message);
  }
}

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('loginError').textContent = '';
  const user = $('loginUser').value.trim();
  const pass = $('loginPassword').value;
  state.auth = btoa(`${user}:${pass}`);
  try {
    await api('/health');
    localStorage.setItem('panelAuth', state.auth);
    showApp();
    readChatwootParams();
  } catch (error) {
    $('loginError').textContent = 'Credenciales incorrectas o servidor no disponible.';
    state.auth = '';
  }
});

$('logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('panelAuth');
  state.auth = '';
  showLogin();
});
$('loadBtn').addEventListener('click', loadPanel);
$('productFilter').addEventListener('input', renderProducts);
$('createOrderBtn').addEventListener('click', createOrder);
$('payBtn').addEventListener('click', payOrder);

testAuth();
