const state = {
  auth: localStorage.getItem('panelAuth') || '',
  panelToken: localStorage.getItem('panelToken') || '',
  cliente: null,
  pedidos: [],
  productos: [],
  stores: [],
  activeStore: localStorage.getItem('activeStore') || 'cl',
  regiones: [],
  categorias: [],
  paymentMethods: [],
  selectedOrder: null,
  cart: [],
  lastOrder: null,
  productOffset: 0,
  productLimit: 20,
  productTotal: 0,
  productLoading: false,
  syncTimer: null,
  themeMode: localStorage.getItem('panelThemeMode') || 'light',
  themeAccent: localStorage.getItem('panelThemeAccent') || 'teal',
  orderSearchResults: [],
  recommendations: null,
  chatwootContext: null,
  chatwootReady: false,
  settings: {}
};
const $ = (id) => document.getElementById(id);
function currentStore(){ return state.stores.find(s => s.id === state.activeStore) || { id: state.activeStore, country: state.activeStore === 'co' ? 'CO' : 'CL', currency: state.activeStore === 'co' ? 'COP' : 'CLP', document_label: state.activeStore === 'co' ? 'CC / NIT' : 'RUT' }; }
const money = (v) => `${Number(v || 0).toLocaleString(currentStore().country === 'CO' ? 'es-CO' : 'es-CL')} ${currentStore().currency || 'CLP'}`;
const text = (v) => String(v ?? '').replace(/[<>&"]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
const normalize = (s='') => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();

function parseMaybeJson(data) {
  if (!data) return null;
  if (typeof data === 'string') { try { return JSON.parse(data); } catch { return null; } }
  return typeof data === 'object' ? data : null;
}
function extractEmailFromString(value='') {
  const match = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : '';
}
function extractChatwootContext(payload = {}) {
  const appContext = payload.event === 'appContext' ? payload.data : (payload.appContext || payload.data || payload);
  const conversation = appContext.conversation || appContext.currentConversation || appContext;
  const contact = appContext.contact || conversation.contact || conversation.meta?.sender || conversation.sender || appContext.meta?.sender || {};
  const conversationId = conversation.id || conversation.conversation_id || appContext.conversation_id || appContext.id || '';
  let email = contact.email || conversation.meta?.sender?.email || conversation.contact_email || appContext.email || '';
  if (!email) {
    for (const msg of conversation.messages || []) {
      email = msg.sender?.email || extractEmailFromString(msg.content || msg.processed_message_content || '');
      if (email) break;
    }
  }
  const name = contact.name || contact.available_name || conversation.meta?.sender?.name || '';
  const phone = contact.phone_number || contact.phone || conversation.meta?.sender?.phone_number || '';
  const labels = conversation.labels || conversation.label_list || [];
  const customAttributes = conversation.custom_attributes || {};
  return { raw: payload, appContext, conversation, contact, conversationId, email, name, phone, labels, customAttributes };
}
function renderChatwootContext(ctx, source='Chatwoot') {
  state.chatwootContext = ctx;
  if (ctx?.conversationId && $('conversationId')) $('conversationId').value = ctx.conversationId;
  if (ctx?.email && $('customerEmail')) $('customerEmail').value = ctx.email;
  if (ctx?.phone && $('billingPhone') && !$('billingPhone').value) $('billingPhone').value = ctx.phone;
  if (ctx?.name && $('billingFirstName') && !$('billingFirstName').value) {
    const parts = String(ctx.name).trim().split(/\s+/);
    $('billingFirstName').value = parts.shift() || '';
    if ($('billingLastName') && !$('billingLastName').value) $('billingLastName').value = parts.join(' ');
  }
  const status = $('chatwootContextStatus');
  if (status) status.textContent = ctx?.conversationId ? `Conectado a conversación #${ctx.conversationId}` : 'Contexto recibido sin ID de conversación';
  const box = $('chatwootContextBox');
  if (box) {
    box.className = 'chatwoot-context-box active';
    box.innerHTML = `<strong>${text(ctx?.name || 'Contacto Chatwoot')}</strong><span>Email: ${text(ctx?.email || 'pendiente / no detectado')}</span><span>Conversación: ${text(ctx?.conversationId || 'N/D')}</span><span>Teléfono: ${text(ctx?.phone || 'N/D')}</span><span>Origen: ${text(source)}</span>${ctx?.labels?.length ? `<span>Etiquetas: ${ctx.labels.map(text).join(', ')}</span>` : ''}`;
  }
}
async function enrichContextFromServer(conversationId='') {
  const id = conversationId || $('conversationId')?.value?.trim();
  if (!id) return null;
  const data = await api(`/chatwoot/conversacion/${encodeURIComponent(id)}/contexto`);
  const ctx = { conversationId: data.conversationId || id, email: data.email || '', name: data.name || '', phone: data.phone || '', labels: data.labels || [], customAttributes: data.custom_attributes || {}, conversation: data.conversation, contact: data.contact };
  renderChatwootContext(ctx, data.email_detected_from_message ? 'Chatwoot + email detectado en mensajes' : 'Chatwoot API');
  if (ctx.email && !state.cliente) loadPanel(false).catch(console.warn);
  return ctx;
}
function requestChatwootContext() {
  if (window.parent && window.parent !== window) {
    const status = $('chatwootContextStatus');
    if (status) status.textContent = 'Solicitando contexto a Chatwoot...';
    window.parent.postMessage('chatwoot-dashboard-app:fetch-info', '*');
  }
}
function installChatwootContextListener() {
  if (state.chatwootReady) return;
  state.chatwootReady = true;
  window.addEventListener('message', (event) => {
    const payload = parseMaybeJson(event.data);
    if (!payload) return;
    if (payload.event !== 'appContext' && !payload.appContext && !payload.conversation && !payload.contact && !payload.meta && !payload.data) return;
    const ctx = extractChatwootContext(payload);
    if (!ctx.conversationId && !ctx.email) return;
    renderChatwootContext(ctx, 'postMessage');
    if (!ctx.email && ctx.conversationId) enrichContextFromServer(ctx.conversationId).catch(console.warn);
    else if (ctx.email && !state.cliente) loadPanel(false).catch(console.warn);
  });
}
function autoRequestChatwootContext() {
  requestChatwootContext();
  setTimeout(requestChatwootContext, 700);
  setTimeout(requestChatwootContext, 1800);
}
function readUrlParams() {
  const p = new URLSearchParams(location.search);
  const token = p.get('panel_token') || p.get('token') || '';
  if (token) { state.panelToken = token; localStorage.setItem('panelToken', token); }
  const email = p.get('email') || p.get('email_cliente') || p.get('customer_email') || p.get('contact_email') || '';
  const conversationId = p.get('conversation_id') || p.get('conversationId') || p.get('conversation.id') || p.get('cw_conversation_id') || '';
  if (email && $('customerEmail')) $('customerEmail').value = email;
  if (conversationId && $('conversationId')) $('conversationId').value = conversationId;
  if (email || conversationId) renderChatwootContext({ email, conversationId, name: '', phone: '', labels: [], customAttributes: {} }, 'URL');
}
function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (state.panelToken) headers['x-panel-token'] = state.panelToken;
  else if (state.auth) headers.Authorization = `Basic ${state.auth}`;
  return headers;
}
function pathWithStore(path) {
  if (!path.startsWith('/') || path.startsWith('/stores') || path.startsWith('/paises') || path.startsWith('/health')) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}store=${encodeURIComponent(state.activeStore)}`;
}
function bodyWithStore(options = {}) {
  if (!options.body || typeof options.body !== 'string') return options.body;
  try {
    const parsed = JSON.parse(options.body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { const st = currentStore(); parsed.store = st.id; parsed.store_id = st.id; parsed.country = st.country; return JSON.stringify(parsed); }
  } catch {}
  return options.body;
}
async function api(path, options = {}) {
  const finalOptions = { ...options, body: bodyWithStore(options) };
  const res = await fetch(pathWithStore(path), { ...finalOptions, headers: { ...authHeaders(), ...(options.headers || {}) }, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error de servidor');
  return data;
}
function showApp() { $('loginScreen').classList.add('hidden'); $('app').classList.remove('hidden'); }
function showLogin() { $('loginScreen').classList.remove('hidden'); $('app').classList.add('hidden'); }
function setMetric(id, value) { const el = $(id); if (el) el.textContent = value; }
function setLoadingState(label, detail='') { setMetric('metricCache', label); if ($('loadingDetail') && detail) $('loadingDetail').textContent = detail; }
function showProductLoader(show=true, detail='Cargando productos...') {
  const el = $('loadingOverlay');
  if (!el) return;
  el.classList.toggle('hidden', !show);
  if (detail) $('loadingDetail').textContent = detail;
}
function saveLocal(key, value) { localStorage.setItem(key, JSON.stringify({ value, time: Date.now() })); }
function readLocal(key, maxAgeMs) { try { const raw = JSON.parse(localStorage.getItem(key) || 'null'); if (!raw || Date.now() - raw.time > maxAgeMs) return null; return raw.value; } catch { return null; } }
async function enterApp() {
  showApp();
  await loadSettings().catch(()=>{});
  await loadStores();
  await loadRegiones();
  await loadCategorias();
  await loadPaymentMethods();
  readUrlParams();
  installChatwootContextListener();
  autoRequestChatwootContext();
  const email = $('customerEmail').value.trim();
  if (email) loadPanel(false); else loadProducts(false);
}
async function testAuth() {
  readUrlParams();
  if (!state.auth && !state.panelToken) return showLogin();
  try { await api('/stores'); await enterApp(); }
  catch { localStorage.removeItem('panelAuth'); if (!state.panelToken) showLogin(); else showLogin(); }
}
async function loadStores() {
  try {
    const data = await api('/stores'); state.stores = data.stores || [];
    if (!state.stores.find(s => s.id === state.activeStore)) state.activeStore = data.default_store || state.stores[0]?.id || 'cl';
    const sel = $('storeSelect'); if (sel) { sel.innerHTML = state.stores.map(s => `<option value="${text(s.id)}">${text(s.name || s.id)} · ${text(s.country || s.code || '')}</option>`).join(''); sel.value = state.activeStore; }
    applyStoreUI();
  } catch (e) { console.warn('No se pudieron cargar tiendas:', e.message); }
}
function applyStoreUI() {
  const st = currentStore();
  if ($('brandMark')) $('brandMark').textContent = st.country || st.id.toUpperCase();
  if ($('checkoutTitle')) $('checkoutTitle').textContent = st.country === 'CO' ? 'Checkout Colombia' : 'Checkout Chile';
  if ($('countryPill')) $('countryPill').textContent = `${st.currency || ''} · ${st.country === 'CO' ? 'Dropi / Wompi / Bold / COD' : 'WooCommerce Flow'}`;
  if ($('platformPill')) $('platformPill').textContent = st.country === 'CO' ? 'Dropi Colombia' : 'WooCommerce';
  if ($('billingRut')) $('billingRut').placeholder = st.country === 'CO' ? 'Documento: CC / NIT' : 'RUT: 12.345.678-9';
  if ($('docHelp')) $('docHelp').innerHTML = st.country === 'CO' ? 'Documento compatible con WooCommerce/Dropi. El departamento se envia como codigo Dropi.' : 'El RUT se guarda en campos esenciales: billing_rut y shipping_rut.';
  if ($('billingPhone')) $('billingPhone').placeholder = st.country === 'CO' ? 'Telefono +57' : 'Telefono +56';
}
async function changeStore(storeId) {
  state.activeStore = storeId || 'cl'; localStorage.setItem('activeStore', state.activeStore);
  state.productos=[]; state.productOffset=0; state.productTotal=0; state.categorias=[]; state.paymentMethods=[]; state.pedidos=[]; state.cart=[]; state.lastOrder=null;
  applyStoreUI(); await loadRegiones(true); await loadCategorias(true); await loadPaymentMethods(true); renderCart(); renderOrders([]); await loadProducts(true);
}
async function loadRegiones(force=false) {
  const key = `regiones_${state.activeStore}_v74`;
  const cached = !force && readLocal(key, 86400000 * 30);
  if (cached) { state.regiones = cached; renderRegionOptions(); return; }
  const data = await api('/regiones'); state.regiones = data.regiones || []; saveLocal(key, state.regiones); renderRegionOptions();
}
async function loadCategorias(force=false) {
  try {
    const data = await api(`/categorias${force ? '?refresh=true' : ''}`);
    state.categorias = data.categorias || [];
    const sel = $('categoryFilter');
    if (sel) sel.innerHTML = '<option value="">Todas las categorias</option>' + state.categorias.map(c => `<option value="${text(c.name || c)}">${text(c.name || c)}${c.count ? ` (${c.count})` : ''}</option>`).join('');
  } catch (e) { console.warn(e.message); }
}

async function loadPaymentMethods(force=false) {
  try {
    const data = await api(`/payment-methods${force ? '?refresh=true' : ''}`);
    state.paymentMethods = data.methods || [];
    const sel = $('paymentMethod');
    if (sel && state.paymentMethods.length) {
      sel.innerHTML = state.paymentMethods.map((m) => `<option value="${text(m.id)}">${text(m.title || m.id)}${m.preset ? ' · sugerido' : ''}</option>`).join('');
      const st = currentStore();
      const preferred = st.country === 'CO'
        ? state.paymentMethods.find((m) => /cod|contra/i.test(`${m.id} ${m.title}`)) || state.paymentMethods.find((m) => /wompi|bold|pse|payu|epayco|mercado/i.test(`${m.id} ${m.title}`))
        : state.paymentMethods.find((m) => /flow|webpay|transbank|mercado|khipu/i.test(`${m.id} ${m.title}`));
      if (preferred) sel.value = preferred.id;
    }
  } catch (e) {
    console.warn('No se pudieron cargar métodos Woo:', e.message);
  }
}
function renderRegionOptions() {
  if (!$('billingRegion')) return;
  $('billingRegion').innerHTML = `<option value="">Seleccione ${currentStore().country === 'CO' ? 'departamento' : 'region'}</option>` + state.regiones.map(r => `<option value="${text(r.codigo)}">${text(r.region)}</option>`).join('');
}
function renderComunas(regionCode, selectedComuna='') {
  const region = state.regiones.find(r => r.codigo === regionCode);
  const comunas = region?.comunas || [];
  $('billingComuna').disabled = !comunas.length;
  $('billingComuna').innerHTML = `<option value="">Seleccione ${currentStore().country === 'CO' ? 'ciudad' : 'comuna'}</option>` + comunas.map(c => `<option value="${text(c.comuna)}" data-postcode="${text(c.postcode)}">${text(c.comuna)}</option>`).join('');
  if (selectedComuna) {
    const match = comunas.find(c => normalize(c.comuna) === normalize(selectedComuna));
    if (match) $('billingComuna').value = match.comuna;
  }
  updatePostcode();
}
function findRegionByComuna(comuna='') {
  for (const region of state.regiones) if ((region.comunas || []).some(c => normalize(c.comuna) === normalize(comuna))) return region;
  return null;
}
function updatePostcode() { const opt = $('billingComuna').selectedOptions[0]; $('billingPostcode').value = opt?.dataset?.postcode || ''; }
function validateRutLocal(rut='') {
  const clean = String(rut).replace(/\./g,'').replace(/-/g,'').trim().toUpperCase();
  if (!/^[0-9]+[0-9K]$/.test(clean)) return false;
  const body = clean.slice(0,-1), dv = clean.slice(-1); let sum=0, mul=2;
  for (let i=body.length-1;i>=0;i--) { sum += Number(body[i]) * mul; mul = mul === 7 ? 2 : mul + 1; }
  const n = 11 - (sum % 11); const expected = n === 11 ? '0' : n === 10 ? 'K' : String(n);
  return dv === expected;
}
function updateRutStatus() {
  const doc = $('billingRut').value.trim(); const st = currentStore(); const ok = st.country === 'CL' ? validateRutLocal(doc) : doc.replace(/[^0-9A-Za-z]/g,'').length >= 5;
  $('rutStatus').textContent = doc ? (ok ? `${st.document_label || 'Documento'} valido` : `${st.document_label || 'Documento'} invalido`) : `${st.document_label || 'Documento'} pendiente`;
  $('rutStatus').className = `mini muted-line ${doc ? (ok ? 'ok' : 'bad') : ''}`;
}
function renderClient() {
  const c = state.cliente; if (!c) return;
  const d = c.direccion || {};
  $('clientInfo').innerHTML = `<div class="client-row"><strong>Nombre</strong><span>${text(c.nombre || 'No registrado')}</span></div><div class="client-row"><strong>Email</strong><span>${text(c.email || '')}</span></div><div class="client-row"><strong>${text(currentStore().document_label || 'Documento')}</strong><span>${text(c.rut || 'No registrado')}</span></div><div class="client-row"><strong>Telefono</strong><span>${text(c.telefono || d.phone || '')}</span></div><div class="client-row"><strong>Region</strong><span>${text(d.region_nombre || d.state || 'Sin region')}</span></div><div class="client-row"><strong>Direccion</strong><span>${text([d.address_1,d.address_2,d.city,d.postcode,d.country].filter(Boolean).join(', ') || 'Sin direccion')}</span></div>`;
  $('billingFirstName').value = d.first_name || c.nombre?.split(' ')[0] || '';
  $('billingLastName').value = d.last_name || c.nombre?.split(' ').slice(1).join(' ') || '';
  $('billingPhone').value = c.telefono || d.phone || '';
  $('billingRut').value = c.rut || '';
  $('billingAddress').value = d.address_1 || '';
  $('billingAddress2').value = d.address_2 || '';
  const region = state.regiones.find(r => r.codigo === d.region_codigo) || findRegionByComuna(d.city || '');
  if (region) { $('billingRegion').value = region.codigo; renderComunas(region.codigo, d.city || ''); }
  updateRutStatus();
}
function renderOrders(list = state.pedidos) {
  setMetric('metricOrders', list.length);
  if (!list.length) { $('ordersList').innerHTML = '<span class="muted">Este cliente no registra pedidos o no hay resultados.</span>'; return; }
  $('ordersList').innerHTML = list.map(o => {
    const productos = (o.productos || []).map(p => `${p.cantidad || 1}x ${p.nombre}`).join(', ');
    const fecha = o.fecha ? new Date(o.fecha).toLocaleDateString('es-CL') : 'Sin fecha';
    return `<article class="order-card order-card-modern">
      <div class="order-head">
        <div><h3>Pedido #${text(o.numero || o.id)}</h3><p class="muted">${fecha} · ${text(o.metodo_pago || 'Sin método')} · ${text(o.email || '')}</p></div>
        <span class="badge ${text(o.estado)}">${text(o.estado)}</span>
      </div>
      <p class="price">${money(o.total)}</p>
      <p class="muted order-products">${text(productos || 'Sin productos')}</p>
      <div class="order-actions">
        <button class="secondary tiny" data-view-order="${o.id}">Ver / editar</button>
        <button class="tiny" data-flow-order="${o.id}">Link pago Woo</button>
        <button class="ghost tiny" data-cancel-order="${o.id}">Cancelar</button>
      </div>
    </article>`;
  }).join('');
  document.querySelectorAll('[data-view-order]').forEach(b => b.addEventListener('click', () => viewOrder(b.dataset.viewOrder)));
  document.querySelectorAll('[data-flow-order]').forEach(b => b.addEventListener('click', () => createFlowForOrder(b.dataset.flowOrder)));
  document.querySelectorAll('[data-cancel-order]').forEach(b => b.addEventListener('click', () => cancelOrderQuick(b.dataset.cancelOrder)));
}
function isNoisyAttribute(name='') {
  const n = normalize(name);
  return ['size_info','sizelist','sizes','shipping','logistics','product chemical','producto quimico','origen','cn','fujian','lugar aplicable','numero de modelo','model','department','departamento'].some(x => n.includes(x));
}
function visibleAttributes(product) {
  const preferred = ['color','talla','marca','genero','material'];
  const attrs = (product.atributos || []).filter(a => a && a.name && !isNoisyAttribute(a.name)).filter(a => Array.isArray(a.options) && a.options.length && JSON.stringify(a.options).length < 240);
  attrs.sort((a,b)=> (preferred.some(x=>normalize(a.name).includes(x)) ? -1 : 1) - (preferred.some(x=>normalize(b.name).includes(x)) ? -1 : 1));
  return attrs.slice(0, 6);
}
function variationLabel(v) { return (v.atributos || []).filter(a => a.option && !isNoisyAttribute(a.name)).map(a => `${a.name}: ${a.option}`).join(' · ') || v.sku || `Variacion ${v.id}`; }
function getSelectedVariation(product) {
  if (!product.variations || !product.variations.length) return null;
  const selected = product.selectedVariationId ? product.variations.find(v => String(v.id) === String(product.selectedVariationId)) : null;
  return selected || product.variations[0];
}
function variationMatches(product, v) {
  const choices = product.variationChoices || {};
  return (v.atributos || []).every(a => !choices[a.name] || choices[a.name] === a.option);
}
function variationGroups(product) {
  const groups = new Map();
  for (const v of product.variations || []) {
    for (const a of v.atributos || []) {
      if (!a.name || !a.option || isNoisyAttribute(a.name)) continue;
      if (!groups.has(a.name)) groups.set(a.name, new Set());
      groups.get(a.name).add(a.option);
    }
  }
  return Array.from(groups.entries()).slice(0, 3).map(([name, set]) => ({ name, options: Array.from(set).slice(0, 20) }));
}
function productImage(product) { const v = getSelectedVariation(product); return v?.imagen || product.imagen || product.imagenes?.[0]?.src || ''; }
function renderVariationPanel(product) {
  if (!product.variation_count && !(product.variations || []).length) return '';
  if (!product.variations) return `<div class="variation-panel collapsed"><button class="secondary" data-load-vars="${product.id}">Elegir variación (${product.variation_count || 0})</button><span class="muted"> Color, talla e imagen se cargan solo cuando las necesitas.</span></div>`;
  const groups = variationGroups(product);
  const filtered = product.variations.filter(v => variationMatches(product, v));
  const current = filtered.find(v => String(v.id) === String(product.selectedVariationId)) || filtered[0] || getSelectedVariation(product);
  if (current && String(product.selectedVariationId) !== String(current.id)) product.selectedVariationId = current.id;
  const selectorHtml = groups.map(g => {
    const selected = (product.variationChoices || {})[g.name] || '';
    return `<label class="variation-field"><span>${text(g.name)}</span><select data-var-select="${product.id}" data-var-name="${text(g.name)}"><option value="">Todas las opciones</option>${g.options.map(o => `<option value="${text(o)}" ${selected === o ? 'selected' : ''}>${text(o)}</option>`).join('')}</select></label>`;
  }).join('');
  const image = current?.imagen || product.imagen || product.imagenes?.[0]?.src || '';
  const attrs = current ? (current.atributos || []).filter(a => a.option && !isNoisyAttribute(a.name)).map(a => `<span>${text(a.name)}: <strong>${text(a.option)}</strong></span>`).join('') : '';
  return `<div class="variation-panel clean"><div class="variation-panel-title"><span>Selecciona la variación</span><button class="tiny ghost" data-refresh-vars="${product.id}">Actualizar</button></div><div class="variation-selectors">${selectorHtml || '<p class="muted">Este producto no tiene atributos visibles para seleccionar.</p>'}</div>${current ? `<div class="selected-variation-card">${image ? `<img src="${text(image)}" loading="lazy" alt=""/>` : `<span class="var-no-img">Sin img</span>`}<div><strong>Variación seleccionada</strong><p>${attrs || text(variationLabel(current))}</p><small>${text(current.sku || 'Sin SKU')} · ${money(current.precio)} · ${current.stock_status === 'instock' ? 'con stock' : 'sin stock'}</small></div></div>` : '<p class="muted">Seleccione una opción para ver disponibilidad.</p>'}<p class="variation-hint">${filtered.length} variación${filtered.length === 1 ? '' : 'es'} disponible${filtered.length === 1 ? '' : 's'} con los filtros actuales.</p></div>`;
}
function renderProductCard(p) {
  const img = productImage(p);
  const current = getSelectedVariation(p);
  const price = current?.precio || p.precio;
  const stockOk = current ? current.stock_status === 'instock' : p.stock_status === 'instock';
  const typeText = p.type === 'variable' ? 'Producto variable' : 'Producto simple';
  return `<article class="product-card" data-product-card="${p.id}"><div class="product-media">${img ? `<img id="main-img-${p.id}" src="${text(img)}" loading="lazy" alt="${text(p.nombre)}"/>` : `<div class="no-img">Sin imagen</div>`}<span class="stock-chip ${stockOk ? 'ok' : 'no'}">${stockOk ? 'Con stock' : 'Sin stock'}</span></div><div class="product-body"><div class="product-head"><div><h3>${text(p.nombre)}</h3><p class="product-sku">SKU: ${text(current?.sku || p.sku)} · ${typeText}${p.variation_count ? ` · ${p.variation_count} variaciones` : ''}</p></div><p class="price">${money(price)}</p></div>${renderVariationPanel(p)}<div class="product-actions"><input class="qty" id="qty-${p.id}" type="number" min="1" value="1"/><button data-add="${p.id}">Agregar</button><button class="secondary" data-send="${p.id}">Enviar a conversación</button></div></div></article>`;
}
function renderProducts() {
  setMetric('metricProducts', state.productos.length);
  const vCount = state.productos.reduce((s,p)=>s+Number(p.variation_count || (p.variations||[]).length || 0),0);
  setMetric('metricVariations', vCount);
  if (!state.productos.length) { $('productsList').innerHTML = '<span class="muted">No hay productos para mostrar.</span>'; $('loadMoreBtn').classList.add('hidden'); return; }
  $('productsList').innerHTML = state.productos.map(renderProductCard).join('');
  $('loadMoreInfo').textContent = `${state.productos.length}/${state.productTotal || state.productos.length} productos`;
  $('loadMoreBtn').classList.toggle('hidden', !(state.productos.length < state.productTotal || state.productos.length % state.productLimit === 0));
  bindProductEvents();
}
function findProduct(id) { return state.productos.find(p => String(p.id) === String(id)); }
function bindProductEvents() {
  document.querySelectorAll('[data-load-vars]').forEach(btn => btn.addEventListener('click', () => loadVariations(btn.dataset.loadVars)));
  document.querySelectorAll('[data-refresh-vars]').forEach(btn => btn.addEventListener('click', () => loadVariations(btn.dataset.refreshVars, true)));
  document.querySelectorAll('[data-more-vars]').forEach(btn => btn.addEventListener('click', () => { const p=findProduct(btn.dataset.moreVars); p.variationLimit=(p.variationLimit||8)+12; renderProducts(); }));
  document.querySelectorAll('[data-var-select]').forEach(sel => sel.addEventListener('change', () => { const p=findProduct(sel.dataset.varSelect); p.variationChoices=p.variationChoices||{}; if (sel.value) p.variationChoices[sel.dataset.varName]=sel.value; else delete p.variationChoices[sel.dataset.varName]; const match=(p.variations||[]).find(v=>variationMatches(p,v)); if(match)p.selectedVariationId=match.id; renderProducts(); }));
  document.querySelectorAll('[data-var-choice]').forEach(btn => btn.addEventListener('click', () => { const p=findProduct(btn.dataset.varChoice); p.variationChoices=p.variationChoices||{}; p.variationChoices[btn.dataset.varName]=btn.dataset.varValue; const match=(p.variations||[]).find(v=>variationMatches(p,v)); if(match)p.selectedVariationId=match.id; renderProducts(); }));
  document.querySelectorAll('[data-var-clear]').forEach(btn => btn.addEventListener('click', () => { const p=findProduct(btn.dataset.varClear); p.variationChoices=p.variationChoices||{}; delete p.variationChoices[btn.dataset.varName]; const match=(p.variations||[]).find(v=>variationMatches(p,v)); if(match)p.selectedVariationId=match.id; renderProducts(); }));
  document.querySelectorAll('[data-select-var]').forEach(btn => btn.addEventListener('click', () => { const p=findProduct(btn.dataset.selectVar); p.selectedVariationId=btn.dataset.varId; renderProducts(); }));
  document.querySelectorAll('[data-add]').forEach(btn => btn.addEventListener('click', () => { const p=findProduct(btn.dataset.add); addToCart(p, Math.max(1, Number($(`qty-${p.id}`).value || 1)), getSelectedVariation(p)); }));
  document.querySelectorAll('[data-send]').forEach(btn => btn.addEventListener('click', async () => { const p=findProduct(btn.dataset.send); try { await sendToConversation(p, Math.max(1, Number($(`qty-${p.id}`).value || 1)), getSelectedVariation(p)); } catch(e) { alert(e.message); } }));
}
async function loadVariations(productId, force=false) {
  const p = findProduct(productId); if (!p) return;
  p.loadingVariations = true; renderProducts();
  try {
    const data = await api(`/productos/${productId}/variaciones${force ? '?refresh=true' : ''}`);
    p.variations = data.variations || [];
    p.variation_count = p.variations.length;
    p.variationLimit = 8;
    p.selectedVariationId = p.variations[0]?.id;
  } catch (e) { alert(e.message); }
  finally { p.loadingVariations = false; renderProducts(); }
}
function addToCart(product, quantity, variation=null) { const key = `${product.id}:${variation?.id || 0}`; const ex = state.cart.find(i => i.key === key); if (ex) ex.quantity += quantity; else state.cart.push({ key, product, variation, quantity }); renderCart(); }
function removeFromCart(key) { state.cart = state.cart.filter(i => i.key !== key); renderCart(); }
function cartItemImage(item) {
  return item.variation?.imagen || item.product?.imagen || item.product?.imagenes?.[0]?.src || '';
}
function renderCart() {
  if (!state.cart.length) { $('cartBox').innerHTML = '<div class="cart-empty">Seleccione productos o variaciones para el pedido.</div>'; return; }
  const total = state.cart.reduce((s,i)=>s+Number(i.variation?.precio || i.product.precio || 0)*i.quantity,0);
  $('cartBox').innerHTML = state.cart.map(i => {
    const unit = Number(i.variation?.precio || i.product.precio || 0);
    const img = cartItemImage(i);
    const sku = i.variation?.sku || i.product?.sku || '';
    const variation = i.variation ? variationLabel(i.variation) : '';
    return `<div class="cart-item cart-item-rich">
      <div class="cart-thumb">${img ? `<img src="${text(img)}" alt="${text(i.product.nombre)}" loading="lazy"/>` : '<span>Sin imagen</span>'}</div>
      <div class="cart-info">
        <strong>${i.quantity}x ${text(i.product.nombre)}</strong>
        ${variation ? `<small>${text(variation)}</small>` : ''}
        ${sku ? `<small>SKU: ${text(sku)}</small>` : ''}
      </div>
      <div class="cart-price">
        <strong>${money(unit*i.quantity)}</strong>
        <button class="tiny" onclick="removeFromCart('${text(i.key)}')">Quitar</button>
      </div>
    </div>`;
  }).join('') + `<div class="cart-total"><span>Total</span><strong>${money(total)}</strong></div>`;
}
async function sendToConversation(product, quantity, variation=null) {
  let conversationId = $('conversationId').value.trim();
  if (!conversationId) {
    requestChatwootContext();
    await new Promise(r => setTimeout(r, 600));
    conversationId = $('conversationId').value.trim();
  }
  if (!conversationId) return alert('No se detectó ID de conversación. Abre el panel dentro de una conversación Chatwoot o ingresa el ID manualmente.');
  if (!$('customerEmail')?.value?.trim()) await enrichContextFromServer(conversationId).catch(console.warn);
  const imageUrl = variation?.imagen || product?.imagen || product?.imagenes?.[0]?.src || '';
  await api('/chatwoot/enviar-producto', { method:'POST', body: JSON.stringify({ conversationId, product, variation, quantity, imageUrl, autoLabels: true }) });
  alert('Producto enviado a la conversación. Si Chatwoot/WhatsApp lo permite, la imagen se envió como adjunto real; si falla, se usa enlace de respaldo.');
}
function buildProductSearchParams(offset=0) {
  const params = new URLSearchParams();
  params.set('q', $('productFilter')?.value?.trim() || '');
  params.set('category', $('categoryFilter')?.value || '');
  params.set('sale', $('saleFilter')?.checked ? 'true' : 'false');
  params.set('stock', $('stockFilter')?.value || '');
  params.set('limit', String(state.productLimit));
  params.set('offset', String(offset));
  return params.toString();
}
async function loadProducts(force=false, append=false) {
  if (state.productLoading) return;
  state.productLoading = true;
  const nextOffset = append ? state.productOffset : 0;
  if (!append) { showProductLoader(true, force ? 'Actualizando vista...' : 'Buscando productos...'); $('productsList').innerHTML = '<div class="skeleton-grid"><div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div></div>'; }
  setLoadingState(force ? 'Actualizando' : 'Buscando', 'Cargando catálogo rápido...');
  try {
    const endpoint = `/productos/search?${buildProductSearchParams(nextOffset)}${force ? '&refresh=true' : ''}`;
    const data = await api(endpoint);
    const incoming = data.productos || [];
    state.productos = append ? [...state.productos, ...incoming] : incoming;
    state.productTotal = Number(data.total || state.productos.length);
    state.productOffset = state.productos.length;
    renderProducts();
    setLoadingState(data.cached ? 'Listo' : 'Actualizado', `${state.productos.length}/${state.productTotal} productos`);
  } catch (e) { alert(e.message); }
  finally { state.productLoading = false; showProductLoader(false); }
}
async function syncProducts() {
  if (!confirm('Se iniciara una sincronizacion en segundo plano. Puedes seguir usando el panel.')) return;
  $('syncProductsBtn')?.classList.add('syncing');
  showProductLoader(true, 'Iniciando sincronizacion...');
  try { await api('/productos/sync', { method:'POST', body:'{}' }); pollSyncStatus(true); } catch (e) { alert(e.message); showProductLoader(false); }
}
async function pollSyncStatus(reloadWhenDone=false) {
  clearTimeout(state.syncTimer);
  try {
    const data = await api('/productos/sync/status');
    const s = data.sync || {};
    setLoadingState(s.running ? 'Sincronizando' : 'Listo', s.running ? `Pagina ${s.page} · indexados ${s.indexed}${s.total ? '/' + s.total : ''}` : `Indexados ${s.indexed || 0}`);
    if (s.running) state.syncTimer = setTimeout(() => pollSyncStatus(reloadWhenDone), 2500);
    else { $('syncProductsBtn')?.classList.remove('syncing'); showProductLoader(false); if (reloadWhenDone) { await loadCategorias(true); await loadProducts(true); } if (s.error) alert(`Error de sincronizacion: ${s.error}`); }
  } catch (e) { $('syncProductsBtn')?.classList.remove('syncing'); showProductLoader(false); }
}
let productSearchTimer;
function scheduleProductSearch() { clearTimeout(productSearchTimer); productSearchTimer = setTimeout(() => loadProducts(false), 350); }
async function loadPanel(force=false) {
  const email = $('customerEmail').value.trim(); if (!email) return alert('Ingrese email del cliente.');
  $('loadBtn').disabled = true;
  try {
    const [clientData] = await Promise.all([api(`/cliente?email=${encodeURIComponent(email)}${force ? '&refresh=true' : ''}`), loadProducts(force)]);
    state.cliente = clientData.cliente; state.pedidos = clientData.pedidos || [];
    renderClient(); renderOrders();
  } catch(e) { alert(e.message); } finally { $('loadBtn').disabled = false; }
}
function buildOrderPayload() {
  const email = $('customerEmail').value.trim();
  const regionCode = $('billingRegion').value;
  const comuna = $('billingComuna').value;
  const rut = $('billingRut').value.trim();
  const st = currentStore();
  if (!state.cart.length) throw new Error('Agregue al menos un producto.');
  const required = ['billingFirstName','billingLastName','billingRut','billingPhone','billingAddress'];
  for (const id of required) if (!$(id).value.trim()) throw new Error(`Complete nombre, apellido, ${st.document_label || 'documento'}, telefono y direccion.`);
  if (st.country === 'CL' && !validateRutLocal(rut)) throw new Error('Ingrese un RUT valido.');
  if (st.country === 'CO' && rut.replace(/[^0-9A-Za-z]/g,'').length < 5) throw new Error('Ingrese documento valido para Colombia.');
  if (!regionCode || !comuna) throw new Error(st.country === 'CO' ? 'Seleccione departamento y ciudad.' : 'Seleccione region y comuna.');
  const regionObj = state.regiones.find(r => r.codigo === regionCode) || {};
  const regionName = regionObj.region || regionCode;
  const billing = { first_name:$('billingFirstName').value.trim(), last_name:$('billingLastName').value.trim(), email, phone:$('billingPhone').value.trim(), address_1:$('billingAddress').value.trim(), address_2:$('billingAddress2').value.trim(), city:comuna, postcode:$('billingPostcode').value.trim() || (st.country === 'CO' ? '110111' : ''), state:regionCode, country:st.country };
  return {
    rut,
    document: rut,
    store_id: st.id,
    country: st.country,
    region: regionName,
    region_codigo: regionCode,
    region_nombre: regionName,
    comuna,
    postcode: billing.postcode,
    billing,
    shipping: { ...billing },
    payment_method:$('paymentMethod').value,
    payment_method_title:$('paymentMethod').selectedOptions[0]?.textContent || $('paymentMethod').value,
    line_items: state.cart.map(i => ({ product_id:i.product.id, variation_id:i.variation?.id, quantity:i.quantity })),
    customer_note:$('customerNote').value.trim() || 'Pedido creado desde panel Chatwoot.',
    meta_data:[{key:'_chatwoot_conversation_id', value:$('conversationId').value.trim()}]
  };
}

function buildPlatformPayloadLocal() {
  const payload = buildOrderPayload();
  const st = currentStore();
  const products = state.cart.map((item) => ({
    product_id: item.product.id,
    variation_id: item.variation?.id || null,
    name: item.product.nombre,
    sku: item.variation?.sku || item.product.sku || '',
    quantity: item.quantity,
    price: Number(item.variation?.precio || item.product.precio || 0),
    variation: item.variation ? variationLabel(item.variation) : '',
    image: cartItemImage(item),
    permalink: item.product.permalink || ''
  }));
  const total = products.reduce((sum, p) => sum + Number(p.price || 0) * Number(p.quantity || 1), 0);
  return {
    platform: st.country === 'CO' ? 'dropi_colombia' : 'woocommerce',
    store_id: st.id,
    country: st.country,
    currency: st.currency,
    customer: {
      full_name: `${payload.billing.first_name} ${payload.billing.last_name}`.trim(),
      first_name: payload.billing.first_name,
      last_name: payload.billing.last_name,
      document: payload.document || payload.rut,
      email: payload.billing.email,
      phone_number: payload.billing.phone,
      address: payload.billing.address_1,
      address_2: payload.billing.address_2,
      city: payload.billing.city,
      state: payload.billing.state,
      postal_code: payload.billing.postcode,
      country: payload.billing.country
    },
    payment: { method_id: payload.payment_method, method_title: payload.payment_method_title, mode: payload.payment_method === 'cod' ? 'contra_entrega' : 'online_o_manual' },
    products,
    total,
    note: payload.customer_note
  };
}
function platformPayloadToTextLocal(payload) {
  const c = payload.customer || {};
  const products = (payload.products || []).map(p => `- ${p.quantity}x ${p.name}${p.variation ? ` (${p.variation})` : ''} | SKU ${p.sku || 'N/D'} | ${p.price}`).join('
');
  return [`PLATAFORMA: ${payload.platform}`,`PAIS: ${payload.country}`,`NOMBRE: ${c.full_name}`,`DOCUMENTO: ${c.document}`,`TELEFONO: ${c.phone_number}`,`EMAIL: ${c.email}`,`DIRECCION: ${c.address} ${c.address_2 || ''}`.trim(),`CIUDAD: ${c.city}`,`DEPARTAMENTO/REGION: ${c.state}`,`CODIGO POSTAL: ${c.postal_code}`,`METODO PAGO: ${payload.payment?.method_title || payload.payment?.method_id}`,`TOTAL: ${payload.total} ${payload.currency}`,'PRODUCTOS:',products || '- Sin productos',payload.note ? `NOTA: ${payload.note}` : ''].filter(Boolean).join('
');
}
async function copyPlatformData(format='text') {
  try {
    const localPayload = buildPlatformPayloadLocal();
    let output = '';
    try {
      const data = await api('/platform/export-sale', { method:'POST', body: JSON.stringify({ ...buildOrderPayload(), cart: state.cart }) });
      output = format === 'json' ? JSON.stringify(data.payload, null, 2) : data.copy_text;
    } catch (_) {
      output = format === 'json' ? JSON.stringify(localPayload, null, 2) : platformPayloadToTextLocal(localPayload);
    }
    if ($('platformOutput')) $('platformOutput').value = output;
    await navigator.clipboard?.writeText(output).catch(()=>{});
    alert(format === 'json' ? 'JSON técnico copiado.' : 'Datos listos para pegar en plataforma copiados.');
  } catch(e) { alert(e.message); }
}
async function sendSaleSummaryToChat() {
  try {
    let conversationId = $('conversationId').value.trim();
    if (!conversationId) { requestChatwootContext(); await new Promise(r => setTimeout(r, 600)); conversationId = $('conversationId').value.trim(); }
    if (!conversationId) return alert('No se detectó ID de conversación Chatwoot.');
    const data = await api('/platform/export-sale', { method:'POST', body: JSON.stringify({ ...buildOrderPayload(), cart: state.cart }) });
    const msg = `Resumen de compra

${data.copy_text}`;
    await api('/chatwoot/enviar-resumen-venta', { method:'POST', body: JSON.stringify({ conversationId, message: msg, labels: ['rivaida_compra_chat', currentStore().country === 'CO' ? 'dropi' : 'chile'] }) });
    if ($('platformOutput')) $('platformOutput').value = data.copy_text;
    alert('Resumen enviado a la conversación.');
  } catch(e) { alert(e.message); }
}

async function createOrder() {
  $('orderStatus').textContent='';
  try {
    const data = await api('/crear-pedido', { method:'POST', body: JSON.stringify(buildOrderPayload()) });
    state.lastOrder = data.pedido;
    $('orderStatus').style.color = '#15803d';
    $('orderStatus').innerHTML = `Pedido #${data.pedido.numero} creado por ${money(data.pedido.total)}. ${data.pedido.checkout_url ? `<a href="${text(data.pedido.checkout_url)}" target="_blank" rel="noopener">Abrir pago Woo</a>` : ''}`;
    await loadPanel(true);
  } catch(e) { $('orderStatus').style.color = '#b91c1c'; $('orderStatus').textContent = e.message; }
}
async function payOrder() {
  try {
    if (!state.lastOrder) await createOrder();
    if (!state.lastOrder) return;
    const gatewayId = $('paymentMethod')?.value || '';
    const gatewayTitle = $('paymentMethod')?.selectedOptions?.[0]?.textContent || gatewayId;
    const data = await api(`/pedidos/${state.lastOrder.id}/link-pago-woo`, { method:'POST', body: JSON.stringify({ gateway_id: gatewayId, gateway_title: gatewayTitle }) });
    $('orderStatus').style.color = '#15803d';
    $('orderStatus').innerHTML = `Link de pago WooCommerce generado: <a href="${text(data.url)}" target="_blank" rel="noopener">Abrir pago</a>`;
    await navigator.clipboard?.writeText(data.url).catch(()=>{});
    window.open(data.url, '_blank', 'noopener,noreferrer');
  } catch(e) { alert(e.message); }
}
async function createFlowForOrder(orderId) {
  try {
    const gatewayId = $('paymentMethod')?.value || '';
    const gatewayTitle = $('paymentMethod')?.selectedOptions?.[0]?.textContent || gatewayId;
    const data = await api(`/pedidos/${orderId}/link-pago-woo`, { method:'POST', body: JSON.stringify({ gateway_id: gatewayId, gateway_title: gatewayTitle }) });
    await navigator.clipboard?.writeText(data.url).catch(()=>{});
    if ($('orderFlowLink')) $('orderFlowLink').value = data.url;
    window.open(data.url, '_blank', 'noopener,noreferrer');
  } catch(e) { alert(e.message); }
}
function orderStatusOptions(current='') {
  const opts = [['pending','Pendiente'],['processing','Procesando'],['on-hold','En espera'],['completed','Completado'],['cancelled','Cancelado'],['refunded','Reembolsado'],['failed','Fallido']];
  return opts.map(([v,l]) => `<option value="${v}" ${v===current?'selected':''}>${l}</option>`).join('');
}
function showOrderDrawer() {
  const drawer = $('orderDrawer');
  if (!drawer) return;
  drawer.classList.remove('hidden');
  drawer.setAttribute('aria-hidden','false');
  document.body.classList.add('drawer-open');
}
function hideOrderDrawer() {
  const drawer = $('orderDrawer');
  if (!drawer) return;
  drawer.classList.add('hidden');
  drawer.setAttribute('aria-hidden','true');
  document.body.classList.remove('drawer-open');
}
function renderOrderDrawer(p) {
  const lines = (p.line_items || []).map(i => `<tr><td><strong>${text(i.name)}</strong><small class="muted d-block">ID ${text(i.product_id || '')}${i.variation_id ? ` · Var. ${text(i.variation_id)}` : ''}</small></td><td>${text(i.sku || '')}</td><td>${text(i.quantity)}</td><td>${money(i.total)}</td></tr>`).join('');
  const rut = (p.meta_data || []).find(m => /rut/i.test(String(m.key)))?.value || '';
  const address = [p.billing?.address_1,p.billing?.address_2,p.billing?.city,p.billing?.state,p.billing?.postcode].filter(Boolean).join(', ');
  $('orderDrawerTitle').textContent = `Pedido #${p.number || p.id}`;
  $('orderDrawerSubtitle').textContent = `${text(p.status)} · ${money(p.total)} · ${text(p.payment_method_title || 'Sin método')}`;
  $('orderDetailBody').innerHTML = `<div class="order-detail-modern">
    <div class="detail-grid order-detail-grid">
      <div><span>Cliente</span><strong>${text(`${p.billing?.first_name || ''} ${p.billing?.last_name || ''}`.trim() || 'Sin nombre')}</strong><p>${text(p.billing?.email || '')}<br>${text(p.billing?.phone || '')}</p></div>
      <div><span>Dirección</span><strong>${text(p.billing?.city || 'Sin comuna')}</strong><p>${text(address || 'Sin dirección')}</p></div>
      <div><span>RUT</span><strong>${text(rut || 'No registrado')}</strong><p>Campo limpio para Woo/AliDropship</p></div>
      <div><span>Total</span><strong>${money(p.total)}</strong><p>${text(p.currency || 'CLP')}</p></div>
    </div>
    <section class="order-edit-panel">
      <label>Estado del pedido<select id="editOrderStatus">${orderStatusOptions(p.status)}</select></label>
      <label>Nota del pedido<textarea id="editOrderNote" placeholder="Nota visible en el pedido">${text(p.customer_note || '')}</textarea></label>
      <label>Link de pago Flow<input id="orderFlowLink" readonly placeholder="Presiona Generar link pago Woo" /></label>
    </section>
    <section class="order-products-panel">
      <div class="panel-heading"><h3>Productos comprados</h3><span>${(p.line_items || []).length} ítems</span></div>
      <div class="table-responsive"><table class="table align-middle"><thead><tr><th>Producto</th><th>SKU</th><th>Cant.</th><th>Total</th></tr></thead><tbody>${lines || '<tr><td colspan="4">Sin productos</td></tr>'}</tbody></table></div>
    </section>
    <p id="orderEditStatus" class="status-text"></p>
  </div>`;
}
async function viewOrder(orderId) {
  try {
    $('orderDetailBody').innerHTML = '<div class="drawer-loader"><div class="spinner"></div><strong>Cargando pedido...</strong></div>';
    showOrderDrawer();
    const data = await api(`/pedidos/${orderId}`);
    state.selectedOrder = data.pedido;
    renderOrderDrawer(state.selectedOrder);
  } catch(e) { alert(e.message); hideOrderDrawer(); }
}
async function editOrder(orderId) { await viewOrder(orderId); }
async function saveOrderEdits() {
  if (!state.selectedOrder) return;
  const btn = $('saveOrderBtn');
  try {
    btn.disabled = true;
    const payload = { status:$('editOrderStatus').value, customer_note:$('editOrderNote').value };
    const data = await api(`/pedidos/${state.selectedOrder.id}`, { method:'PATCH', body: JSON.stringify(payload) });
    if ($('orderEditStatus')) { $('orderEditStatus').style.color = '#15803d'; $('orderEditStatus').textContent = `Pedido #${data.pedido.numero} actualizado.`; }
    await viewOrder(state.selectedOrder.id);
    await loadPanel(true);
  } catch(e) { alert(e.message); }
  finally { btn.disabled = false; }
}
async function cancelOrderQuick(orderId) {
  if (!confirm('¿Cancelar este pedido?')) return;
  await cancelOrder(orderId);
}
async function cancelSelectedOrder() {
  if (!state.selectedOrder) return;
  if (!confirm('¿Cancelar este pedido? Esta acción cambiará el estado a cancelado.')) return;
  await cancelOrder(state.selectedOrder.id);
  await viewOrder(state.selectedOrder.id);
}
async function cancelOrder(orderId) {
  try {
    await api(`/pedidos/${orderId}/cancelar`, { method:'POST', body: JSON.stringify({ customer_note:'Pedido cancelado desde panel Chatwoot.' }) });
    await loadPanel(true);
  } catch(e) { alert(e.message); }
}
async function deleteSelectedOrder() {
  if (!state.selectedOrder) return;
  const msg = '¿Eliminar este pedido? Se moverá a la papelera de WooCommerce. Esta acción no borra forzado.';
  if (!confirm(msg)) return;
  try {
    await api(`/pedidos/${state.selectedOrder.id}`, { method:'DELETE' });
    hideOrderDrawer();
    await loadPanel(true);
  } catch(e) { alert(e.message); }
}
async function flowSelectedOrder() {
  if (!state.selectedOrder) return;
  await createFlowForOrder(state.selectedOrder.id);
}
async function searchOrders() {
  const q = $('orderSearchInput')?.value?.trim() || '';
  if (!q) return renderOrders(state.pedidos);
  try {
    const data = await api(`/pedidos/buscar?q=${encodeURIComponent(q)}&limit=30`);
    state.orderSearchResults = data.pedidos || [];
    renderOrders(state.orderSearchResults);
  } catch(e) { alert(e.message); }
}
function clearOrderSearch() {
  if ($('orderSearchInput')) $('orderSearchInput').value = '';
  state.orderSearchResults = [];
  renderOrders(state.pedidos);
}
async function applyLabels() { const conversationId = $('conversationId').value.trim(); const labels = $('labelInput').value.split(',').map(x=>x.trim()).filter(Boolean); if (!conversationId || !labels.length) return alert('Ingrese conversacion y etiquetas separadas por coma.'); await api('/chatwoot/etiquetas', { method:'POST', body: JSON.stringify({ conversationId, labels, merge: true }) }); alert('Etiquetas aplicadas sin borrar las existentes.'); }

