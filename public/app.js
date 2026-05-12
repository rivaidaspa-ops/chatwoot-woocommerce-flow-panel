const state = {
  auth: localStorage.getItem('panelAuth') || '',
  panelToken: localStorage.getItem('panelToken') || '',
  cliente: null,
  pedidos: [],
  productos: [],
  regiones: [],
  categorias: [],
  cart: [],
  lastOrder: null,
  productOffset: 0,
  productLimit: 20,
  productTotal: 0,
  productLoading: false,
  syncTimer: null,
  themeMode: localStorage.getItem('panelThemeMode') || 'light',
  themeAccent: localStorage.getItem('panelThemeAccent') || 'teal'
};
const $ = (id) => document.getElementById(id);
const money = (v) => `$${Number(v || 0).toLocaleString('es-CL')} CLP`;
const text = (v) => String(v ?? '').replace(/[<>&"]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
const normalize = (s='') => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
function readUrlParams() {
  const p = new URLSearchParams(location.search);
  const token = p.get('panel_token') || p.get('token') || '';
  if (token) { state.panelToken = token; localStorage.setItem('panelToken', token); }
  const email = p.get('email') || p.get('email_cliente') || p.get('customer_email') || p.get('contact_email') || '';
  const conversationId = p.get('conversation_id') || p.get('conversationId') || p.get('conversation.id') || p.get('cw_conversation_id') || '';
  if (email && $('customerEmail')) $('customerEmail').value = email;
  if (conversationId && $('conversationId')) $('conversationId').value = conversationId;
}
function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (state.panelToken) headers['x-panel-token'] = state.panelToken;
  else if (state.auth) headers.Authorization = `Basic ${state.auth}`;
  return headers;
}
async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) }, credentials: 'same-origin' });
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
  await loadRegiones();
  await loadCategorias();
  readUrlParams();
  const email = $('customerEmail').value.trim();
  if (email) loadPanel(false); else loadProducts(false);
}
async function testAuth() {
  readUrlParams();
  if (!state.auth && !state.panelToken) return showLogin();
  try { await api('/regiones'); await enterApp(); }
  catch { localStorage.removeItem('panelAuth'); if (!state.panelToken) showLogin(); else showLogin(); }
}
async function loadRegiones(force=false) {
  const cached = !force && readLocal('regionesChileV6', 86400000 * 30);
  if (cached) { state.regiones = cached; renderRegionOptions(); return; }
  const data = await api('/regiones');
  state.regiones = data.regiones || [];
  saveLocal('regionesChileV6', state.regiones);
  renderRegionOptions();
}
async function loadCategorias(force=false) {
  try {
    const data = await api(`/categorias${force ? '?refresh=true' : ''}`);
    state.categorias = data.categorias || [];
    const sel = $('categoryFilter');
    if (sel) sel.innerHTML = '<option value="">Todas las categorias</option>' + state.categorias.map(c => `<option value="${text(c.name || c)}">${text(c.name || c)}${c.count ? ` (${c.count})` : ''}</option>`).join('');
  } catch (e) { console.warn(e.message); }
}
function renderRegionOptions() {
  if (!$('billingRegion')) return;
  $('billingRegion').innerHTML = '<option value="">Seleccione region</option>' + state.regiones.map(r => `<option value="${text(r.codigo)}">${text(r.region)}</option>`).join('');
}
function renderComunas(regionCode, selectedComuna='') {
  const region = state.regiones.find(r => r.codigo === regionCode);
  const comunas = region?.comunas || [];
  $('billingComuna').disabled = !comunas.length;
  $('billingComuna').innerHTML = '<option value="">Seleccione comuna</option>' + comunas.map(c => `<option value="${text(c.comuna)}" data-postcode="${text(c.postcode)}">${text(c.comuna)}</option>`).join('');
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
  const rut = $('billingRut').value.trim(); const ok = validateRutLocal(rut);
  $('rutStatus').textContent = rut ? (ok ? 'RUT valido' : 'RUT invalido') : 'RUT pendiente de validar';
  $('rutStatus').className = `mini muted-line ${rut ? (ok ? 'ok' : 'bad') : ''}`;
}
function renderClient() {
  const c = state.cliente; if (!c) return;
  const d = c.direccion || {};
  $('clientInfo').innerHTML = `<div class="client-row"><strong>Nombre</strong><span>${text(c.nombre || 'No registrado')}</span></div><div class="client-row"><strong>Email</strong><span>${text(c.email || '')}</span></div><div class="client-row"><strong>RUT</strong><span>${text(c.rut || 'No registrado')}</span></div><div class="client-row"><strong>Telefono</strong><span>${text(c.telefono || d.phone || '')}</span></div><div class="client-row"><strong>Region</strong><span>${text(d.region_nombre || d.state || 'Sin region')}</span></div><div class="client-row"><strong>Direccion</strong><span>${text([d.address_1,d.address_2,d.city,d.postcode,d.country].filter(Boolean).join(', ') || 'Sin direccion')}</span></div>`;
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
function renderOrders() {
  setMetric('metricOrders', state.pedidos.length);
  if (!state.pedidos.length) { $('ordersList').innerHTML = '<span class="muted">Este cliente no registra pedidos.</span>'; return; }
  $('ordersList').innerHTML = state.pedidos.map(o => `<article class="order-card"><div class="order-head"><div><h3>Pedido #${text(o.numero)}</h3><p class="muted">${new Date(o.fecha).toLocaleDateString('es-CL')} · ${text(o.metodo_pago || 'Sin metodo')} · RUT ${text(o.rut || 'N/D')}</p></div><span class="badge ${text(o.estado)}">${text(o.estado)}</span></div><p class="price">${money(o.total)}</p><p class="muted">${text((o.productos || []).map(p => `${p.cantidad}x ${p.nombre}`).join(', '))}</p></article>`).join('');
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
function renderCart() {
  if (!state.cart.length) { $('cartBox').innerHTML = 'Seleccione productos o variaciones para el pedido.'; return; }
  const total = state.cart.reduce((s,i)=>s+Number(i.variation?.precio || i.product.precio || 0)*i.quantity,0);
  $('cartBox').innerHTML = state.cart.map(i => `<div class="cart-item"><span>${i.quantity}x ${text(i.product.nombre)} ${i.variation ? `<small>(${text(variationLabel(i.variation))})</small>` : ''}</span><strong>${money(Number(i.variation?.precio || i.product.precio || 0)*i.quantity)}</strong><button class="tiny" onclick="removeFromCart('${text(i.key)}')">Quitar</button></div>`).join('') + `<p class="price">Total: ${money(total)}</p>`;
}
async function sendToConversation(product, quantity, variation=null) {
  const conversationId = $('conversationId').value.trim(); if (!conversationId) return alert('Ingrese ID conversacion Chatwoot.');
  await api('/chatwoot/enviar-producto', { method:'POST', body: JSON.stringify({ conversationId, product, variation, quantity }) }); alert('Producto enviado a la conversacion.');
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
  setLoadingState(force ? 'Actualizando' : 'Buscando', 'Consultando cache, Postgres o WooCommerce');
  try {
    const endpoint = `/productos/search?${buildProductSearchParams(nextOffset)}${force ? '&refresh=true' : ''}`;
    const data = await api(endpoint);
    const incoming = data.productos || [];
    state.productos = append ? [...state.productos, ...incoming] : incoming;
    state.productTotal = Number(data.total || state.productos.length);
    state.productOffset = state.productos.length;
    renderProducts();
    setLoadingState(data.source === 'postgres' ? 'Postgres' : (data.cached ? 'Cache' : 'WooCommerce'), `${state.productos.length}/${state.productTotal} productos`);
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
  const email = $('customerEmail').value.trim(); const regionCode = $('billingRegion').value; const comuna = $('billingComuna').value; const rut = $('billingRut').value.trim();
  if (!state.cart.length) throw new Error('Agregue al menos un producto.');
  const required = ['billingFirstName','billingLastName','billingRut','billingPhone','billingAddress']; for (const id of required) if (!$(id).value.trim()) throw new Error('Complete nombre, apellido, RUT, telefono y direccion.');
  if (!validateRutLocal(rut)) throw new Error('Ingrese un RUT valido.');
  if (!regionCode || !comuna) throw new Error('Seleccione region y comuna.');
  const billing = { first_name:$('billingFirstName').value.trim(), last_name:$('billingLastName').value.trim(), email, phone:$('billingPhone').value.trim(), rut, address_1:$('billingAddress').value.trim(), address_2:$('billingAddress2').value.trim(), city:comuna, postcode:$('billingPostcode').value.trim(), state:regionCode, country:'CL' };
  return { rut, region: regionCode, comuna, postcode: billing.postcode, billing, shipping: billing, payment_method:$('paymentMethod').value, payment_method_title:$('paymentMethod').value === 'flow' ? 'Flow - Webpay / Multicaja' : $('paymentMethod').value, line_items: state.cart.map(i => ({ product_id:i.product.id, variation_id:i.variation?.id, quantity:i.quantity })), customer_note:$('customerNote').value.trim() || 'Pedido creado desde panel Chatwoot.', meta_data:[{key:'_chatwoot_conversation_id', value:$('conversationId').value.trim()}] };
}
async function createOrder() { $('orderStatus').textContent=''; try { const data = await api('/crear-pedido', { method:'POST', body: JSON.stringify(buildOrderPayload()) }); state.lastOrder = data.pedido; $('orderStatus').style.color = '#15803d'; $('orderStatus').textContent = `Pedido #${data.pedido.numero} creado por ${money(data.pedido.total)}.`; await loadPanel(true); } catch(e) { $('orderStatus').style.color = '#b91c1c'; $('orderStatus').textContent = e.message; } }
async function payOrder() { try { if (!state.lastOrder) await createOrder(); if (!state.lastOrder) return; const data = await api('/pagar', { method:'POST', body: JSON.stringify({ orderId:state.lastOrder.id, amount:state.lastOrder.total, email:$('customerEmail').value.trim(), subject:`Pedido #${state.lastOrder.numero}` }) }); window.open(data.url, '_blank', 'noopener,noreferrer'); } catch(e) { alert(e.message); } }
async function applyLabels() { const conversationId = $('conversationId').value.trim(); const labels = $('labelInput').value.split(',').map(x=>x.trim()).filter(Boolean); if (!conversationId || !labels.length) return alert('Ingrese conversacion y etiquetas separadas por coma.'); await api('/chatwoot/etiquetas', { method:'POST', body: JSON.stringify({ conversationId, labels }) }); alert('Etiquetas aplicadas.'); }

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

async function clearCache() { localStorage.removeItem('regionesChileV6'); await api('/cache/clear', { method:'POST', body:'{}' }); setLoadingState('Limpio'); alert('Cache limpiado.'); }
$('loginForm').addEventListener('submit', async (e)=>{ e.preventDefault(); $('loginError').textContent=''; state.auth = btoa(`${$('loginUser').value.trim()}:${$('loginPassword').value}`); state.panelToken = ''; localStorage.removeItem('panelToken'); try { await api('/regiones'); localStorage.setItem('panelAuth', state.auth); await enterApp(); } catch { $('loginError').textContent = 'Credenciales incorrectas o servidor no disponible.'; state.auth=''; } });
$('logoutBtn').addEventListener('click', ()=>{ localStorage.removeItem('panelAuth'); localStorage.removeItem('panelToken'); state.auth=''; state.panelToken=''; showLogin(); });
$('loadBtn').addEventListener('click', () => loadPanel(false));
$('refreshProductsBtn').addEventListener('click', () => loadProducts(true));
$('syncProductsBtn')?.addEventListener('click', syncProducts);
$('loadMoreBtn')?.addEventListener('click', () => loadProducts(false, true));
$('clearCacheBtn').addEventListener('click', clearCache);
$('productFilter').addEventListener('input', scheduleProductSearch);
$('categoryFilter')?.addEventListener('change', () => loadProducts(false));
$('saleFilter')?.addEventListener('change', () => loadProducts(false));
$('stockFilter')?.addEventListener('change', () => loadProducts(false));
$('createOrderBtn').addEventListener('click', createOrder); $('payBtn').addEventListener('click', payOrder);
$('billingRegion').addEventListener('change', () => renderComunas($('billingRegion').value));
$('billingComuna').addEventListener('change', updatePostcode);
$('billingRut').addEventListener('input', updateRutStatus);
$('applyLabelsBtn').addEventListener('click', applyLabels);
$('themeMode')?.addEventListener('change', () => updateTheme($('themeMode').value, $('themeAccent')?.value));
$('themeAccent')?.addEventListener('change', () => updateTheme($('themeMode')?.value, $('themeAccent').value));
applyThemeSettings();
testAuth();
