// v8.6.2 Rivaida Commerce Hub: deteccion automatica de tienda, Colombia aislado y stock con disponibles primero.
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
  shippingMethods: [],
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
  uiLogs: [],
  chatwootContext: null,
  chatwootReady: false,
  settings: {},
  variationModalProductId: null,
  autoStoreSwitchKey: null,
  coupon: null,
  coupons: []
};
const $ = (id) => document.getElementById(id);
function currentStore(){ return state.stores.find(s => s.id === state.activeStore) || { id: state.activeStore, country: state.activeStore === 'co' ? 'CO' : 'CL', currency: state.activeStore === 'co' ? 'COP' : 'CLP', document_label: state.activeStore === 'co' ? 'CC / NIT' : 'RUT' }; }
const money = (v) => `${Number(v || 0).toLocaleString(currentStore().country === 'CO' ? 'es-CO' : 'es-CL')} ${currentStore().currency || 'CLP'}`;
const text = (v) => String(v ?? '').replace(/[<>&"]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
const normalize = (s='') => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();

function pushUiLog(level, message, detail='') {
  const entry = { time: new Date().toISOString(), level, message: String(message || ''), detail: String(detail || ''), store: state.activeStore };
  state.uiLogs.unshift(entry);
  state.uiLogs = state.uiLogs.slice(0, 80);
  try { localStorage.setItem('rivaidaHubLogs', JSON.stringify(state.uiLogs)); } catch {}
}
function readUiLogs() {
  try { state.uiLogs = JSON.parse(localStorage.getItem('rivaidaHubLogs') || '[]'); } catch { state.uiLogs = []; }
}
function notify(message, type='info', detail='') {
  pushUiLog(type, message, detail);
  const host = $('toastHost');
  const msg = String(message || '');
  if (!host) { console.log(`[${type}]`, msg, detail); return; }
  const el = document.createElement('div');
  el.className = `toast-message toast-${type}`;
  const title = type === 'success' ? 'Listo' : type === 'error' ? 'Error' : type === 'warning' ? 'Atención' : 'Aviso';
  el.innerHTML = `<div><strong>${text(title)}</strong><p>${text(msg)}</p>${detail ? `<small>${text(detail)}</small>` : ''}</div><button type="button" aria-label="Cerrar">×</button>`;
  el.querySelector('button')?.addEventListener('click', () => el.remove());
  host.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 250); }, type === 'error' ? 6500 : 4200);
}
function notifySuccess(message, detail='') { notify(message, 'success', detail); }
function notifyError(message, detail='') { notify(message, 'error', detail); }
function notifyWarning(message, detail='') { notify(message, 'warning', detail); }
const nativeAlert = window.alert.bind(window);
window.alert = (message) => notify(message, String(message || '').toLowerCase().includes('error') ? 'error' : 'info');