function applyThemeSettings() {
  document.documentElement.dataset.theme = state.themeMode;
  document.documentElement.dataset.accent = state.themeAccent;
  if ($('themeMode')) $('themeMode').value = state.themeMode;
  if ($('themeAccent')) $('themeAccent').value = state.themeAccent;
}
function updateTheme(mode, accent) {
  state.themeMode = mode || state.themeMode || 'light';
  state.themeAccent = accent || state.themeAccent || 'teal';
  localStorage.setItem('panelThemeMode', state.themeMode);
  localStorage.setItem('panelThemeAccent', state.themeAccent);
  applyThemeSettings();
}


function recommendationPayload() {
  return {
    cliente: state.cliente,
    pedidos: state.pedidos,
    cart: state.cart,
    email: $('customerEmail')?.value?.trim() || '',
    rut: $('billingRut')?.value?.trim() || '',
    region: $('billingRegion')?.value || '',
    comuna: $('billingComuna')?.value || '',
    conversationId: $('conversationId')?.value?.trim() || '',
    store: state.activeStore,
    country: currentStore().country
  };
}
function renderRecommendations(rec) {
  const box = $('recommendationBox');
  if (!box) return;
  if (!rec) { box.className = 'recommendation-box muted'; box.textContent = 'Sin recomendaciones todavía.'; return; }
  box.className = 'recommendation-box';
  box.innerHTML = `<div class="rec-labels">${(rec.labels || []).map(l => `<span>${text(l)}</span>`).join('')}</div><div class="rec-grid"><div><strong>Motivos</strong><ul>${(rec.reasons || []).map(r => `<li>${text(r)}</li>`).join('')}</ul></div><div><strong>Próximos pasos</strong><ul>${(rec.next_actions || []).map(r => `<li>${text(r)}</li>`).join('')}</ul></div></div><label>Respuesta sugerida<textarea id="suggestedMessageBox">${text(rec.suggested_message || '')}</textarea></label>${rec.ai ? '<p class="mini ok">IA conectada</p>' : '<p class="mini">Reglas locales</p>'}${rec.ai_error ? `<p class="mini bad">IA no disponible: ${text(rec.ai_error)}</p>` : ''}`;
}
async function recommendLabels() {
  try {
    const data = await api('/chatwoot/recomendaciones', { method:'POST', body: JSON.stringify(recommendationPayload()) });
    state.recommendations = data.recommendations;
    renderRecommendations(state.recommendations);
    if ($('labelInput') && state.recommendations?.labels?.length) $('labelInput').value = state.recommendations.labels.join(', ');
  } catch (e) { alert(e.message); }
}
async function applyRecommendedLabels() {
  const conversationId = $('conversationId').value.trim();
  if (!conversationId) return alert('Ingrese ID de conversación Chatwoot.');
  if (!state.recommendations) await recommendLabels();
  const labels = state.recommendations?.labels || [];
  if (!labels.length) return alert('No hay etiquetas recomendadas.');
  await api('/chatwoot/etiquetas', { method:'POST', body: JSON.stringify({ conversationId, labels, merge: true }) });
  alert('Etiquetas recomendadas aplicadas sin borrar las existentes.');
}
async function copyRecommendation() {
  const msg = $('suggestedMessageBox')?.value || state.recommendations?.suggested_message || '';
  if (!msg) return alert('Primero genera una recomendación.');
  await navigator.clipboard.writeText(msg);
  alert('Respuesta copiada.');
}


