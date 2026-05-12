const state = {
  auth: localStorage.getItem('panelAuth') || '', cliente: null, pedidos: [], productos: [], regiones: [], cart: [], lastOrder: null,
  productsLoadedAt: 0
};
const $ = (id) => document.getElementById(id);
const money = (v) => `$${Number(v || 0).toLocaleString('es-CL')} CLP`;
const text = (v) => String(v ?? '').replace(/[<>&]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
const normalize = (s='') => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
function authHeaders() { return { Authorization: `Basic ${state.auth}`, 'Content-Type': 'application/json' }; }
async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error de servidor');
  return data;
}
function showApp() { $('loginScreen').classList.add('hidden'); $('app').classList.remove('hidden'); }
function showLogin() { $('loginScreen').classList.remove('hidden'); $('app').classList.add('hidden'); }
function setLoading(message) { $('metricCache').textContent = message; }
function saveLocal(key, value) { localStorage.setItem(key, JSON.stringify({ value, time: Date.now() })); }
function readLocal(key, maxAgeMs) { try { const raw = JSON.parse(localStorage.getItem(key) || 'null'); if (!raw || Date.now() - raw.time > maxAgeMs) return null; return raw.value; } catch { return null; } }
async function testAuth() { try { await api('/health'); showApp(); await loadRegiones(); readChatwootParams(); } catch { localStorage.removeItem('panelAuth'); state.auth = ''; showLogin(); } }
function readChatwootParams() {
  const p = new URLSearchParams(location.search);
  const email = p.get('email') || p.get('email_cliente') || p.get('customer_email') || '';
  const conversationId = p.get('conversation_id') || p.get('conversationId') || p.get('conversation.id') || '';
  if (email) $('customerEmail').value = email;
  if (conversationId) $('conversationId').value = conversationId;
  if (email) loadPanel();
}
async function loadRegiones(force=false) {
  const cached = !force && readLocal('regionesChileV2', 86400000 * 30);
  if (cached) { state.regiones = cached; renderRegionOptions(); return; }
  const data = await api('/regiones');
  state.regiones = data.regiones || [];
  saveLocal('regionesChileV2', state.regiones);
  renderRegionOptions();
}
function renderRegionOptions() {
  $('billingRegion').innerHTML = '<option value="">Seleccione región</option>' + state.regiones.map(r => `<option value="${text(r.codigo)}">${text(r.region)}</option>`).join('');
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
  const rut = $('billingRut').value.trim();
  const ok = validateRutLocal(rut);
  $('rutStatus').textContent = rut ? (ok ? 'RUT válido' : 'RUT inválido') : 'RUT pendiente de validar';
  $('rutStatus').className = `mini muted-line ${rut ? (ok ? 'ok' : 'bad') : ''}`;
}
function renderClient() {
  const c = state.cliente; if (!c) return;
  const d = c.direccion || {};
  $('clientInfo').innerHTML = `<div class="client-row"><strong>Nombre</strong><span>${text(c.nombre || 'No registrado')}</span></div><div class="client-row"><strong>Email</strong><span>${text(c.email || '')}</span></div><div class="client-row"><strong>RUT</strong><span>${text(c.rut || 'No registrado')}</span></div><div class="client-row"><strong>Teléfono</strong><span>${text(c.telefono || d.phone || '')}</span></div><div class="client-row"><strong>Región</strong><span>${text(d.region_nombre || d.state || 'Sin región')}</span></div><div class="client-row"><strong>Dirección</strong><span>${text([d.address_1,d.address_2,d.city,d.postcode,d.country].filter(Boolean).join(', ') || 'Sin dirección')}</span></div>`;
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
  $('metricOrders').textContent = state.pedidos.length;
  if (!state.pedidos.length) { $('ordersList').innerHTML = '<span class="muted">Este cliente no registra pedidos.</span>'; return; }
  $('ordersList').innerHTML = state.pedidos.map(o => `<article class="order-card"><div class="order-head"><div><h3>Pedido #${text(o.numero)}</h3><p class="muted">${new Date(o.fecha).toLocaleDateString('es-CL')} · ${text(o.metodo_pago || 'Sin método')} · RUT ${text(o.rut || 'N/D')}</p></div><span class="badge ${text(o.estado)}">${text(o.estado)}</span></div><p class="price">${money(o.total)}</p><p class="muted">${text((o.productos || []).map(p => `${p.cantidad}x ${p.nombre}`).join(', '))}</p></article>`).join('');
}
function variationLabel(v) { return (v.atributos || []).filter(a => a.option).map(a => `${a.name}: ${a.option}`).join(' · ') || v.sku || `Variación ${v.id}`; }
function isNoisyAttribute(name='') {
  const n = normalize(name);
  return ['size_info','sizelist','sizes','ali','aliexpress','shipping','logistics','product chemical','producto quimico','origen','cn','lugar aplicable','numero de modelo'].some(x => n.includes(x));
}
function visibleAttributes(product) {
  return (product.atributos || [])
    .filter(a => a && a.name && !isNoisyAttribute(a.name))
    .filter(a => Array.isArray(a.options) && a.options.length && JSON.stringify(a.options).length < 280)
    .slice(0, 10);
}
function variationImage(product, variation) { return variation?.imagen || product.imagen || product.imagenes?.[0]?.src || ''; }
function formatVariationOption(v) {
  const attrs = (v.atributos || []).filter(a => a.option && !isNoisyAttribute(a.name)).map(a => `${a.name}: ${a.option}`).join(' · ');
  return `${attrs || v.sku || 'Variación'} · SKU ${v.sku || 'N/D'} · Stock ${v.stock ?? v.stock_status} · ${money(v.precio)}`;
}
function updateVariationPreview(productId) {
  const product = state.productos.find(p => String(p.id) === String(productId)); if (!product) return;
  const variation = selectedVariation(product);
  const img = $(`main-img-${product.id}`); if (img) img.src = variationImage(product, variation);
  const price = $(`price-${product.id}`); if (price) price.textContent = money(variation?.precio || product.precio);
  const meta = $(`meta-${product.id}`); if (meta) meta.textContent = `SKU: ${variation?.sku || product.sku || 'Sin SKU'} · Stock: ${variation?.stock ?? product.stock ?? product.stock_status} · ${variation ? 'Variación seleccionada' : 'Producto simple'}`;
  const selected = $(`selected-${product.id}`); if (selected) selected.textContent = variation ? variationLabel(variation) : '';
}
function productSearchString(p) { return normalize([p.nombre,p.sku,(p.etiquetas||[]).join(' '),(p.categorias||[]).join(' '),(p.atributos||[]).map(a=>`${a.name} ${(a.options||[]).join(' ')}`).join(' '),(p.variations||[]).map(v=>`${v.sku} ${variationLabel(v)}`).join(' '),JSON.stringify(p.meta||{})].join(' ')); }
function selectedVariation(product) { const id = $(`var-${product.id}`)?.value || ''; return (product.variations || []).find(v => String(v.id) === String(id)) || null; }
function renderProducts() {
  const q = normalize($('productFilter').value.trim());
  const filtered = state.productos.filter(p => !q || productSearchString(p).includes(q));
  const variationCount = state.productos.reduce((s,p)=>s+(p.variations||[]).length,0);
  $('metricProducts').textContent = state.productos.length;
  $('metricVariations').textContent = variationCount;
  if (!filtered.length) { $('productsList').innerHTML = '<span class="muted">No hay productos disponibles.</span>'; return; }
  $('productsList').innerHTML = filtered.map(p => {
    const variations = p.variations || [];
    const defaultVariation = variations[0] || null;
    const attrBadges = visibleAttributes(p).map(a => `<span class="mini">${text(a.name)}: ${text((a.options||[]).join(', '))}</span>`).join('');
    const tagBadges = (p.etiquetas || []).slice(0,4).map(t => `<span class="mini tag">${text(t)}</span>`).join('');
    const mainImage = variationImage(p, defaultVariation);
    const thumbs = [p.imagen, ...(p.imagenes || []).map(i=>i.src), ...variations.map(v=>v.imagen)].filter(Boolean);
    const uniqueThumbs = [...new Set(thumbs)].slice(0,5).map(src => `<button class="thumb" type="button" data-thumb="${p.id}" data-src="${text(src)}"><img src="${text(src)}" alt="${text(p.nombre)}" loading="lazy"></button>`).join('');
    const imageBlock = mainImage ? `<div class="main-product-image"><img id="main-img-${p.id}" src="${text(mainImage)}" alt="${text(p.nombre)}" loading="lazy"></div><div class="thumb-row">${uniqueThumbs}</div>` : '<div class="no-img">Sin imagen</div>';
    const varSelect = variations.length ? `<label class="variation-box"><span>Seleccionar variación</span><select id="var-${p.id}" class="variation-select" data-product-id="${p.id}">${variations.map(v => `<option value="${v.id}">${text(formatVariationOption(v))}</option>`).join('')}</select><small id="selected-${p.id}" class="selected-variation">${text(defaultVariation ? variationLabel(defaultVariation) : '')}</small></label>` : '<p class="muted">Producto simple</p>';
    return `<article class="product-card"><div class="gallery">${imageBlock}</div><div><div class="product-head"><div><h3>${text(p.nombre)}</h3><p id="meta-${p.id}" class="muted">SKU: ${text(defaultVariation?.sku || p.sku)} · Stock: ${text(defaultVariation?.stock ?? p.stock ?? p.stock_status)} · ${variations.length ? 'Producto variable' : 'Producto simple'}</p></div><span id="price-${p.id}" class="price">${money(defaultVariation?.precio || p.precio)}</span></div><div class="badges">${attrBadges}${tagBadges}</div>${varSelect}<div class="product-actions"><input id="qty-${p.id}" class="qty" type="number" min="1" value="1"><button data-add="${p.id}">Agregar</button><button class="secondary" data-send="${p.id}">Enviar a conversación</button></div></div></article>`;
  }).join('');
  document.querySelectorAll('.variation-select').forEach(sel => sel.addEventListener('change', () => updateVariationPreview(sel.dataset.productId)));
  document.querySelectorAll('[data-thumb]').forEach(btn => btn.addEventListener('click', () => { const img = $(`main-img-${btn.dataset.thumb}`); if (img) img.src = btn.dataset.src; }));
  document.querySelectorAll('[data-add]').forEach(btn => btn.addEventListener('click', () => { const p = state.productos.find(x => String(x.id) === btn.dataset.add); addToCart(p, Math.max(1, Number($(`qty-${p.id}`).value || 1)), selectedVariation(p)); }));
  document.querySelectorAll('[data-send]').forEach(btn => btn.addEventListener('click', async () => { const p = state.productos.find(x => String(x.id) === btn.dataset.send); try { await sendToConversation(p, Math.max(1, Number($(`qty-${p.id}`).value || 1)), selectedVariation(p)); } catch(e) { alert(e.message); } }));
}
function addToCart(product, quantity, variation=null) { const key = `${product.id}:${variation?.id || 0}`; const ex = state.cart.find(i => i.key === key); if (ex) ex.quantity += quantity; else state.cart.push({ key, product, variation, quantity }); renderCart(); }
function removeFromCart(key) { state.cart = state.cart.filter(i => i.key !== key); renderCart(); }
function renderCart() {
  if (!state.cart.length) { $('cartBox').innerHTML = 'Seleccione productos o variaciones para el pedido.'; return; }
  const total = state.cart.reduce((s,i)=>s+Number(i.variation?.precio || i.product.precio || 0)*i.quantity,0);
  $('cartBox').innerHTML = state.cart.map(i => `<div class="cart-item"><span>${i.quantity}x ${text(i.product.nombre)} ${i.variation ? `<small>(${text(variationLabel(i.variation))})</small>` : ''}</span><strong>${money(Number(i.variation?.precio || i.product.precio || 0)*i.quantity)}</strong><button class="tiny" onclick="removeFromCart('${text(i.key)}')">Quitar</button></div>`).join('') + `<p class="price">Total: ${money(total)}</p>`;
}
async function sendToConversation(product, quantity, variation=null) {
  const conversationId = $('conversationId').value.trim(); if (!conversationId) return alert('Ingrese ID conversación Chatwoot.');
  await api('/chatwoot/enviar-producto', { method:'POST', body: JSON.stringify({ conversationId, product, variation, quantity }) }); alert('Producto enviado a la conversación.');
}
async function loadProducts(force=false) {
  setLoading(force ? 'Actualizando' : 'Cargando');
  const local = !force && readLocal('productosV2', 180000);
  if (local) { state.productos = local; renderProducts(); setLoading('Navegador'); return; }
  const data = await api(`/productos${force ? '?refresh=true' : ''}`);
  state.productos = data.productos || [];
  saveLocal('productosV2', state.productos);
  renderProducts(); setLoading(data.cached ? 'Servidor' : 'Nuevo');
}
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
  const required = ['billingFirstName','billingLastName','billingRut','billingPhone','billingAddress']; for (const id of required) if (!$(id).value.trim()) throw new Error('Complete nombre, apellido, RUT, teléfono y dirección.');
  if (!validateRutLocal(rut)) throw new Error('Ingrese un RUT válido.');
  if (!regionCode || !comuna) throw new Error('Seleccione región y comuna.');
  const billing = { first_name:$('billingFirstName').value.trim(), last_name:$('billingLastName').value.trim(), email, phone:$('billingPhone').value.trim(), rut, address_1:$('billingAddress').value.trim(), address_2:$('billingAddress2').value.trim(), city:comuna, postcode:$('billingPostcode').value.trim(), state:regionCode, country:'CL' };
  return { rut, region: regionCode, comuna, postcode: billing.postcode, billing, shipping: billing, payment_method:$('paymentMethod').value, payment_method_title:$('paymentMethod').value === 'flow' ? 'Flow - Webpay / Multicaja' : $('paymentMethod').value, line_items: state.cart.map(i => ({ product_id:i.product.id, variation_id:i.variation?.id, quantity:i.quantity })), customer_note:$('customerNote').value.trim() || 'Pedido creado desde panel Chatwoot.', meta_data:[{key:'_chatwoot_conversation_id', value:$('conversationId').value.trim()}] };
}
async function createOrder() { $('orderStatus').textContent=''; try { const data = await api('/crear-pedido', { method:'POST', body: JSON.stringify(buildOrderPayload()) }); state.lastOrder = data.pedido; $('orderStatus').style.color = '#15803d'; $('orderStatus').textContent = `Pedido #${data.pedido.numero} creado por ${money(data.pedido.total)}.`; await loadPanel(true); } catch(e) { $('orderStatus').style.color = '#b91c1c'; $('orderStatus').textContent = e.message; } }
async function payOrder() { try { if (!state.lastOrder) await createOrder(); if (!state.lastOrder) return; const data = await api('/pagar', { method:'POST', body: JSON.stringify({ orderId:state.lastOrder.id, amount:state.lastOrder.total, email:$('customerEmail').value.trim(), subject:`Pedido #${state.lastOrder.numero}` }) }); window.open(data.url, '_blank', 'noopener,noreferrer'); } catch(e) { alert(e.message); } }
async function applyLabels() { const conversationId = $('conversationId').value.trim(); const labels = $('labelInput').value.split(',').map(x=>x.trim()).filter(Boolean); if (!conversationId || !labels.length) return alert('Ingrese conversación y etiquetas separadas por coma.'); await api('/chatwoot/etiquetas', { method:'POST', body: JSON.stringify({ conversationId, labels }) }); alert('Etiquetas aplicadas.'); }
async function clearCache() { localStorage.removeItem('productosV2'); localStorage.removeItem('regionesChileV2'); await api('/cache/clear', { method:'POST', body:'{}' }); setLoading('Limpio'); alert('Caché limpiado.'); }
$('loginForm').addEventListener('submit', async (e)=>{ e.preventDefault(); $('loginError').textContent=''; state.auth = btoa(`${$('loginUser').value.trim()}:${$('loginPassword').value}`); try { await api('/health'); localStorage.setItem('panelAuth', state.auth); showApp(); await loadRegiones(); readChatwootParams(); } catch { $('loginError').textContent = 'Credenciales incorrectas o servidor no disponible.'; state.auth=''; } });
$('logoutBtn').addEventListener('click', ()=>{ localStorage.removeItem('panelAuth'); state.auth=''; showLogin(); });
$('loadBtn').addEventListener('click', () => loadPanel(false));
$('refreshProductsBtn').addEventListener('click', () => loadProducts(true));
$('clearCacheBtn').addEventListener('click', clearCache);
$('productFilter').addEventListener('input', renderProducts);
$('createOrderBtn').addEventListener('click', createOrder); $('payBtn').addEventListener('click', payOrder);
$('billingRegion').addEventListener('change', () => renderComunas($('billingRegion').value));
$('billingComuna').addEventListener('change', updatePostcode);
$('billingRut').addEventListener('input', updateRutStatus);
$('applyLabelsBtn').addEventListener('click', applyLabels);
testAuth();