function parseMaybeJson(data) {
  if (!data) return null;
  if (typeof data === 'string') { try { return JSON.parse(data); } catch { return null; } }
  return typeof data === 'object' ? data : null;
}
function extractEmailFromString(value='') {
  const match = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : '';
}
function isValidEmailLocal(value='') { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim()); }
function extractChatwootContext(payload = {}) {
  const appContext = payload.event === 'appContext' ? payload.data : (payload.appContext || payload.data || payload);
  const conversation = appContext.conversation || appContext.currentConversation || appContext;
  const contact = appContext.contact || conversation.contact || conversation.meta?.sender || conversation.sender || appContext.meta?.sender || {};
  const inboxId = conversation.inbox_id || conversation.inbox?.id || appContext.inbox_id || appContext.inbox?.id || conversation.meta?.inbox_id || conversation.meta?.inbox?.id || conversation.additional_attributes?.inbox_id || '';
  const conversationId = conversation.id || conversation.conversation_id || appContext.conversation_id || appContext.id || '';
  let email = contact.email || conversation.meta?.sender?.email || conversation.contact_email || appContext.email || '';
  if (!email) {
    for (const msg of conversation.messages || []) {
      email = msg.sender?.email || extractEmailFromString(msg.content || msg.processed_message_content || '');
      if (email) break;
    }
  }
  const name = contact.name || contact.available_name || conversation.meta?.sender?.name || '';
  const phone = contact.phone_number || contact.phone || conversation.meta?.sender?.phone_number || appContext.phone || '';
  const labels = conversation.labels || conversation.label_list || [];
  const customAttributes = conversation.custom_attributes || contact.custom_attributes || {};
  return { raw: payload, appContext, conversation, contact, conversationId, inboxId, email, name, phone, labels, customAttributes };
}
function splitSettingList(value='') {
  return String(value || '').split(',').map(x => x.trim()).filter(Boolean);
}
function normalizePhoneForCountry(value='') {
  return String(value || '').replace(/[\s().-]/g, '').trim();
}
function phonePrefixForStore(store = currentStore()) { return (store.country === 'CO' || store.id === 'co') ? '+57' : '+56'; }
function applyCountryCodeToPhone(value = '', store = currentStore()) {
  let raw = String(value || '').trim();
  if (!raw) return '';
  raw = raw.replace(/[\s().-]/g, '');
  if (raw.startsWith('+')) return raw;
  if (raw.startsWith('00')) return '+' + raw.slice(2);
  if (raw.startsWith('56') || raw.startsWith('57')) return '+' + raw;
  return phonePrefixForStore(store) + raw.replace(/^0+/, '');
}
function formatBillingPhoneInPlace() { const el = $('billingPhone'); if (el && el.value.trim()) el.value = applyCountryCodeToPhone(el.value, currentStore()); }
function normalizeStoreIdClient(value='') {
  const raw = String(value || '').trim().toLowerCase();
  if (['co','colombia','cop','57','+57'].includes(raw)) return 'co';
  if (['cl','chile','clp','56','+56'].includes(raw)) return 'cl';
  return raw;
}
function isTemplateValue(value='') {
  return /{{|}}/.test(String(value || ''));
}
function inferStoreFromChatwootContext(ctx = {}) {
  const attrs = ctx.customAttributes || {};
  const labelText = (ctx.labels || []).map(x => String(x).toLowerCase()).join(' ');
  const explicit = normalizeStoreIdClient(attrs.rivaida_store || attrs.store || attrs.country || '');
  if (explicit === 'cl') return 'cl';
  if (explicit === 'co') return 'co';
  if (/\b(colombia|dropi|co)\b/.test(labelText)) return 'co';
  if (/\b(chile|cl)\b/.test(labelText)) return 'cl';
  const inbox = String(ctx.inboxId || '').trim();
  if (inbox) {
    try {
      const map = JSON.parse(state.settings.CHATWOOT_INBOX_STORE_MAP || '{}');
      const mapped = String(map[inbox] || '').toLowerCase();
      if (mapped === 'cl' || mapped === 'co') return mapped;
    } catch {}
    if (splitSettingList(state.settings.CL_CHATWOOT_INBOX_IDS).includes(inbox)) return 'cl';
    if (splitSettingList(state.settings.CO_CHATWOOT_INBOX_IDS).includes(inbox)) return 'co';
  }
  if (String(state.settings.AUTO_STORE_BY_PHONE || 'true') !== 'false') {
    const phone = normalizePhoneForCountry(ctx.phone);
    if (phone.startsWith('+57') || phone.startsWith('57')) return 'co';
    if (phone.startsWith('+56') || phone.startsWith('56')) return 'cl';
  }
  return '';
}
function maybeAutoSwitchStoreFromContext(ctx = {}, source='Chatwoot') {
  const target = inferStoreFromChatwootContext(ctx);
  if (!target || !state.stores.find(s => s.id === target)) return;
  const key = `${target}:${ctx.conversationId || ''}:${ctx.inboxId || ''}:${ctx.phone || ''}`;
  if (state.activeStore === target || state.autoStoreSwitchKey === key) return;
  state.autoStoreSwitchKey = key;
  notify('Tienda detectada automáticamente', `${target === 'co' ? 'Colombia' : 'Chile'} por ${ctx.inboxId ? 'bandeja/inbox' : 'código de país'} ${source ? '· ' + source : ''}`);
  changeStore(target).catch((e) => notifyError('No se pudo cambiar tienda automáticamente', e.message));
}
function renderChatwootContext(ctx, source='Chatwoot') {
  state.chatwootContext = ctx;
  if (ctx?.conversationId && $('conversationId')) $('conversationId').value = ctx.conversationId;
  if (ctx?.email && $('customerEmail')) $('customerEmail').value = ctx.email;
  if (ctx?.phone && $('billingPhone') && !$('billingPhone').value) $('billingPhone').value = applyCountryCodeToPhone(ctx.phone, currentStore());
  if (ctx?.name && $('billingFirstName') && !$('billingFirstName').value) {
    const parts = String(ctx.name).trim().split(/\s+/);
    $('billingFirstName').value = parts.shift() || '';
    if ($('billingLastName') && !$('billingLastName').value) $('billingLastName').value = parts.join(' ');
  }
  maybeAutoSwitchStoreFromContext(ctx, source);
  const status = $('chatwootContextStatus');
  if (status) status.textContent = ctx?.conversationId ? `Conectado a conversación #${ctx.conversationId}` : 'Contexto recibido sin ID de conversación';
  const box = $('chatwootContextBox');
  if (box) {
    box.className = 'chatwoot-context-box active';
    box.innerHTML = `<strong>${text(ctx?.name || 'Contacto Chatwoot')}</strong><span>Email: ${text(ctx?.email || 'pendiente / no detectado')}</span><span>Conversación: ${text(ctx?.conversationId || 'N/D')}</span><span>Teléfono: ${text(ctx?.phone || 'N/D')}</span><span>Inbox: ${text(ctx?.inboxId || 'N/D')}</span><span>Tienda sugerida: ${text(inferStoreFromChatwootContext(ctx) || state.activeStore)}</span><span>Origen: ${text(source)}</span>${ctx?.labels?.length ? `<span>Etiquetas: ${ctx.labels.map(text).join(', ')}</span>` : ''}`;
  }
}
async function enrichContextFromServer(conversationId='') {
  const id = conversationId || $('conversationId')?.value?.trim();
  if (!id) return null;
  const data = await api(`/chatwoot/conversacion/${encodeURIComponent(id)}/contexto`);
  const ctx = { conversationId: data.conversationId || id, inboxId: data.inbox_id || data.conversation?.inbox_id || data.conversation?.inbox?.id || '', email: data.email || '', name: data.name || '', phone: data.phone || '', labels: data.labels || [], customAttributes: data.custom_attributes || {}, conversation: data.conversation, contact: data.contact };
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
  let email = p.get('email') || p.get('email_cliente') || p.get('customer_email') || p.get('contact_email') || '';
  let conversationId = p.get('conversation_id') || p.get('conversationId') || p.get('conversation.id') || p.get('cw_conversation_id') || '';
  let phone = p.get('phone') || p.get('phone_number') || p.get('telefono') || p.get('whatsapp') || '';
  let inboxId = p.get('inbox_id') || p.get('inboxId') || p.get('inbox.id') || '';
  if (isTemplateValue(email)) email = '';
  if (isTemplateValue(conversationId)) conversationId = '';
  if (isTemplateValue(phone)) phone = '';
  if (isTemplateValue(inboxId)) inboxId = '';
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) email = '';
  const explicitStore = p.get('store') || p.get('country') || p.get('rivaida_store') || '';
  const labels = (p.get('labels') || p.get('tags') || '').split(',').map(x => x.trim()).filter(Boolean);
  if (email && $('customerEmail')) $('customerEmail').value = email;
  if (conversationId && $('conversationId')) $('conversationId').value = conversationId;
  if (email || conversationId || phone || inboxId || explicitStore || labels.length) {
    renderChatwootContext({ email, conversationId, name: '', phone, inboxId, labels, customAttributes: explicitStore ? { rivaida_store: explicitStore } : {} }, 'URL');
  }
}
function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (state.panelToken) headers['x-panel-token'] = state.panelToken;
  else if (state.auth) headers.Authorization = `Basic ${state.auth}`;
  return headers;
}
function pathWithStore(path) {
  if (!path.startsWith('/') || path.startsWith('/stores') || path.startsWith('/paises') || path.startsWith('/health') || path.startsWith('/diagnostics')) return path;
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
  await loadStores(); addHelpBubbles();
  await loadRegiones();
  await loadCategorias();
  await loadPaymentMethods();
  await loadShippingMethods();
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
function firstEnabledStoreId() {
  return state.stores.find(s => s.enabled)?.id || '';
}
function isStoreEnabled(storeId = state.activeStore) {
  const st = state.stores.find(s => s.id === storeId);
  return Boolean(st && st.enabled);
}
function configuredStoreNotice() {
  const enabled = state.stores.filter(s => s.enabled).map(s => s.name || s.id).join(', ');
  return enabled ? `Tiendas configuradas: ${enabled}` : 'No hay tiendas con WooCommerce configurado. Abre Credenciales y completa al menos Chile o Colombia.';
}
async function loadStores() {
  try {
    const data = await api('/stores'); state.stores = data.stores || [];
    const urlStore = new URLSearchParams(location.search).get('store') || '';
    const savedStore = localStorage.getItem('activeStore') || '';
    const contextStore = state.chatwootContext ? inferStoreFromChatwootContext(state.chatwootContext) : '';
    const wanted = urlStore || contextStore || savedStore || firstEnabledStoreId() || 'cl';
    const exists = state.stores.find(s => s.id === wanted);
    state.activeStore = exists ? wanted : (firstEnabledStoreId() || state.stores[0]?.id || 'cl');
    if (!isStoreEnabled(state.activeStore)) {
      const fallback = firstEnabledStoreId();
      if (fallback && fallback !== state.activeStore) {
        state.activeStore = fallback;
        notifyWarning('Tienda sin credenciales', `Se abrió ${currentStore().name || state.activeStore} porque la tienda anterior no tiene WooCommerce configurado.`);
      }
    }
    localStorage.setItem('activeStore', state.activeStore);
    const sel = $('storeSelect');
    if (sel) {
      sel.innerHTML = state.stores.map(s => `<option value="${text(s.id)}">${text(s.name || s.id)} · ${text(s.country || s.code || '')}${s.enabled ? '' : ' · falta configurar'}</option>`).join('');
      sel.value = state.activeStore;
    }
    applyStoreUI();
  } catch (e) { console.warn('No se pudieron cargar tiendas:', e.message); }
}
function applyStoreUI() {
  const st = currentStore();
  if ($('brandMark')) $('brandMark').textContent = st.country || st.id.toUpperCase();
  if ($('checkoutTitle')) $('checkoutTitle').textContent = st.country === 'CO' ? 'Checkout Colombia' : 'Checkout Chile';
  if ($('countryPill')) $('countryPill').textContent = `${st.currency || ''} · ${st.country === 'CO' ? 'Woo Colombia' : 'Woo Chile'}`;
  if ($('platformPill')) $('platformPill').textContent = st.country === 'CO' ? 'Colombia' : 'Chile';
  if ($('billingRut')) $('billingRut').placeholder = st.country === 'CO' ? 'Documento: CC / NIT' : 'RUT: 12.345.678-9';
  if ($('docHelp')) $('docHelp').innerHTML = st.country === 'CO' ? 'Documento CC / NIT para WooCommerce Colombia. Ciudad y departamento quedan aislados de Chile.' : 'RUT chileno en campos esenciales: billing_rut y shipping_rut.';
  if ($('billingPhone')) $('billingPhone').placeholder = st.country === 'CO' ? 'Telefono +57' : 'Telefono +56';
  if ($('assistantCountryPill')) $('assistantCountryPill').textContent = st.country === 'CO' ? 'CO · Colombia' : 'CL · Chile';
  if ($('recommendationBox') && !state.recommendations) {
    $('recommendationBox').innerHTML = st.country === 'CO'
      ? 'Asistente Colombia independiente: CC/NIT, ciudad/departamento, COP, métodos Woo y envíos disponibles.'
      : 'Asistente Chile independiente: RUT, región/comuna, CLP, Flow/Woo y despacho local.';
  }
  document.body.classList.remove('store-cl','store-co');
  document.body.classList.add(`store-${st.id}`);
}
async function changeStore(storeId) {
  state.activeStore = storeId || 'cl'; localStorage.setItem('activeStore', state.activeStore);
  if ($('storeSelect')) $('storeSelect').value = state.activeStore;
  pushUiLog('info', 'Cambio de tienda', state.activeStore === 'co' ? 'Colombia' : 'Chile');
  state.productos=[]; state.productOffset=0; state.productTotal=0; state.categorias=[]; state.paymentMethods=[]; state.shippingMethods=[]; state.pedidos=[]; state.cart=[]; state.lastOrder=null; state.selectedOrder=null; state.recommendations=null; state.coupon=null; state.regiones=[];
  if ($('billingRegion')) $('billingRegion').innerHTML = '<option value="">Cargando...</option>';
  if ($('billingComuna')) $('billingComuna').innerHTML = '<option value="">Seleccione primero</option>';
  if ($('billingPostcode')) $('billingPostcode').value = '';
  if ($('stockFilter')) $('stockFilter').value = '';
  applyStoreUI(); renderCart(); renderOrders([]); if ($('productsList')) $('productsList').innerHTML = `<div class="store-switch-state"><strong>${text(currentStore().name || state.activeStore)}</strong><p>Cargando catálogo separado para esta tienda...</p></div>`;
  if (!isStoreEnabled(state.activeStore)) {
    const st = currentStore();
    notifyWarning('WooCommerce no configurado', `${st.name || st.id} no tiene credenciales. Puedes seguir usando otra tienda configurada.`);
    $('productsList').innerHTML = `<div class="empty-state"><strong>${text(st.name || st.id)} no está configurada</strong><p>${text(configuredStoreNotice())}</p><button class="btn btn-sm btn-primary" id="openSettingsFromEmpty">Abrir credenciales</button></div>`;
    $('openSettingsFromEmpty')?.addEventListener('click', () => toggleSettings(true));
    $('loadMoreBtn')?.classList.add('hidden');
    showProductLoader(false);
    return;
  }
  await loadRegiones(true); await loadCategorias(true); await loadPaymentMethods(true); await loadShippingMethods(true); await loadProducts(true);
}
async function loadRegiones(force=false) {
  const key = `regiones_${state.activeStore}_v86`;
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

async function loadShippingMethods(force=false) {
  try {
    const data = await api(`/shipping-methods${force ? '?refresh=true' : ''}`);
    state.shippingMethods = data.methods || [];
    const sel = $('shippingMethod');
    if (sel) {
      if (state.shippingMethods.length) {
        sel.innerHTML = state.shippingMethods.map((m) => {
          const label = `${m.title || m.method_title || m.id}${m.zone_name ? ' · ' + m.zone_name : ''}${Number(m.total || 0) ? ' · ' + money(m.total) : ''}`;
          return `<option value="${text(m.id || m.method_id)}" data-method-id="${text(m.method_id || m.id)}" data-instance-id="${text(m.instance_id || '')}" data-title="${text(m.title || m.method_title || '')}" data-total="${text(m.total || 0)}">${text(label)}</option>`;
        }).join('');
      } else {
        sel.innerHTML = '<option value="">Sin método de envío</option>';
      }
    }
  } catch (e) {
    console.warn('No se pudieron cargar métodos de envío Woo:', e.message);
    const sel = $('shippingMethod');
    if (sel) sel.innerHTML = '<option value="">Envío no configurado</option>';
  }
}
function selectedShippingLine() {
  const sel = $('shippingMethod');
  if (!sel || !sel.value) return null;
  const opt = sel.selectedOptions?.[0];
  if (!opt) return null;
  return {
    method_id: opt.dataset.methodId || sel.value,
    method_title: opt.dataset.title || opt.textContent || sel.value,
    total: String(Number(opt.dataset.total || 0))
  };
}
function renderRegionOptions() {
  if (!$('billingRegion')) return;
  $('billingRegion').innerHTML = `<option value="">Seleccione ${currentStore().country === 'CO' ? 'departamento' : 'región'}</option>` + state.regiones.map(r => `<option value="${text(r.codigo)}">${text(r.region || r.region_original || r.codigo)}</option>`).join('');
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

function isStockValueOk(item) {
  if (!item) return false;
  if (item.stock_status && item.stock_status !== 'instock') return false;
  if (item.manage_stock && item.stock !== null && item.stock !== undefined && Number(item.stock) <= 0) return false;
  return true;
}
function productHasAvailableStock(product) {
  if (!product) return false;
  if (product.type === 'variable') {
    if (Array.isArray(product.variations) && product.variations.length) return product.variations.some(isStockValueOk);
    return isStockValueOk(product);
  }
  return isStockValueOk(product);
}
function stockSortRank(product) { return productHasAvailableStock(product) ? 0 : 1; }
function sortProductsByStockThenName(a, b) {
  return stockSortRank(a) - stockSortRank(b) || String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es');
}
function canAddProduct(product, variation=null) {
  if (!product) return { ok: false, reason: 'Producto no encontrado' };
  if (product.type === 'variable') {
    if (!product.variations || !product.variations.length) return { ok: false, reason: 'Carga y selecciona una variación disponible.' };
    if (!variation) return { ok: false, reason: 'Selecciona una variación.' };
    if (!isStockValueOk(variation)) return { ok: false, reason: 'La variación seleccionada no tiene stock.' };
    return { ok: true };
  }
  if (!isStockValueOk(product)) return { ok: false, reason: 'Este producto no tiene stock.' };
  return { ok: true };
}
function firstInStockVariation(product) {
  return (product.variations || []).find(isStockValueOk) || (product.variations || [])[0] || null;
}
function variationLabel(v) { return (v.atributos || []).filter(a => a.option && !isNoisyAttribute(a.name)).map(a => `${a.name}: ${a.option}`).join(' · ') || v.sku || `Variacion ${v.id}`; }
function getSelectedVariation(product) {
  if (!product.variations || !product.variations.length) return null;
  const selected = product.selectedVariationId ? product.variations.find(v => String(v.id) === String(product.selectedVariationId)) : null;
  return selected || firstInStockVariation(product);
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
  const current = getSelectedVariation(product);
  const hasLoaded = Boolean(product.variations && product.variations.length);
  const can = current ? canAddProduct(product, current) : canAddProduct(product, null);
  const summary = current ? `<div class="selected-variation-compact ${can.ok ? '' : 'no-stock'}"><strong>${text(variationLabel(current))}</strong><span>${text(current.sku || 'Sin SKU')} · ${money(current.precio)} · ${can.ok ? 'con stock' : 'sin stock'}</span></div>` : '<div class="selected-variation-compact muted">Sin variación seleccionada.</div>';
  return `<div class="variation-panel compact"><button class="secondary" data-open-vars="${product.id}">${hasLoaded ? 'Cambiar variación' : `Elegir variación (${product.variation_count || 0})`}</button>${summary}</div>`;
}
function renderProductCard(p) {
  const current = getSelectedVariation(p);
  const img = productImage(p);
  const price = current?.precio || p.precio;
  const can = canAddProduct(p, current);
  const available = productHasAvailableStock(p);
  const typeText = p.type === 'variable' ? 'Producto variable' : 'Producto simple';
  const disabled = can.ok ? '' : 'disabled';
  const stockLabel = available ? (p.type === 'variable' && !can.ok ? 'Variaciones disponibles' : 'Con stock') : 'Sin stock';
  const actionLabel = can.ok ? 'Agregar' : (p.type === 'variable' && available ? 'Elige variación' : 'Sin stock');
  const warning = !can.ok ? (available && p.type === 'variable' ? 'Selecciona una variación disponible para agregar o enviar.' : can.reason) : '';
  return `<article class="product-card ${available ? '' : 'out-of-stock'}" data-product-card="${p.id}"><div class="product-media">${img ? `<img id="main-img-${p.id}" src="${text(img)}" loading="lazy" alt="${text(p.nombre)}"/>` : `<div class="no-img">Sin imagen</div>`}<span class="stock-chip ${available ? 'ok' : 'no'}">${stockLabel}</span></div><div class="product-body"><div class="product-head"><div><h3>${text(p.nombre)}</h3><p class="product-sku">SKU: ${text(current?.sku || p.sku)} · ${typeText}${p.variation_count ? ` · ${p.variation_count} variaciones` : ''}</p></div><p class="price">${money(price)}</p></div>${renderVariationPanel(p)}${warning ? `<div class="stock-warning">${text(warning)}</div>` : ''}<div class="product-actions"><input class="qty" id="qty-${p.id}" type="number" min="1" value="1" ${disabled}/><button data-add="${p.id}" ${disabled}>${actionLabel}</button><button class="secondary" data-send="${p.id}" ${disabled}>Enviar a conversación</button></div></div></article>`;
}
function renderVariationModal() {
  const product = findProduct(state.variationModalProductId);
  const body = $('variationModalBody');
  if (!body || !product) return;
  if (product.loadingVariations) { body.innerHTML = '<div class="modal-loading"><div class="spinner"></div><strong>Cargando variaciones...</strong></div>'; return; }
  if (!product.variations || !product.variations.length) {
    body.innerHTML = `<div class="empty-state"><p>Las variaciones aún no están cargadas.</p><button class="secondary" data-load-vars="${product.id}">Cargar variaciones</button></div>`;
    bindProductEvents();
    return;
  }
  const groups = variationGroups(product);
  const current = getSelectedVariation(product);
  const filtered = product.variations.filter(v => variationMatches(product, v));
  const selectors = groups.map(g => {
    const selected = (product.variationChoices || {})[g.name] || '';
    const options = g.options.map(o => {
      const hasStock = (product.variations || []).some(v => (v.atributos || []).some(a => a.name === g.name && a.option === o) && isStockValueOk(v));
      return `<button type="button" class="var-option ${selected === o ? 'active' : ''}" data-var-choice="${product.id}" data-var-name="${text(g.name)}" data-var-value="${text(o)}" ${hasStock ? '' : 'disabled'}>${text(o)}${hasStock ? '' : '<small>Sin stock</small>'}</button>`;
    }).join('');
    return `<div class="var-group"><div class="var-group-title"><strong>${text(g.name)}</strong>${selected ? `<button class="tiny ghost" data-var-clear="${product.id}" data-var-name="${text(g.name)}">Limpiar</button>` : ''}</div><div class="var-options">${options}</div></div>`;
  }).join('');
  const cards = filtered.slice(0, 40).map(v => {
    const ok = isStockValueOk(v);
    const active = current && String(current.id) === String(v.id);
    const img = v.imagen || product.imagen || product.imagenes?.[0]?.src || '';
    return `<button type="button" class="var-card ${active ? 'active' : ''} ${ok ? '' : 'disabled'}" data-select-var="${product.id}" data-var-id="${v.id}" ${ok ? '' : 'disabled'}>${img ? `<img src="${text(img)}" alt="" loading="lazy"/>` : '<span class="var-no-img">Sin img</span>'}<span>${text(variationLabel(v))}</span><strong>${money(v.precio)}</strong><small>${text(v.sku || 'Sin SKU')} · ${ok ? 'con stock' : 'sin stock'}</small></button>`;
  }).join('');
  const currentOk = current && isStockValueOk(current);
  body.innerHTML = `<div class="variation-modal-grid"><div>${selectors || '<p class="muted">Sin atributos visibles.</p>'}<div class="var-results-title">Variaciones disponibles</div><div class="var-card-grid">${cards || '<p class="muted">No hay coincidencias con stock para esta selección.</p>'}</div></div><aside class="var-summary"><h3>${text(product.nombre)}</h3>${current ? `${(current.imagen || product.imagen) ? `<img src="${text(current.imagen || product.imagen)}" alt="" loading="lazy"/>` : ''}<p>${text(variationLabel(current))}</p><strong>${money(current.precio)}</strong><small>${text(current.sku || 'Sin SKU')}</small><span class="stock-chip ${currentOk ? 'ok' : 'no'}">${currentOk ? 'Con stock' : 'Sin stock'}</span>` : '<p class="muted">Selecciona una variación.</p>'}</aside></div>`;
  bindProductEvents();
}
function openVariationModal(productId) {
  const product = findProduct(productId);
  if (!product) return;
  state.variationModalProductId = productId;
  $('variationModal')?.classList.remove('hidden');
  $('variationModal')?.setAttribute('aria-hidden', 'false');
  $('variationModalTitle').textContent = product.nombre || 'Seleccionar variación';
  if (!product.variations && product.variation_count) loadVariations(productId).then(renderVariationModal).catch(e => notifyError(e.message));
  renderVariationModal();
}
function closeVariationModal() {
  $('variationModal')?.classList.add('hidden');
  $('variationModal')?.setAttribute('aria-hidden', 'true');
  state.variationModalProductId = null;
}
function renderProducts() {
  document.body.classList.toggle('show-all-stock', ($('stockFilter')?.value || '') !== 'instock');
  setMetric('metricProducts', state.productos.length);
  const vCount = state.productos.reduce((s,p)=>s+Number(p.variation_count || (p.variations||[]).length || 0),0);
  setMetric('metricVariations', vCount);
  if (!state.productos.length) { $('productsList').innerHTML = '<span class="muted">No hay productos para mostrar.</span>'; $('loadMoreBtn').classList.add('hidden'); return; }
  state.productos = state.productos.slice().sort(sortProductsByStockThenName);
  $('productsList').innerHTML = state.productos.map(renderProductCard).join('');
  $('loadMoreInfo').textContent = `${state.productos.length}/${state.productTotal || state.productos.length} productos`;
  $('loadMoreBtn').classList.toggle('hidden', !(state.productos.length < state.productTotal || state.productos.length % state.productLimit === 0));
  bindProductEvents();
}
function findProduct(id) { return state.productos.find(p => String(p.id) === String(id)); }
function bindProductEvents() {
  document.querySelectorAll('[data-load-vars]').forEach(btn => btn.addEventListener('click', () => loadVariations(btn.dataset.loadVars).then(renderVariationModal)));
  document.querySelectorAll('[data-open-vars]').forEach(btn => btn.addEventListener('click', () => openVariationModal(btn.dataset.openVars)));
  document.querySelectorAll('[data-refresh-vars]').forEach(btn => btn.addEventListener('click', () => loadVariations(btn.dataset.refreshVars, true).then(renderVariationModal)));
  document.querySelectorAll('[data-more-vars]').forEach(btn => btn.addEventListener('click', () => { const p=findProduct(btn.dataset.moreVars); p.variationLimit=(p.variationLimit||8)+12; renderProducts(); }));
  document.querySelectorAll('[data-var-select]').forEach(sel => sel.addEventListener('change', () => { const p=findProduct(sel.dataset.varSelect); p.variationChoices=p.variationChoices||{}; if (sel.value) p.variationChoices[sel.dataset.varName]=sel.value; else delete p.variationChoices[sel.dataset.varName]; const match=(p.variations||[]).find(v=>variationMatches(p,v) && isStockValueOk(v)); if(match) p.selectedVariationId=match.id; else delete p.selectedVariationId; renderProducts(); renderVariationModal(); }));
  document.querySelectorAll('[data-var-choice]').forEach(btn => btn.addEventListener('click', () => { const p=findProduct(btn.dataset.varChoice); p.variationChoices=p.variationChoices||{}; p.variationChoices[btn.dataset.varName]=btn.dataset.varValue; const match=(p.variations||[]).find(v=>variationMatches(p,v) && isStockValueOk(v)); if(match) p.selectedVariationId=match.id; else delete p.selectedVariationId; renderProducts(); renderVariationModal(); }));
  document.querySelectorAll('[data-var-clear]').forEach(btn => btn.addEventListener('click', () => { const p=findProduct(btn.dataset.varClear); p.variationChoices=p.variationChoices||{}; delete p.variationChoices[btn.dataset.varName]; const match=(p.variations||[]).find(v=>variationMatches(p,v) && isStockValueOk(v)); if(match) p.selectedVariationId=match.id; else delete p.selectedVariationId; renderProducts(); renderVariationModal(); }));
  document.querySelectorAll('[data-select-var]').forEach(btn => btn.addEventListener('click', () => { const p=findProduct(btn.dataset.selectVar); const v=(p.variations||[]).find(x=>String(x.id)===String(btn.dataset.varId)); if(!v || !isStockValueOk(v)){ notifyWarning('Variación sin stock', 'Selecciona una variación disponible.'); return; } p.selectedVariationId=btn.dataset.varId; renderProducts(); renderVariationModal(); }));
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
    p.selectedVariationId = firstInStockVariation(p)?.id;
  } catch (e) { notifyError(e.message); }
  finally { p.loadingVariations = false; renderProducts(); renderVariationModal(); }
}
function addToCart(product, quantity, variation=null) { const can = canAddProduct(product, variation); if (!can.ok) { notifyWarning(can.reason); return; } const key = `${product.id}:${variation?.id || 0}`; const ex = state.cart.find(i => i.key === key); if (ex) ex.quantity += quantity; else state.cart.push({ key, product, variation, quantity }); renderCart(); notifySuccess('Producto agregado al carrito', `${product.nombre}${variation ? ' · ' + variationLabel(variation) : ''}`); }
function removeFromCart(key) { state.cart = state.cart.filter(i => i.key !== key); renderCart(); }
function cartItemImage(item) {
  return item.variation?.imagen || item.product?.imagen || item.product?.imagenes?.[0]?.src || '';
}
function renderCart() {
  if (!state.cart.length) { $('cartBox').innerHTML = '<div class="cart-empty">Seleccione productos o variaciones para el pedido.</div>'; return; }
  const subtotal = state.cart.reduce((s,i)=>s+Number(i.variation?.precio || i.product.precio || 0)*i.quantity,0);
  const couponAmount = state.coupon ? Number(state.coupon.amount || 0) : 0;
  const total = state.coupon?.discount_type === 'percent' ? Math.max(0, subtotal - Math.round(subtotal * couponAmount / 100)) : Math.max(0, subtotal - couponAmount);
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
  if (!conversationId) { notifyWarning('No se detectó ID de conversación. Abre el panel dentro de una conversación Chatwoot o ingresa el ID manualmente.'); return; }
  if (!$('customerEmail')?.value?.trim()) await enrichContextFromServer(conversationId).catch(console.warn);
  const can = canAddProduct(product, variation); if (!can.ok) { notifyWarning(can.reason); return; }
  const imageUrl = variation?.imagen || product?.imagen || product?.imagenes?.[0]?.src || '';
  await api('/chatwoot/enviar-producto', { method:'POST', body: JSON.stringify({ conversationId, product, variation, quantity, imageUrl, autoLabels: true, custom_attributes: { rivaida_store: state.activeStore, rivaida_country: currentStore().country } }) });
  notifySuccess('Producto enviado a la conversación', `${currentStore().name || state.activeStore}: imagen adjunta si el canal lo permite.`);
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
  let expectedStore = state.activeStore;
  if (state.productLoading) return;
  if (!isStoreEnabled(state.activeStore)) {
    const fallback = firstEnabledStoreId();
    if (fallback && fallback !== state.activeStore) {
      notifyWarning('Tienda sin credenciales', `Cambiando a ${state.stores.find(s=>s.id===fallback)?.name || fallback}.`);
      state.activeStore = fallback; localStorage.setItem('activeStore', fallback);
      expectedStore = fallback;
      const sel = $('storeSelect'); if (sel) sel.value = fallback;
      applyStoreUI();
    } else {
      $('productsList').innerHTML = `<div class="empty-state"><strong>No hay WooCommerce configurado para esta tienda</strong><p>${text(configuredStoreNotice())}</p><button class="btn btn-sm btn-primary" id="openSettingsFromProducts">Abrir credenciales</button></div>`;
      $('openSettingsFromProducts')?.addEventListener('click', () => toggleSettings(true));
      $('loadMoreBtn')?.classList.add('hidden');
      showProductLoader(false);
      return;
    }
  }
  state.productLoading = true;
  const nextOffset = append ? state.productOffset : 0;
  if (!append) { showProductLoader(true, force ? 'Actualizando vista...' : 'Buscando productos...'); $('productsList').innerHTML = '<div class="skeleton-grid"><div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div></div>'; }
  setLoadingState(force ? 'Actualizando' : 'Buscando', 'Cargando catálogo rápido...');
  try {
    const endpoint = `/productos/search?${buildProductSearchParams(nextOffset)}${force ? '&refresh=true' : ''}`;
    const data = await api(endpoint);
    if (expectedStore !== state.activeStore) { pushUiLog('warning','Catálogo descartado por cambio de tienda', `${expectedStore} → ${state.activeStore}`); return; }
    if (data.store && data.store !== state.activeStore) { notifyWarning('Catálogo descartado', `El servidor respondió ${data.store}, pero la tienda activa es ${state.activeStore}.`); return; }
    let incoming = (data.productos || []).filter((p) => {
      const ps = normalizeStoreIdClient(p.store_id || p.store || data.store || state.activeStore);
      p.store_id = ps || state.activeStore;
      return !ps || ps === state.activeStore;
    });
    incoming = incoming.sort(sortProductsByStockThenName);
    state.productos = append ? [...state.productos, ...incoming] : incoming;
    state.productTotal = Number(data.total || state.productos.length);
    state.productOffset = state.productos.length;
    renderProducts();
    setLoadingState(data.cached ? 'Listo' : 'Actualizado', `${state.productos.length}/${state.productTotal} productos`);
  } catch (e) {
    notifyError('No se pudieron cargar productos', e.message);
    if (!append) {
      $('productsList').innerHTML = `<div class="empty-state error"><strong>No se pudo cargar el catálogo</strong><p>${text(e.message)}</p><button class="btn btn-sm btn-primary" id="openSettingsFromError">Revisar credenciales</button></div>`;
      $('openSettingsFromError')?.addEventListener('click', () => toggleSettings(true));
      $('loadMoreBtn')?.classList.add('hidden');
    }
  }
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

async function validateCoupon() {
  const code = $('couponCode')?.value?.trim();
  if (!code) { state.coupon = null; renderCart(); notifyWarning('Ingresa un cupón'); return; }
  const data = await api(`/cupones/validar?code=${encodeURIComponent(code)}`);
  state.coupon = data.coupon;
  renderCart();
  notifySuccess('Cupón válido', `${data.coupon.code} · ${data.coupon.discount_type} · ${data.coupon.amount}`);
}

function makeCouponCode(prefix='RIVAIDA') {
  return `${prefix}${Math.floor(1000 + Math.random()*9000)}`;
}
async function suggestCoupon() {
  if (!state.recommendations) {
    await recommendLabels();
  }
  const st = currentStore();
  const rec = state.recommendations?.coupon_suggestion || {};
  const total = state.cart.reduce((sum, item) => sum + Number(item.variation?.precio || item.product?.precio || 0) * Number(item.quantity || 1), 0);
  const prefix = st.country === 'CO' ? 'CO' : 'CL';
  const ship = selectedShippingLine();
  const freeShip = rec.free_shipping || (ship && (Number(ship.total || 0) === 0 || /gratis|free/i.test(`${ship.method_title || ''}`)));
  if ($('newCouponCode')) $('newCouponCode').value = rec.code || makeCouponCode(prefix);
  if ($('newCouponType')) $('newCouponType').value = rec.discount_type || 'percent';
  if ($('newCouponAmount')) $('newCouponAmount').value = rec.amount || (total >= (st.country === 'CO' ? 250000 : 80000) ? '10' : '5');
  if ($('newCouponDescription')) $('newCouponDescription').value = rec.reason || `Cupón sugerido para cerrar venta ${st.country}.`;
  if ($('newCouponFreeShipping')) $('newCouponFreeShipping').checked = Boolean(freeShip);
  notifySuccess('Cupón recomendado generado', 'Revísalo y presiona Crear cupón si quieres guardarlo en WooCommerce.');
}
async function createCoupon() {
  const code = $('newCouponCode')?.value?.trim();
  const amount = $('newCouponAmount')?.value?.trim();
  const discount_type = $('newCouponType')?.value || 'fixed_cart';
  if (!code || !amount) { notifyWarning('Completa código y monto del cupón'); return; }
  const payload = { code, amount, discount_type, description: $('newCouponDescription')?.value || '', usage_limit: $('newCouponUsageLimit')?.value || '', free_shipping: $('newCouponFreeShipping')?.checked || false };
  const data = await api('/cupones', { method:'POST', body: JSON.stringify(payload) });
  $('couponCode').value = data.coupon.code;
  state.coupon = data.coupon;
  renderCart();
  notifySuccess('Cupón creado', data.coupon.code);
}
async function searchCoupons() {
  const q = $('couponSearch')?.value?.trim() || '';
  const data = await api(`/cupones?search=${encodeURIComponent(q)}&limit=20`);
  state.coupons = data.cupones || [];
  const box = $('couponResults');
  if (!box) return;
  box.innerHTML = state.coupons.length ? state.coupons.map(c => `<button type="button" class="coupon-pill" data-use-coupon="${text(c.code)}"><strong>${text(c.code)}</strong><span>${text(c.discount_type)} · ${text(c.amount)}</span></button>`).join('') : '<span class="mini muted-line">Sin cupones encontrados.</span>';
  box.querySelectorAll('[data-use-coupon]').forEach(btn => btn.addEventListener('click', () => { $('couponCode').value = btn.dataset.useCoupon; validateCoupon().catch(e => notifyError(e.message)); }));
}
function clearCoupon() { state.coupon = null; if ($('couponCode')) $('couponCode').value = ''; renderCart(); notifySuccess('Cupón quitado'); }

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
  formatBillingPhoneInPlace();
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
    shipping_lines: selectedShippingLine() ? [selectedShippingLine()] : [],
    line_items: state.cart.map(i => ({ product_id:i.product.id, variation_id:i.variation?.id, quantity:i.quantity })),
    coupon_lines: state.coupon ? [{ code: state.coupon.code }] : [],
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
    shipping: selectedShippingLine(),
    products,
    total,
    note: payload.customer_note
  };
}
function platformPayloadToTextLocal(payload) {
  const c = payload.customer || {};
  const products = (payload.products || []).map(p => `- ${p.quantity}x ${p.name}${p.variation ? ` (${p.variation})` : ''} | SKU ${p.sku || 'N/D'} | ${p.price}`).join('\n');
  return [`PLATAFORMA: ${payload.platform}`,`PAIS: ${payload.country}`,`NOMBRE: ${c.full_name}`,`DOCUMENTO: ${c.document}`,`TELEFONO: ${c.phone_number}`,`EMAIL: ${c.email}`,`DIRECCION: ${c.address} ${c.address_2 || ''}`.trim(),`CIUDAD: ${c.city}`,`DEPARTAMENTO/REGION: ${c.state}`,`CODIGO POSTAL: ${c.postal_code}`,`METODO PAGO: ${payload.payment?.method_title || payload.payment?.method_id}`, payload.shipping ? `ENVIO: ${payload.shipping.method_title || payload.shipping.method_id} ${payload.shipping.total ? '(' + payload.shipping.total + ')' : ''}` : '',`TOTAL: ${payload.total} ${payload.currency}`,'PRODUCTOS:',products || '- Sin productos',payload.note ? `NOTA: ${payload.note}` : ''].filter(Boolean).join('\n');
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
  const paymentOpt = $('paymentMethod')?.selectedOptions?.[0];
  return {
    cliente: state.cliente,
    pedidos: state.pedidos,
    cart: state.cart,
    email: $('customerEmail')?.value?.trim() || '',
    rut: $('billingRut')?.value?.trim() || '',
    document: $('billingRut')?.value?.trim() || '',
    region: $('billingRegion')?.value || '',
    comuna: $('billingComuna')?.value || '',
    city: $('billingComuna')?.value || '',
    conversationId: $('conversationId')?.value?.trim() || '',
    store: state.activeStore,
    country: currentStore().country,
    payment: { method_id: $('paymentMethod')?.value || '', title: paymentOpt?.textContent || '' },
    shipping: selectedShippingLine(),
    payment_methods: state.paymentMethods || [],
    shipping_methods: state.shippingMethods || [],
    coupon: state.coupon,
    totals: { cart: state.cart.reduce((sum, item) => sum + Number(item.variation?.precio || item.product?.precio || 0) * Number(item.quantity || 1), 0) }
  };
}
function renderRecommendations(rec) {
  const box = $('recommendationBox');
  if (!box) return;
  if (!rec) { box.className = 'recommendation-box muted'; box.textContent = 'Sin recomendaciones todavía.'; return; }
  box.className = 'recommendation-box';
  const payments = (rec.available_payment_methods || []).map(m => `<span>${text(m.title || m.id)}</span>`).join('');
  const shipping = (rec.available_shipping_methods || []).map(m => `<span>${text(m.title || m.id)}${Number(m.total || 0) === 0 ? ' · gratis' : ''}</span>`).join('');
  const coupon = rec.coupon_suggestion ? `<div class="coupon-suggestion"><strong>Cupón sugerido:</strong> <code>${text(rec.coupon_suggestion.code)}</code> · ${text(rec.coupon_suggestion.amount)}${rec.coupon_suggestion.discount_type === 'percent' ? '%' : ''}${rec.coupon_suggestion.free_shipping ? ' · envío gratis' : ''}<br><small>${text(rec.coupon_suggestion.reason || '')}</small></div>` : '';
  box.innerHTML = `<div class="assistant-head"><strong>${rec.country === 'CO' ? 'Asistente Colombia' : 'Asistente Chile'}</strong><span>${rec.ai ? 'IA conectada' : 'Reglas locales'}</span></div><div class="rec-labels">${(rec.labels || []).map(l => `<span>${text(l)}</span>`).join('')}</div><div class="rec-grid"><div><strong>Motivos</strong><ul>${(rec.reasons || []).map(r => `<li>${text(r)}</li>`).join('')}</ul></div><div><strong>Próximos pasos</strong><ul>${(rec.next_actions || []).map(r => `<li>${text(r)}</li>`).join('')}</ul></div></div>${coupon}<div class="method-chips"><div><strong>Pagos Woo:</strong> ${payments || '<em>Sin datos</em>'}</div><div><strong>Envíos Woo:</strong> ${shipping || '<em>Sin datos</em>'}</div></div><label>Respuesta sugerida<textarea id="suggestedMessageBox">${text(rec.suggested_message || '')}</textarea></label>${rec.ai_error ? `<p class="mini bad">IA no disponible: ${text(rec.ai_error)}</p>` : ''}`;
  if (rec.coupon_suggestion && $('couponAiHint')) $('couponAiHint').textContent = `Sugerencia IA/reglas: ${rec.coupon_suggestion.code} · ${rec.coupon_suggestion.amount}${rec.coupon_suggestion.discount_type === 'percent' ? '%' : ''}`;
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
    rivaida_store: state.activeStore,
    rivaida_country: currentStore().country,
    rivaida_metodo_pago: $('paymentMethod')?.value || '',
    rivaida_metodo_envio: $('shippingMethod')?.selectedOptions?.[0]?.textContent || '',
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
  panel.setAttribute('aria-hidden', show ? 'false' : 'true');
  document.body.classList.toggle('modal-open', show);
  if (show) loadSettings().catch(e => { if ($('settingsStatus')) $('settingsStatus').textContent = e.message; notifyError(e.message); });
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
  if (state.chatwootContext) maybeAutoSwitchStoreFromContext(state.chatwootContext, 'configuración');
  if ($('settingsStatus')) $('settingsStatus').textContent = data.postgres ? 'Configuración guardada correctamente.' : 'Configuración temporal: revisa la conexión de base de datos.';
}
async function saveSettings() {
  const settings = collectSettingsForm();
  const data = await api('/admin/settings', { method:'POST', body: JSON.stringify({ settings }) });
  state.settings = { ...state.settings, ...settings };
  if ($('settingsStatus')) $('settingsStatus').textContent = `Guardado: ${data.saved_keys?.length || 0} variables. Recargando tiendas...`;
  await loadSettings().catch(()=>{});
  await loadStores();
  if (isStoreEnabled(state.activeStore)) {
    await loadRegiones(true);
    await loadCategorias(true);
    await loadPaymentMethods(true);
    await loadShippingMethods(true);
    await loadProducts(true);
  }
  notifySuccess('Credenciales guardadas', 'Si cambiaste dominio o CORS, ejecuta Deploy/Restart en EasyPanel para limpiar proxy y caché.');
}
async function testSettings(target, store='') {
  try {
    const settings = collectSettingsForm();
    const data = await api('/admin/settings/test', { method:'POST', body: JSON.stringify({ target, store, settings }) });
    notifySuccess('Prueba correcta', target === 'woo' ? `Woo ${store === 'co' ? 'Colombia' : 'Chile'} conectado.` : 'Chatwoot conectado.');
    alert(`Prueba correcta:
${JSON.stringify(data, null, 2)}`);
  } catch (e) {
    notifyError('Error en prueba', e.message);
    alert(`Error en prueba: ${e.message}`);
  }
}

async function clearCache() {
  localStorage.removeItem(`regiones_${state.activeStore}_v86`);
  ['cl','co'].forEach((id)=>localStorage.removeItem(`regiones_${id}_v86`));
  await api('/cache/clear', { method:'POST', body:'{}' });
  state.productos=[]; state.productOffset=0; state.productTotal=0;
  setLoadingState('Limpio'); notifySuccess('Cache limpiado');
}

function addHelpBubbles() {
  const helpMap = {
    'Email cliente':'Correo del cliente. Si la app se abre dentro de Chatwoot puede detectarlo automáticamente.',
    'ID conversación Chatwoot':'ID de conversación usado para enviar productos, etiquetas y atributos al chat.',
    'Tienda / pais':'Selector manual de tienda activa. Dentro de Chatwoot la app también cambia sola por inbox/bandeja, teléfono +56/+57, etiquetas o atributo rivaida_store.',
    'Dominio público':'URL pública de esta app, por ejemplo https://app.rivaida.cl.',
    'Token app Chatwoot':'Token que va en la URL de Dashboard App: ?panel_token=...',
    'Mapa Inbox → tienda JSON':'Ejemplo: {"12":"cl","15":"co"}. Así la app cambia de país por bandeja de WhatsApp.',
    'URL Woo Chile':'Dominio de WooCommerce Chile, sin /wp-admin ni /wp-json.',
    'URL Woo Colombia':'Dominio de WooCommerce Colombia, sin /wp-admin ni /wp-json.',
    'Enviar imagen como adjunto':'Para WhatsApp, usa JPG/PNG. WebP o imágenes pesadas pueden producir error 131053 y se enviará enlace de respaldo.',
    'Flow API URL':'Solo se usa para Flow directo. El flujo recomendado es link de pago WooCommerce.',
    'Prompt Chile':'Instrucciones de IA para responder ventas de Chile: RUT, comuna, CLP, Flow y despacho local.',
    'Prompt Colombia':'Instrucciones de IA para Colombia: CC/NIT, ciudad/departamento, COP y métodos disponibles.'
  };
  document.querySelectorAll('label').forEach(label => {
    if (label.dataset.helpAdded) return;
    const labelText = Array.from(label.childNodes).filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).join(' ').trim() || label.firstChild?.textContent?.trim() || '';
    const msg = helpMap[labelText];
    if (!msg) return;
    const b = document.createElement('span');
    b.className = 'help-bubble';
    b.textContent = '?';
    b.title = msg;
    b.setAttribute('aria-label', msg);
    label.insertBefore(b, label.firstElementChild || null);
    label.dataset.helpAdded = '1';
  });
}