async function setupChatwootLabels() {
  const data = await api('/chatwoot/etiquetas/setup', { method:'POST', body:'{}' });
  alert(`Etiquetas revisadas/creadas: ${data.results?.length || 0}`);
}
async function setupChatwootAttributes() {
  const data = await api('/chatwoot/atributos/setup', { method:'POST', body:'{}' });
  alert(`Atributos revisados/creados: ${data.results?.length || 0}`);
}
async function saveConversationAttributes() {
  const conversationId = $('conversationId').value.trim();
  if (!conversationId) return alert('Primero conecta una conversación.');
  const cartTotal = state.cart.reduce((sum, item) => sum + Number(item.variation?.precio || item.product?.precio || 0) * Number(item.quantity || 1), 0);
  const custom_attributes = {
    rivaida_estado: state.cart.length ? 'carrito_armado' : 'contacto_revisado',
    rivaida_email_detectado: $('customerEmail')?.value?.trim() || '',
    rivaida_carrito_total: cartTotal ? String(Math.round(cartTotal)) : '',
    rivaida_rut_validado: $('rutStatus')?.classList?.contains('ok') ? 'true' : 'false',
    rivaida_ultimo_producto: state.cart[0]?.product?.nombre || '',
    rivaida_ultimo_sku: state.cart[0]?.variation?.sku || state.cart[0]?.product?.sku || ''
  };
  await api('/chatwoot/atributos/conversacion', { method:'POST', body: JSON.stringify({ conversationId, custom_attributes }) });
  alert('Atributos guardados en la conversación.');
}