$('loginForm').addEventListener('submit', async (e)=>{ e.preventDefault(); $('loginError').textContent=''; state.auth = btoa(`${$('loginUser').value.trim()}:${$('loginPassword').value}`); state.panelToken = ''; localStorage.removeItem('panelToken'); try { await api('/stores'); localStorage.setItem('panelAuth', state.auth); await enterApp(); } catch { $('loginError').textContent = 'Credenciales incorrectas o servidor no disponible.'; state.auth=''; } });
$('openSettingsBtn')?.addEventListener('click', () => toggleSettings(true));
$('openStatusBtn')?.addEventListener('click', () => openSystemModal('status'));
$('openLogsBtn')?.addEventListener('click', () => openSystemModal('logs'));
$('closeSystemModalBtn')?.addEventListener('click', closeSystemModal);
$('systemBackdrop')?.addEventListener('click', closeSystemModal);
$('closeSystemModalBtn2')?.addEventListener('click', closeSystemModal);
$('refreshSystemStatusBtn')?.addEventListener('click', () => openSystemModal(($('systemModalTitle')?.textContent || '').toLowerCase().includes('log') ? 'logs' : 'status')); 
$('refreshSystemStatusBtn')?.addEventListener('click', refreshSystemStatus);
$('closeSettingsBtn')?.addEventListener('click', () => toggleSettings(false));
$('settingsBackdrop')?.addEventListener('click', () => toggleSettings(false));
$('saveSettingsBtn')?.addEventListener('click', saveSettings);
$('testWooClBtn')?.addEventListener('click', () => testSettings('woo','cl'));
$('testWooCoBtn')?.addEventListener('click', () => testSettings('woo','co'));
$('testChatwootBtn')?.addEventListener('click', () => testSettings('chatwoot'));
$('logoutBtn').addEventListener('click', ()=>{ localStorage.removeItem('panelAuth'); localStorage.removeItem('panelToken'); state.auth=''; state.panelToken=''; showLogin(); });
$('loadBtn').addEventListener('click', () => loadPanel(false));