function toggleSettings(show=true) {
  const panel = $('settingsPanel');
  if (!panel) return;
  panel.classList.toggle('hidden', !show);
  if (show) loadSettings().catch(e => { if ($('settingsStatus')) $('settingsStatus').textContent = e.message; });
}
function fillSettingsForm(settings = {}) {
  document.querySelectorAll('[data-setting]').forEach((el) => {
    const key = el.dataset.setting;
    el.value = settings[key] ?? '';
  });
}
function collectSettingsForm() {
  const settings = {};
  document.querySelectorAll('[data-setting]').forEach((el) => { settings[el.dataset.setting] = el.value.trim(); });
  return settings;
}
async function loadSettings() {
  const data = await api('/admin/settings');
  state.settings = data.settings || {};
  fillSettingsForm(state.settings);
  if ($('settingsStatus')) $('settingsStatus').textContent = data.postgres ? 'Configuración guardada correctamente.' : 'Configuración temporal: revisa la conexión de base de datos.';
}
async function saveSettings() {
  const settings = collectSettingsForm();
  const data = await api('/admin/settings', { method:'POST', body: JSON.stringify({ settings }) });
  state.settings = { ...state.settings, ...settings };
  if ($('settingsStatus')) $('settingsStatus').textContent = `Guardado: ${data.saved_keys?.length || 0} variables. Recargando tiendas...`;
  await loadSettings().catch(()=>{});
  await loadStores();
  await loadRegiones(true);
  await loadCategorias(true);
  await loadPaymentMethods(true);
  alert('Credenciales guardadas. Si cambiaste dominio o CORS, ejecuta Deploy/Restart en EasyPanel para asegurar proxy y caché limpios.');
}
async function testSettings(target, store='') {
  try {
    const data = await api('/admin/settings/test', { method:'POST', body: JSON.stringify({ target, store }) });
    alert(`Prueba correcta: ${JSON.stringify(data, null, 2)}`);
  } catch (e) { alert(`Error en prueba: ${e.message}`); }
}