function renderLocalLogs() {
  const lines = (state.uiLogs || []).slice(0, 40).map(l => `[${new Date(l.time).toLocaleString()}] ${l.store || '-'} ${l.level}: ${l.message}${l.detail ? ' · ' + l.detail : ''}`);
  return lines.join('\n') || 'Sin logs locales.';
}
function statusBadge(ok, textOk='Conectado', textBad='Pendiente') {
  return `<span class="status-badge ${ok ? 'ok' : 'warn'}">${ok ? textOk : textBad}</span>`;
}
async function openSystemModal(mode='status') {
  $('systemModal')?.classList.remove('hidden');
  const title = $('systemModalTitle');
  if (title) title.textContent = mode === 'logs' ? 'Logs del panel' : 'Estado de conexiones';
  await refreshSystemStatus();
}
function closeSystemModal() { $('systemModal')?.classList.add('hidden'); }
async function refreshSystemStatus() {
  const box = $('systemStatusBox');
  const logs = $('systemLogsBox');
  if (box) box.innerHTML = '<div class="mini-loader"></div><p>Verificando conexiones...</p>';
  try {
    const data = await api('/diagnostics/status');
    const stores = data.stores || [];
    if (box) box.innerHTML = `
      <article class="status-card"><strong>App</strong>${statusBadge(true, data.app_name || 'Rivaida Commerce Hub')}<small>Versión ${text(data.version || '8.4')}</small></article>
      <article class="status-card"><strong>Chatwoot</strong>${statusBadge(data.chatwoot?.configured, 'Configurado', 'Sin credenciales')}<small>${text(data.chatwoot?.url || '')}</small></article>
      <article class="status-card"><strong>Índice rápido</strong>${statusBadge(data.postgres, 'Activo', 'Sin conexión')}<small>Redis: ${data.redis ? 'activo' : 'pendiente'}</small></article>
      ${stores.map(st => `<article class="status-card store-${st.id}"><strong>${text(st.name || st.id)}</strong>${statusBadge(st.enabled, 'Woo configurado', 'Woo pendiente')}<small>${text(st.country)} · ${text(st.currency)} · ${Number(st.index_count || 0)} productos indexados</small></article>`).join('')}
    `;
    if (logs) logs.textContent = (data.logs || []).map(l => `[${new Date(l.time).toLocaleString()}] ${l.level}: ${l.message}${l.store ? ' · ' + l.store : ''}${l.detail ? ' · ' + l.detail : ''}`).join('\n') + '\n\n--- Logs locales ---\n' + renderLocalLogs();
  } catch (e) {
    if (box) box.innerHTML = `<div class="empty-state error"><strong>No se pudo consultar estado</strong><p>${text(e.message)}</p></div>`;
    if (logs) logs.textContent = renderLocalLogs();
  }
}