async function clearCache() { localStorage.removeItem(`regiones_${state.activeStore}_v74`); await api('/cache/clear', { method:'POST', body:'{}' }); setLoadingState('Limpio'); alert('Cache limpiado.'); }
$('loginForm').addEventListener('submit', async (e)=>{ e.preventDefault(); $('loginError').textContent=''; state.auth = btoa(`${$('loginUser').value.trim()}:${$('loginPassword').value}`); state.panelToken = ''; localStorage.removeItem('panelToken'); try { await api('/stores'); localStorage.setItem('panelAuth', state.auth); await enterApp(); } catch { $('loginError').textContent = 'Credenciales incorrectas o servidor no disponible.'; state.auth=''; } });
$('openSettingsBtn')?.addEventListener('click', () => toggleSettings(true));
$('closeSettingsBtn')?.addEventListener('click', () => toggleSettings(false));
$('saveSettingsBtn')?.addEventListener('click', saveSettings);
$('testWooClBtn')?.addEventListener('click', () => testSettings('woo','cl'));
$('testWooCoBtn')?.addEventListener('click', () => testSettings('woo','co'));
$('testChatwootBtn')?.addEventListener('click', () => testSettings('chatwoot'));
$('logoutBtn').addEventListener('click', ()=>{ localStorage.removeItem('panelAuth'); localStorage.removeItem('panelToken'); state.auth=''; state.panelToken=''; showLogin(); });
$('loadBtn').addEventListener('click', () => loadPanel(false));
$('refreshOrdersBtn')?.addEventListener('click', () => loadPanel(true));
$('refreshProductsBtn').addEventListener('click', () => loadProducts(true));
$('syncProductsBtn')?.addEventListener('click', syncProducts);
$('loadMoreBtn')?.addEventListener('click', () => loadProducts(false, true));
$('clearCacheBtn').addEventListener('click', clearCache);
$('productFilter').addEventListener('input', scheduleProductSearch);
$('categoryFilter')?.addEventListener('change', () => loadProducts(false));
$('saleFilter')?.addEventListener('change', () => loadProducts(false));
$('stockFilter')?.addEventListener('change', () => loadProducts(false));
$('createOrderBtn').addEventListener('click', createOrder); $('payBtn').addEventListener('click', payOrder);
$('copyPlatformBtn')?.addEventListener('click', () => copyPlatformData('text'));
$('copyPlatformJsonBtn')?.addEventListener('click', () => copyPlatformData('json'));
$('sendSaleSummaryBtn')?.addEventListener('click', sendSaleSummaryToChat);
$('billingRegion').addEventListener('change', () => renderComunas($('billingRegion').value));
$('billingComuna').addEventListener('change', updatePostcode);
$('billingRut').addEventListener('input', updateRutStatus);
$('applyLabelsBtn').addEventListener('click', applyLabels);
$('fetchChatwootContextBtn')?.addEventListener('click', () => enrichContextFromServer().catch(e => alert(e.message)));
$('setupLabelsBtn')?.addEventListener('click', setupChatwootLabels);
$('setupAttributesBtn')?.addEventListener('click', setupChatwootAttributes);
$('saveConversationAttributesBtn')?.addEventListener('click', saveConversationAttributes);
$('recommendBtn')?.addEventListener('click', recommendLabels);
$('applyRecommendedLabelsBtn')?.addEventListener('click', applyRecommendedLabels);
$('copyRecommendationBtn')?.addEventListener('click', copyRecommendation);
$('saveOrderBtn')?.addEventListener('click', saveOrderEdits);
$('closeOrderDrawerBtn')?.addEventListener('click', hideOrderDrawer);
$('drawerBackBtn')?.addEventListener('click', hideOrderDrawer);
$('orderDrawerBackdrop')?.addEventListener('click', hideOrderDrawer);
$('cancelOrderBtn')?.addEventListener('click', cancelSelectedOrder);
$('deleteOrderBtn')?.addEventListener('click', deleteSelectedOrder);
$('flowOrderDrawerBtn')?.addEventListener('click', flowSelectedOrder);
$('searchOrdersBtn')?.addEventListener('click', searchOrders);
$('clearOrderSearchBtn')?.addEventListener('click', clearOrderSearch);
$('orderSearchInput')?.addEventListener('keydown', (e)=>{ if(e.key==='Enter') searchOrders(); });
$('storeSelect')?.addEventListener('change', () => changeStore($('storeSelect').value).catch(e => alert(e.message)));
$('themeMode')?.addEventListener('change', () => updateTheme($('themeMode').value, $('themeAccent')?.value));
$('themeAccent')?.addEventListener('change', () => updateTheme($('themeMode')?.value, $('themeAccent').value));
applyThemeSettings();
testAuth();