$('refreshOrdersBtn')?.addEventListener('click', () => loadPanel(true));
$('refreshProductsBtn').addEventListener('click', () => loadProducts(true));
$('syncProductsBtn')?.addEventListener('click', syncProducts);
$('loadMoreBtn')?.addEventListener('click', () => loadProducts(false, true));
$('clearCacheBtn').addEventListener('click', clearCache);
$('productFilter').addEventListener('input', scheduleProductSearch);
$('categoryFilter')?.addEventListener('change', () => loadProducts(false));
$('saleFilter')?.addEventListener('change', () => loadProducts(false));
$('stockFilter')?.addEventListener('change', () => loadProducts(false));
$('billingPhone')?.addEventListener('blur', formatBillingPhoneInPlace);
$('billingPhone')?.addEventListener('change', formatBillingPhoneInPlace);
$('createOrderBtn').addEventListener('click', createOrder); $('payBtn').addEventListener('click', payOrder);
$('copyPlatformBtn')?.addEventListener('click', () => copyPlatformData('text'));
$('copyPlatformJsonBtn')?.addEventListener('click', () => copyPlatformData('json'));
$('sendSaleSummaryBtn')?.addEventListener('click', sendSaleSummaryToChat);
$('billingRegion').addEventListener('change', () => renderComunas($('billingRegion').value));
$('billingComuna').addEventListener('change', updatePostcode);
$('shippingMethod')?.addEventListener('change', () => { renderCart(); if (state.recommendations) renderRecommendations(state.recommendations); });
$('paymentMethod')?.addEventListener('change', () => { if (state.recommendations) renderRecommendations(state.recommendations); });
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
$('storeSelect')?.addEventListener('change', () => changeStore($('storeSelect').value).catch(e => notifyError(e.message)));

$('validateCouponBtn')?.addEventListener('click', () => validateCoupon().catch(e => notifyError(e.message)));
$('clearCouponBtn')?.addEventListener('click', clearCoupon);
$('createCouponBtn')?.addEventListener('click', () => createCoupon().catch(e => notifyError(e.message)));
$('searchCouponsBtn')?.addEventListener('click', () => searchCoupons().catch(e => notifyError(e.message)));
$('suggestCouponBtn')?.addEventListener('click', () => suggestCoupon().catch(e => notifyError(e.message)));
$('closeVariationModalBtn')?.addEventListener('click', closeVariationModal);
$('variationModalCancelBtn')?.addEventListener('click', closeVariationModal);
$('variationBackdrop')?.addEventListener('click', closeVariationModal);
$('variationModalApplyBtn')?.addEventListener('click', () => { closeVariationModal(); notifySuccess('Variación seleccionada'); });
$('themeMode')?.addEventListener('change', () => updateTheme($('themeMode').value, $('themeAccent')?.value));
$('themeAccent')?.addEventListener('change', () => updateTheme($('themeMode')?.value, $('themeAccent').value));
readUiLogs();
applyThemeSettings();
testAuth();
