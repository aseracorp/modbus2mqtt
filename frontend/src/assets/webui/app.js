/* Modbus2MQTT Sensor Manager — frontend logic */
'use strict';

const state = {
  busses: [],
  specs: [],
  config: null,
  auth: null
};

const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

/* ---------------- toast ---------------- */
let toastTimer = null;
function toast(msg, type = 'info') {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3200);
}

/* ---------------- api ---------------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  let data;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || ('Request failed (' + res.status + ')');
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

/* ---------------- i18n ---------------- */
let currentLang = 'en';
function setLang(lang) {
  currentLang = (lang === 'de' || lang === 'fr' || lang === 'it' || lang === 'en') ? lang : 'en';
  try { localStorage.setItem('m2m-lang', currentLang); } catch (e) { /* ignore */ }
  applyTranslations();
}
function langDict(code) {
  return (typeof window !== 'undefined' && window['LANG_' + code]) || {};
}
function t(key) {
  const d = langDict(currentLang);
  if (d && d[key] !== undefined) return d[key];
  const en = langDict('en');
  if (en && en[key] !== undefined) return en[key];
  return key;
}
function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    if (el.id === 'modal-title' || el.id === 'modal-body' || el.id === 'graph-title' || el.id === 'graph-body') return;
    const key = el.getAttribute('data-i18n');
    if (key && t(key)) el.textContent = t(key);
  });
  document.querySelectorAll('[data-ph]').forEach((el) => {
    const key = el.getAttribute('data-ph');
    if (key && t(key)) el.setAttribute('placeholder', t(key));
  });
}
$('lang-select')?.addEventListener('change', (e) => setLang(e.target.value));

/* ---------------- loading ---------------- */
async function loadAll() {
  try {
    const [busses, specs, auth] = await Promise.all([
      api('/api/busses'),
      api('/api/specifications'),
      api('/userAuthenticationStatus')
    ]);
    state.busses = busses || [];
    state.specs = specs || [];
    state.auth = auth || {};
    renderGateway();
    renderBusses();
    renderTemplates();
    populateBusSelect();
    populateSlaveSelect();
    populateTemplateList();
    if (!state.config) loadConfig();
  } catch (e) {
    toast(t('err_load_status') + e.message, 'error');
  }
}

/* ---------------- gateway / mqtt status ---------------- */
let mqttProbeCache = null; // {url, time, result} — throttle live MQTT probes (once per 30s max)
let mqttProbeInFlight = null;
async function checkMqttLive() {
  const cfg = state.config || {};
  const url = cfg.mqttconnect && cfg.mqttconnect.mqttserverurl ? cfg.mqttconnect.mqttserverurl : null;
  if (!url) return false;
  const now = Date.now();
  if (mqttProbeCache && mqttProbeCache.url === url && (now - mqttProbeCache.time) < 30000) {
    return mqttProbeCache.result;
  }
  if (mqttProbeInFlight) return mqttProbeInFlight;
  mqttProbeInFlight = (async () => {
    try {
      const r = await api('/api/validate/mqtt', {
        method: 'POST',
        body: JSON.stringify({ mqttconnect: { mqttserverurl: url } })
      });
      const result = !!(r && r.valid);
      mqttProbeCache = { url, time: Date.now(), result };
      return result;
    } catch (e) {
      mqttProbeCache = { url, time: Date.now(), result: false };
      return false; // probe failed → treated as not-connected by renderGateway
    } finally {
      mqttProbeInFlight = null;
    }
  })();
  return mqttProbeInFlight;
}
function renderGateway() {
  const gwEl = $('gw-status');
  const mqttEl = $('mqtt-status');
  const busCount = state.busses.length;
  if (gwEl) {
    gwEl.className = 'pill ' + (busCount > 0 ? 'ok' : 'bad');
    gwEl.innerHTML = '<span class="dot"></span>' + t('gateway') + ' ' + busCount;
    gwEl.setAttribute('data-tip', busCount === 1 ? '1 ' + t('device_count') : busCount + ' ' + t('device_count'));
  }
  if (mqttEl) {
    const cfg = state.config || {};
    const url = cfg.mqttconnect && cfg.mqttconnect.mqttserverurl ? cfg.mqttconnect.mqttserverurl : null;
    const configured = !!(state.auth && state.auth.mqttConfigured) || !!url;
    if (configured) {
      // Live probe on the configured URL (throttled — at most one attempt per 30s).
      checkMqttLive().then((live) => {
        const el = $('mqtt-status');
        if (!el) return;
        el.className = 'pill ' + (live ? 'ok' : 'warn');
        const label = live ? t('connected') : t('configured');
        el.innerHTML = '<span class="dot"></span>MQTT ' + escapeHtml(label);
        el.setAttribute('data-tip', (live ? t('connected') : t('configured')) + ': ' + escapeHtml(url));
      });
    } else {
      mqttEl.className = 'pill bad';
      mqttEl.innerHTML = '<span class="dot"></span>MQTT ' + escapeHtml(t('offline'));
      mqttEl.setAttribute('data-tip', t('mqtt') + ': ' + t('offline'));
    }
  }
}

/* ---------------- connection helpers ---------------- */
function getBusName(bus) {
  const c = bus.connectionData || {};
  if (c.serialport) return 'RTU: ' + c.serialport + (c.baudrate ? ' (' + c.baudrate + ' baud)' : '');
  if (c.host) return 'TCP: ' + c.host + ':' + (c.port || 502);
  return 'Bus #' + bus.busId;
}
function getBusSub(bus) {
  const c = bus.connectionData || {};
  if (c.serialport) {
    const parity = c.parity ? c.parity.charAt(0).toUpperCase() : 'N';
    const db = c.dataBits || 8, sb = c.stopBits || 1;
    return db + parity + sb + ' · timeout ' + (c.timeout || 1000) + ' ms';
  }
  return 'timeout ' + (c.timeout || 1000) + ' ms';
}
function getSlaveName(slave) {
  if (slave.name) return slave.name;
  if (slave.specificationid) return slave.specificationid;
  return 'Slave #' + slave.slaveid;
}
function getSlaveTemplateName(filename) {
  const s = state.specs.find((sp) => sp.filename === filename);
  if (!s) return filename;
  return s.model || filename;
}
function getSlaveTemplateManufacturer(filename) {
  const s = state.specs.find((sp) => sp.filename === filename);
  return s ? s.manufacturer : '';
}

function getTemplateFiles(filename) {
  const s = state.specs.find((sp) => sp.filename === filename);
  return (s && s.files) ? s.files : [];
}
function resolveFileUrl(f) {
  if (!f) return '';
  if (f.data) return f.data; // base64 local content
  return f.url || '';
}
function getTemplateImageUrl(filename) {
  const files = getTemplateFiles(filename);
  const img = files.find((f) => f.usage === 'img') || files.find((f) => f.usage === 'icon');
  return img ? resolveFileUrl(img) : '';
}
function getTemplateDocUrl(filename) {
  const files = getTemplateFiles(filename);
  const doc = files.find((f) => f.usage === 'doc');
  return doc ? resolveFileUrl(doc) : '';
}

/* ---------------- render busses ---------------- */
function renderBusses() {
  const list = $('bus-list');
  const countEl = $('device-count');
  let total = 0;
  (state.busses || []).forEach((b) => { total += (b.slaves || []).length; });
  if (countEl) countEl.textContent = total + ' ' + t('device_count');
  if (!state.busses || state.busses.length === 0) {
    list.innerHTML = '<div class="empty-row-inline">' + t('no_busses') + '</div>';
    return;
  }
  list.innerHTML = state.busses.map((bus) => {
    const slaves = (bus.slaves || []).map((s) => {
      const imgUrl = getTemplateImageUrl(s.specificationid);
      const docUrl = getTemplateDocUrl(s.specificationid);
      const imgCell = imgUrl
        ? '<span class="slave-img"><img src="' + escapeHtml(imgUrl) + '" alt="" loading="lazy"></span>'
        : '<span class="slave-img no-img"></span>';
      const docCell = docUrl
        ? '<span class="slave-doc"><a href="' + escapeHtml(docUrl) + '" target="_blank" rel="noopener" title="' + escapeHtml(t('datasheet')) + '">📄</a></span>'
        : '<span class="slave-doc"></span>';
      return `
      <div class="slave-row" data-busid="${bus.busId}" data-slaveid="${s.slaveid}">
        ${imgCell}
        <span class="slave-name">${escapeHtml(getSlaveName(s))}</span>
        <span class="slave-tpl">${escapeHtml(getSlaveTemplateName(s.specificationid))}</span>
        <span class="slave-id">#${s.slaveid}</span>
        ${docCell}
        <span class="slave-actions">
          <button class="icon-btn slave-poll" title="${t('poll_now')}" data-busid="${bus.busId}" data-slaveid="${s.slaveid}">⚡</button>
          <button class="icon-btn slave-edit" title="${t('edit_device')}" data-busid="${bus.busId}" data-slaveid="${s.slaveid}">✎</button>
          <button class="icon-btn slave-del" title="${t('remove_device')}" data-busid="${bus.busId}" data-slaveid="${s.slaveid}">✕</button>
        </span>
      </div>`;}).join('');
    return `
      <div class="bus-block" data-busid="${bus.busId}">
        <div class="bus-block-header">
          <span class="bus-icon">🔌</span>
          <span class="bus-title">${escapeHtml(getBusName(bus))}<div class="mono">${escapeHtml(getBusSub(bus))}</div></span>
          <span class="bus-sub">${(bus.slaves || []).length} ${t('device_count')}</span>
          <span class="bus-actions">
            <button class="icon-btn bus-add-slave" title="${t('add_slave')}" data-busid="${bus.busId}">＋</button>
            <button class="icon-btn bus-edit" title="${t('edit_bus')}" data-busid="${bus.busId}">✎</button>
            <button class="icon-btn bus-del" title="${t('remove_device')}" data-busid="${bus.busId}">✕</button>
          </span>
        </div>
        <div class="bus-slaves">
          ${slaves || '<div class="empty-slaves">' + t('no_devices') + '</div>'}
        </div>
      </div>`;
  }).join('');

  // bind actions
  list.querySelectorAll('.bus-block-header').forEach((h) => {
    h.addEventListener('click', (e) => {
      if (e.target.closest('.bus-actions')) return;
      h.parentElement.classList.toggle('collapsed');
    });
  });
  list.querySelectorAll('.bus-add-slave').forEach((b) => {
    b.addEventListener('click', (e) => { e.stopPropagation(); openAddSlave(b.getAttribute('data-busid')); });
  });
  list.querySelectorAll('.bus-edit').forEach((b) => {
    b.addEventListener('click', (e) => { e.stopPropagation(); openEditBus(b.getAttribute('data-busid')); });
  });
  list.querySelectorAll('.bus-del').forEach((b) => {
    b.addEventListener('click', (e) => { e.stopPropagation(); confirmRemoveBus(b.getAttribute('data-busid')); });
  });
  list.querySelectorAll('.slave-edit').forEach((b) => {
    b.addEventListener('click', () => openEditSlave(b.getAttribute('data-busid'), b.getAttribute('data-slaveid')));
  });
  list.querySelectorAll('.slave-del').forEach((b) => {
    b.addEventListener('click', () => confirmRemoveSlave(b.getAttribute('data-busid'), b.getAttribute('data-slaveid')));
  });
  list.querySelectorAll('.slave-poll').forEach((b) => {
    b.addEventListener('click', () => pollSlave(b.getAttribute('data-busid'), b.getAttribute('data-slaveid'), b));
  });
}

/* ---------------- templates ---------------- */
function tplStatusClass(status) {
  switch (status) {
    case 0: return 'published';
    case 1: return 'clone';
    case 2: return 'added';
    case 3: return 'stub';
    case 4: return 'contributed';
    default: return '';
  }
}
function tplStatusText(status) {
  const map = {
    0: t('tpl_status_4'), 1: t('tpl_status_2'), 2: t('tpl_status_5'),
    3: t('tpl_status_1'), 4: t('tpl_status_3')
  };
  return map[status] !== undefined ? map[status] : String(status);
}
function renderTemplates() {
  const tbody = $('template-body');
  const countEl = $('template-count');
  if (countEl) countEl.textContent = (state.specs || []).length + ' ' + t('templates_sub');
  if (!state.specs || state.specs.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">' + t('no_templates') + '</td></tr>';
    return;
  }
  tbody.innerHTML = state.specs.map((s) => {
    const imgUrl = getTemplateImageUrl(s.filename);
    const docUrl = getTemplateDocUrl(s.filename);
    const imgCell = imgUrl
      ? '<td class="tpl-img"><img src="' + escapeHtml(imgUrl) + '" alt="" loading="lazy"></td>'
      : '<td class="tpl-img no-img"></td>';
    const docCell = docUrl
      ? '<td class="tpl-doc"><a href="' + escapeHtml(docUrl) + '" target="_blank" rel="noopener" title="' + escapeHtml(t('datasheet')) + '">📄</a></td>'
      : '<td class="tpl-doc"></td>';
    return `
    <tr data-filename="${escapeHtml(s.filename)}">
      ${imgCell}
      <td>${escapeHtml(s.model || s.filename)}</td>
      <td>${escapeHtml(s.model || '')}</td>
      <td>${escapeHtml(s.manufacturer || '')}</td>
      ${docCell}
      <td><span class="status-badge ${tplStatusClass(s.status)}">${escapeHtml(tplStatusText(s.status))}</span></td>
      <td><div class="row-actions">
        <button class="icon-btn tpl-edit" title="${t('edit_device')}" data-filename="${escapeHtml(s.filename)}">✎</button>
        <button class="icon-btn tpl-del" title="${t('remove_device')}" data-filename="${escapeHtml(s.filename)}">✕</button>
      </div></td>
    </tr>`;}).join('');
  tbody.querySelectorAll('.tpl-edit').forEach((b) => {
    b.addEventListener('click', () => openEditTemplate(b.getAttribute('data-filename')));
  });
  tbody.querySelectorAll('.tpl-del').forEach((b) => {
    b.addEventListener('click', () => confirmRemoveTemplate(b.getAttribute('data-filename')));
  });
}

/* ---------------- serial devices ---------------- */
async function loadSerialDevices() {
  try {
    const devices = await api('/api/serial/devices');
    const sel = $('be-serialport');
    if (!sel) return;
    const cur = sel.value;
    if (!devices || devices.length === 0) {
      sel.outerHTML = '<input type="text" id="be-serialport" placeholder="/dev/ttyUSB0">';
      return;
    }
    sel.innerHTML = devices.map((d) => '<option value="' + escapeHtml(d) + '">' + escapeHtml(d) + '</option>').join('');
    if (cur !== '') sel.value = cur;
  } catch (e) { /* ignore */ }
}

/* ---------------- add / edit connection ---------------- */
let editingBusId = null;

async function loadDiscoveredModbus() {
  try {
    const servers = await api('/api/discovered/modbus/servers');
    return Array.isArray(servers) ? servers : [];
  } catch (e) {
    return [];
  }
}
async function refreshDiscoveredBanner() {
  const box = $('bus-discovered');
  if (!box) return;
  const servers = await loadDiscoveredModbus();
  if (!servers.length) {
    box.hidden = true;
    return;
  }
  const s = servers[0];
  $('bus-discovered-addr').textContent = s.host + ':' + s.port + (s.name ? '  (' + s.name + ')' : '');
  box.hidden = false;
}
function openAddBus() {
  editingBusId = null;
  $('busedit-title').textContent = t('add_bus_title');
  $('be-type').value = 'tcp';
  $('be-host').value = ''; $('be-port').value = '';
  $('be-serialport').value = ''; $('be-baudrate').value = '9600';
  $('be-framing').value = '8N1'; $('be-timeout').value = '1000'; $('be-tcpbridge').value = '';
  updateBusTypeFields();
  loadSerialDevices();
  $('busedit-overlay').hidden = false;
  refreshDiscoveredBanner();
  applyHelpIcons();
}
function openEditBus(busid) {
  const bus = (state.busses || []).find((b) => b.busId === Number(busid));
  if (!bus) return;
  editingBusId = Number(busid);
  $('busedit-title').textContent = t('edit_bus');
  const c = bus.connectionData || {};
  if (c.serialport) {
    $('be-type').value = 'rtu';
    $('be-serialport').value = c.serialport || '';
    $('be-baudrate').value = String(c.baudrate || '9600');
    const framing = (c.dataBits || 8) + (c.parity ? c.parity.charAt(0).toUpperCase() : 'N') + (c.stopBits || 1);
    $('be-framing').value = framing;
    $('be-tcpbridge').value = c.tcpBridgePort != null ? String(c.tcpBridgePort) : '';
  } else {
    $('be-type').value = 'tcp';
    $('be-host').value = c.host || '';
    $('be-port').value = String(c.port || 502);
  }
  $('be-timeout').value = String(c.timeout || 1000);
  updateBusTypeFields();
  loadSerialDevices();
  $('busedit-overlay').hidden = false;
  refreshDiscoveredBanner();
  applyHelpIcons();
}
function updateBusTypeFields() {
  const isRtu = $('be-type').value === 'rtu';
  document.querySelectorAll('.be-tcp').forEach((el) => { el.hidden = isRtu; });
  document.querySelectorAll('.be-rtu').forEach((el) => { el.hidden = !isRtu; });
}
$('be-type')?.addEventListener('change', updateBusTypeFields);
$('busedit-cancel')?.addEventListener('click', () => { $('busedit-overlay').hidden = true; });
$('bus-discovered-add')?.addEventListener('click', async () => {
  const addr = ($('bus-discovered-addr')?.textContent || '').split(' ')[0];
  const m = addr.match(/^(.+):(\d+)$/);
  if (!m) return;
  const host = m[1], port = parseInt(m[2], 10);
  try {
    await api('/api/discovered/modbus/add', { method: 'POST', body: JSON.stringify({ host, port }) });
    toast(t('bus_added'), 'success');
    $('busedit-overlay').hidden = true;
    await loadAll();
  } catch (e) {
    toast(t('err_add_device') + e.message, 'error');
  }
});
$('bus-discovered-ignore')?.addEventListener('click', async () => {
  const addr = ($('bus-discovered-addr')?.textContent || '').split(' ')[0];
  const m = addr.match(/^(.+):(\d+)$/);
  if (!m) return;
  const host = m[1], port = parseInt(m[2], 10);
  try {
    await api('/api/discovered/modbus/ignore', { method: 'POST', body: JSON.stringify({ host, port }) });
    toast(t('server_ignored'), 'success');
    await refreshDiscoveredBanner();
  } catch (e) {
    toast(t('err_save_config') + e.message, 'error');
  }
});
$('busedit-ok')?.addEventListener('click', async () => {
  const type = $('be-type').value;
  const timeout = parseInt($('be-timeout').value, 10) || 1000;
  let body;
  if (type === 'rtu') {
    const serialport = $('be-serialport').value.trim();
    const baudrate = parseInt($('be-baudrate').value, 10) || 9600;
    if (!serialport) return toast(t('err_no_busdata'), 'error');
    const framing = $('be-framing').value || '8N1';
    const db = parseInt(framing.charAt(0), 10) || 8;
    const par = framing.charAt(1) === 'E' ? 'even' : (framing.charAt(1) === 'O' ? 'odd' : 'none');
    const sb = parseInt(framing.charAt(2), 10) || 1;
    body = { serialport, baudrate, timeout, dataBits: db, parity: par, stopBits: sb };
    const bridge = parseInt($('be-tcpbridge').value, 10);
    if (!isNaN(bridge)) body.tcpBridgePort = bridge;
  } else {
    const host = $('be-host').value.trim();
    const port = parseInt($('be-port').value, 10);
    if (!host || isNaN(port)) return toast(t('err_no_busdata'), 'error');
    body = { host, port: port || 502, timeout };
  }
  try {
    let warned = false;
    if (editingBusId != null) {
      try {
        await api('/api/bus?busid=' + editingBusId, { method: 'POST', body: JSON.stringify(body) });
        toast(t('bus_updated'), 'success');
      } catch (e2) {
        // Backend tries to connect when saving a bus; on an unreachable host it
        // throws 500 even though the connection was saved. Match the Angular UI:
        // treat it as saved and let the list refresh.
        warned = true;
      }
    } else {
      try {
        await api('/api/bus', { method: 'POST', body: JSON.stringify(body) });
        toast(t('bus_added'), 'success');
      } catch (e2) {
        warned = true;
      }
    }
    $('busedit-overlay').hidden = true;
    if (warned) toast(t('bus_added') + ' — ' + t('offline'), 'warning');
    await loadAll();
  } catch (e) {
    toast(t('err_add_device') + e.message, 'error');
  }
});

/* ---------------- remove connection ---------------- */
let pendingRemoveBus = null;
function confirmRemoveBus(busid) {
  pendingRemoveBus = Number(busid);
  $('modal-title').textContent = t('remove_bus_title');
  $('modal-body').textContent = t('remove_bus_body');
  $('modal-overlay').hidden = false;
}

/* ---------------- add / edit slave ---------------- */
let editingSlave = null; // {busid, slaveid} or null for add
function populateBusSelect() {
  const sel = $('se-busselect');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = (state.busses || []).map((b) =>
    '<option value="' + b.busId + '">' + escapeHtml(getBusName(b)) + '</option>').join('') ||
    '<option value="">' + t('no_busses') + '</option>';
  if (cur !== '') sel.value = cur;
}
function populateSlaveSelect() {
  const sel = $('se-reference');
  if (!sel) return;
  const busid = Number($('se-busselect').value);
  const bus = (state.busses || []).find((b) => b.busId === busid);
  const cur = sel.value;
  sel.innerHTML = '<option value="">' + t('no_reference') + '</option>' +
    (bus ? bus.slaves.map((s) =>
      '<option value="' + s.slaveid + '">' + escapeHtml(getSlaveName(s)) + ' (#' + s.slaveid + ')</option>').join('') : '');
  if (cur) sel.value = cur;
}
$('se-busselect')?.addEventListener('change', populateSlaveSelect);

function openAddSlave(busid) {
  editingSlave = null;
  $('slaveedit-title').textContent = t('add_slave_title');
  $('se-busselect').value = busid != null ? String(busid) : (state.busses.length ? String(state.busses[0].busId) : '');
  $('se-slaveid').value = '';
  $('se-name').value = '';
  $('se-template-search').value = '';
  $('se-template-drop').hidden = true;
  $('se-pollmode').value = '0';
  $('se-pollinterval').value = '1000';
  $('se-roottopic').value = '';
  $('se-qos').value = '-1';
  $('se-maxreg').value = '';
  $('se-configurl').value = '';
  $('se-reference').value = '';
  slaveSpec = { filename: '', model: undefined, manufacturer: undefined, files: [], entities: [], i18n: [], identified: 0, status: 3, nextEntityId: 1 };
  renderDeviceRegisters();
  populateBusSelect();
  populateSlaveSelect();
  updatePollModeFields();
  $('slaveedit-overlay').hidden = false;
  applyHelpIcons();
}
async function openEditSlave(busid, slaveid) {
  const bus = (state.busses || []).find((b) => b.busId === Number(busid));
  if (!bus) return;
  const slave = bus.slaves.find((s) => s.slaveid === Number(slaveid));
  if (!slave) return;
  editingSlave = { busid: Number(busid), slaveid: Number(slaveid) };
  $('slaveedit-title').textContent = t('edit_slave_title');
  $('se-busselect').value = String(bus.busId);
  $('se-slaveid').value = String(slave.slaveid);
  $('se-name').value = slave.name || '';
  $('se-template-search').value = getSlaveTemplateName(slave.specificationid);
  $('se-template-drop').hidden = true;
  const pollMode = slave.pollMode != null ? slave.pollMode : 0;
  $('se-pollmode').value = String(pollMode === 4 ? 4 : (pollMode === 2 ? 2 : (pollMode === 1 ? 1 : (pollMode === 3 ? 3 : 0))));
  $('se-pollinterval').value = slave.pollInterval != null ? String(slave.pollInterval) : (slave.pollSchedule ? '' : '1000');
  $('se-roottopic').value = slave.rootTopic || '';
  $('se-qos').value = String(slave.qos != null ? slave.qos : -1);
  $('se-maxreg').value = slave.maxRegistersPerRequest != null ? String(slave.maxRegistersPerRequest) : '';
  $('se-configurl').value = slave.configurationUrl || '';
  $('se-reference').value = slave.referenceSlaveId != null ? String(slave.referenceSlaveId) : '';
  populateBusSelect();
  populateSlaveSelect();
  if (slave.referenceSlaveId != null) $('se-reference').value = String(slave.referenceSlaveId);
  slaveSpec = { filename: slave.specificationid || '', model: undefined, manufacturer: undefined, files: [], entities: [], i18n: [], identified: 0, status: 3, nextEntityId: 1 };
  // Load the device's own registers (the spec attached to this slave), if any.
  if (slave.specificationid) {
    try {
      const full = await api('/api/specification?spec=' + encodeURIComponent(slave.specificationid));
      if (full && Array.isArray(full.entities)) slaveSpec = full;
    } catch (e) { /* keep empty */ }
  }
  renderDeviceRegisters();
  updatePollModeFields();
  $('slaveedit-overlay').hidden = false;
  applyHelpIcons();
}
function updatePollModeFields() {
  const pm = $('se-pollmode').value;
  $('se-pollinterval-f').hidden = !(pm === '0' || pm === '2' || pm === '4');
  $('se-reference-f').hidden = (pm === '4');
}
$('se-pollmode')?.addEventListener('change', updatePollModeFields);
$('se-reg-add')?.addEventListener('click', () => {
  activeSpec = slaveSpec;
  openRegEdit(null);
});
$('slaveedit-cancel')?.addEventListener('click', () => { $('slaveedit-overlay').hidden = true; });
$('slaveedit-ok')?.addEventListener('click', async () => {
  const busidRaw = $('se-busselect').value;
  if (busidRaw === '' || busidRaw == null) return toast(t('err_no_bus'), 'error');
  const busid = Number(busidRaw);
  const slaveid = parseInt($('se-slaveid').value, 10);
  if (isNaN(slaveid)) return toast(t('err_no_slaveid'), 'error');
  const name = $('se-name').value.trim();
  const template = resolveTemplate($('se-template-search').value);
  const pollMode = parseInt($('se-pollmode').value, 10);
  const pollInterval = parseInt($('se-pollinterval').value, 10);
  const rootTopic = $('se-roottopic').value.trim();
  const qos = parseInt($('se-qos').value, 10);
  const maxReg = parseInt($('se-maxreg').value, 10);
  const configUrl = $('se-configurl').value.trim();
  const referenceId = parseInt($('se-reference').value, 10);

  const body = { slaveid };
  if (name) body.name = name;
  if (template && template.filename) {
    body.specificationid = template.filename;
  } else if ($('se-template-search').value.trim() && !template) {
    return toast(t('err_no_template'), 'error');
  }
  // Registers defined inline on the device (no template): attach them as a
  // device-scoped spec so the device can be used without a template.
  const inlineEnts = (slaveSpec && slaveSpec.entities) || [];
  if (!template && inlineEnts.length) {
    slaveSpec.filename = slaveSpec.filename || ('slave-' + busid + '-' + slaveid);
    slaveSpec.entities = inlineEnts;
    slaveSpec.i18n = slaveSpec.i18n || [];
    slaveSpec.files = slaveSpec.files || [];
    slaveSpec.identified = slaveSpec.identified == null ? 0 : slaveSpec.identified;
    slaveSpec.status = slaveSpec.status == null ? 3 : slaveSpec.status;
    body.specificationid = slaveSpec.filename.replace(/\.yaml$/, '');
  }
  body.pollMode = pollMode;
  if (pollInterval && !isNaN(pollInterval)) body.pollInterval = pollInterval;
  if (rootTopic) body.rootTopic = rootTopic;
  body.qos = qos;
  if (maxReg && !isNaN(maxReg)) body.maxRegistersPerRequest = maxReg;
  if (configUrl) body.configurationUrl = configUrl;
  if (!isNaN(referenceId) && referenceId > 0) body.referenceSlaveId = referenceId;

  try {
    await api('/api/slave?busid=' + busid, { method: 'POST', body: JSON.stringify(body) });
    // Save the inline device-scoped spec (registers added without a template).
    if (!template && inlineEnts.length && slaveSpec.filename) {
      const specForSave = Object.assign({}, slaveSpec, { filename: slaveSpec.filename });
      await api('/api/specification?busid=' + busid + '&slaveid=' + slaveid + '&originalFilename=' +
        encodeURIComponent(slaveSpec.filename), { method: 'POST', body: JSON.stringify(specForSave) });
    }
    toast(editingSlave ? t('device_updated') : t('device_added'), 'success');
    $('slaveedit-overlay').hidden = true;
    slaveSpec = null;
    await loadAll();
  } catch (e) {
    toast((editingSlave ? t('err_update_device') : t('err_add_device')) + e.message, 'error');
  }
});

/* ---------------- template search dropdown ---------------- */
let _tplSearchList = [];
function populateTemplateList() {
  const ul = $('se-template-list');
  if (!ul) return;
  _tplSearchList = state.specs || [];
  ul.innerHTML = _tplSearchList.map((sp) =>
    '<li data-tpl="' + escapeHtml(sp.filename) + '" data-model="' + escapeHtml(sp.model || '') + '" data-manufacturer="' + escapeHtml(sp.manufacturer || '') + '">' +
      '<span class="eep-code">' + escapeHtml(sp.filename) + '</span>' +
      '<span class="eep-name">' + escapeHtml(sp.model || '') + (sp.manufacturer ? ' · ' + escapeHtml(sp.manufacturer) : '') + '</span></li>'
  ).join('');
}
function initTemplateCombo() {
  const input = $('se-template-search');
  const list = $('se-template-list');
  const drop = $('se-template-drop');
  if (!input || !list || !drop) return;
  let filter = '';
  const render = () => {
    const q = filter.toLowerCase();
    let count = 0;
    list.querySelectorAll('li').forEach((li) => {
      const hay = (li.getAttribute('data-tpl') + ' ' + li.getAttribute('data-model') + ' ' + li.getAttribute('data-manufacturer')).toLowerCase();
      const match = !q || hay.includes(q);
      li.hidden = !match;
      if (match) count++;
    });
    return count;
  };
  input.addEventListener('focus', () => { render(); drop.hidden = false; });
  input.addEventListener('input', () => { filter = input.value; render(); drop.hidden = false; });
  input.addEventListener('blur', () => setTimeout(() => { drop.hidden = true; }, 150));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); const c = list.querySelector('li:not([hidden])'); if (c) c.focus(); }
    else if (e.key === 'Escape') drop.hidden = true;
  });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-tpl]');
    if (!li) return;
    input.value = li.getAttribute('data-model') || li.getAttribute('data-tpl');
    drop.hidden = true;
  });
  list.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const li = e.target.closest('li[data-tpl]'); if (li) li.click(); }
  });
}
function resolveTemplate(value) {
  const v = (value || '').trim().toLowerCase();
  if (!v) return null;
  return (state.specs || []).find((sp) =>
    sp.filename.toLowerCase() === v ||
    sp.filename.toLowerCase() === (v.endsWith('.yaml') ? v : v + '.yaml') ||
    (sp.model && sp.model.toLowerCase() === v) ||
    (sp.manufacturer && sp.manufacturer.toLowerCase() === v)) || null;
}

/* ---------------- poll slave ---------------- */
async function pollSlave(busid, slaveid, btn) {
  if (btn) { btn.disabled = true; btn.style.opacity = 0.5; }
  try {
    await api('/api/slave/poll?busid=' + busid + '&slaveid=' + slaveid, { method: 'POST', body: '{}' });
    toast(t('poll_now') + ' ✓', 'success');
  } catch (e) {
    toast(t('err_update_device') + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
}

/* ---------------- remove slave ---------------- */
let pendingRemoveSlave = null;
function confirmRemoveSlave(busid, slaveid) {
  pendingRemoveSlave = { busid: Number(busid), slaveid: Number(slaveid) };
  $('modal-title').textContent = t('remove_slave_title');
  $('modal-body').textContent = t('remove_slave_body');
  $('modal-overlay').hidden = false;
}

/* ---------------- templates add/edit/remove ---------------- */
let editingTemplate = null;
// working copy of the template being added/edited (full ImodbusSpecification)
let templateSpec = null;
let slaveSpec = null;
// spec that the register editor currently edits (templateSpec or slaveSpec)
let activeSpec = null;

function emptyTemplateSpec() {
  return { filename: '', model: undefined, manufacturer: undefined, files: [], entities: [], i18n: [], identified: 0, status: 3, nextEntityId: 1 };
}

async function openAddTemplate() {
  editingTemplate = null;
  templateSpec = emptyTemplateSpec();
  $('tpledit-title').textContent = t('add_template');
  $('te-filename').value = ''; $('te-model').value = ''; $('te-manufacturer').value = '';
  renderTemplateRegisters();
  $('tpledit-overlay').hidden = false;
  applyHelpIcons();
}
async function openEditTemplate(filename) {
  const sp = (state.specs || []).find((s) => s.filename === filename);
  if (!sp) return;
  editingTemplate = filename;
  $('tpledit-title').textContent = t('edit_bus') + ' — ' + filename;
  $('te-filename').value = sp.filename.replace(/\.yaml$/, '');
  $('te-model').value = sp.model || '';
  $('te-manufacturer').value = sp.manufacturer || '';
  try {
    const full = await api('/api/specification?spec=' + encodeURIComponent(sp.filename));
    templateSpec = full || emptyTemplateSpec();
    templateSpec.filename = sp.filename;
  } catch (e) {
    templateSpec = emptyTemplateSpec();
    templateSpec.filename = sp.filename;
  }
  renderTemplateRegisters();
  $('tpledit-overlay').hidden = false;
  applyHelpIcons();
}
$('tpledit-cancel')?.addEventListener('click', () => { $('tpledit-overlay').hidden = true; templateSpec = null; });
$('te-reg-add')?.addEventListener('click', () => openRegEdit(null));
function renderTemplateRegisters() {
  const tbody = $('te-reg-body');
  const ents = (templateSpec && templateSpec.entities) || [];
  if (!ents.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="9">' + t('reg_none') + '</td></tr>';
    return;
  }
  tbody.innerHTML = ents.map((en, i) => {
    const cp = en.converterParameters || {};
    const isNum = en.converter === 'number';
    const rw = en.readonly ? 'R' : 'R/W';
    const cat = en.category === 'config' ? 'config' : 'value';
    const cond = en.condition ? '<span class="reg-cond-mark" title="' + t('reg_cond') + ': ' + escapeHtml(String(en.condition.register)) + '">⚑</span>' : '';
    return '<tr data-idx="' + i + '">' +
      '<td>' + escapeHtml(en.name || '') + ' ' + cond + '</td>' +
      '<td>' + escapeHtml(en.mqttname || '') + '</td>' +
      '<td>' + escapeHtml(regTypeName(en.registerType)) + '</td>' +
      '<td>' + escapeHtml(String(en.modbusAddress == null ? '' : en.modbusAddress)) + '</td>' +
      '<td>' + escapeHtml(rw) + '</td>' +
      '<td>' + escapeHtml(en.converter || '') + '</td>' +
      '<td>' + escapeHtml(isNum ? (cp.uom || '') : '') + '</td>' +
      '<td class="cfg-badge ' + cat + '">' + cat + '</td>' +
      '<td><div class="row-actions">' +
        '<button class="icon-btn reg-edit" data-idx="' + i + '" title="' + t('edit_device') + '">✎</button>' +
        '<button class="icon-btn reg-del" data-idx="' + i + '" title="' + t('remove_device') + '">✕</button>' +
      '</div></td></tr>';
  }).join('');
  tbody.querySelectorAll('.reg-edit').forEach((b) => b.addEventListener('click', () => openRegEdit(Number(b.getAttribute('data-idx')))));
  tbody.querySelectorAll('.reg-del').forEach((b) => {
    b.addEventListener('click', () => {
      const i = Number(b.getAttribute('data-idx'));
      (templateSpec.entities || []).splice(i, 1);
      renderTemplateRegisters();
    });
  });
}
function renderActiveRegisters() {
  if (activeSpec === slaveSpec) renderDeviceRegisters();
  else renderTemplateRegisters();
}
function renderDeviceRegisters() {
  const tbody = $('se-reg-body');
  if (!tbody) return;
  const ents = (slaveSpec && slaveSpec.entities) || [];
  if (!ents.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="9">' + t('reg_none') + '</td></tr>';
    return;
  }
  tbody.innerHTML = ents.map((en, i) => {
    const cp = en.converterParameters || {};
    const isNum = en.converter === 'number';
    const rw = en.readonly ? 'R' : 'R/W';
    const cat = en.category === 'config' ? 'config' : 'value';
    const cond = en.condition ? '<span class="reg-cond-mark" title="' + t('reg_cond') + ': ' + escapeHtml(String(en.condition.register)) + '">⚑</span>' : '';
    return '<tr data-idx="' + i + '">' +
      '<td>' + escapeHtml(en.name || '') + ' ' + cond + '</td>' +
      '<td>' + escapeHtml(en.mqttname || '') + '</td>' +
      '<td>' + escapeHtml(regTypeName(en.registerType)) + '</td>' +
      '<td>' + escapeHtml(String(en.modbusAddress == null ? '' : en.modbusAddress)) + '</td>' +
      '<td>' + escapeHtml(rw) + '</td>' +
      '<td>' + escapeHtml(en.converter || '') + '</td>' +
      '<td>' + escapeHtml(isNum ? (cp.uom || '') : '') + '</td>' +
      '<td class="cfg-badge ' + cat + '">' + cat + '</td>' +
      '<td><div class="row-actions">' +
        '<button class="icon-btn reg-edit" data-idx="' + i + '" title="' + t('edit_device') + '">✎</button>' +
        '<button class="icon-btn reg-del" data-idx="' + i + '" title="' + t('remove_device') + '">✕</button>' +
      '</div></td></tr>';
  }).join('');
  tbody.querySelectorAll('.reg-edit').forEach((b) => b.addEventListener('click', () => { activeSpec = slaveSpec; openRegEdit(Number(b.getAttribute('data-idx'))); }));
  tbody.querySelectorAll('.reg-del').forEach((b) => {
    b.addEventListener('click', () => {
      const i = Number(b.getAttribute('data-idx'));
      (slaveSpec.entities || []).splice(i, 1);
      renderDeviceRegisters();
    });
  });
}

function regTypeName(rt) {
  switch (rt) { case 1: return 'coil'; case 2: return 'discrete'; case 3: return 'holding'; case 4: return 'input'; default: return String(rt == null ? '' : rt); }
}
function regConverterShown() {
  const cv = $('re-converter') ? $('re-converter').value : 'number';
  $('reg-conv-number').hidden = cv !== 'number';
  $('reg-conv-text').hidden = cv !== 'text';
}
let editingRegIdx = null;
function openRegEdit(idx) {
  editingRegIdx = idx;
  const spec = activeSpec || templateSpec;
  const ents = (spec && spec.entities) || [];
  const en = idx == null ? { converter: 'number', converterParameters: {}, registerType: 3, readonly: true } : (ents[idx] || {});
  const cp = en.converterParameters || {};
  $('re-name').value = en.name || '';
  $('re-mqttname').value = en.mqttname || '';
  $('re-registertype').value = String(en.registerType == null ? 3 : en.registerType);
  $('re-modbusaddress').value = en.modbusAddress == null ? '' : String(en.modbusAddress);
  $('re-readonly').checked = !!en.readonly;
  $('re-category').value = en.category || en.entityCategory || 'value';
  // condition
  const cond = en.condition || {};
  $('re-cond-register').value = cond.register != null ? String(cond.register) : '';
  $('re-cond-bits').value = cond.bits && cond.bits.length ? cond.bits.join(',') : '';
  $('re-cond-equals').value = cond.equals != null ? String(cond.equals) : '';
  $('re-converter').value = en.converter || 'number';
  $('re-multiplier').value = cp.multiplier == null ? '' : String(cp.multiplier);
  $('re-offset').value = cp.offset == null ? '' : String(cp.offset);
  $('re-decimals').value = cp.decimals == null ? '' : String(cp.decimals);
  $('re-numberformat').value = cp.numberFormat == null ? '0' : String(cp.numberFormat);
  $('re-uom').value = cp.uom || '';
  $('re-deviceclass').value = cp.device_class || '';
  $('re-stateclass').value = cp.state_class == null ? '' : String(cp.state_class);
  $('re-min').value = (cp.identification && cp.identification.min != null) ? String(cp.identification.min) : '';
  $('re-max').value = (cp.identification && cp.identification.max != null) ? String(cp.identification.max) : '';
  $('re-step').value = cp.step == null ? '' : String(cp.step);
  $('re-swapwords').checked = !!cp.swapWords;
  $('re-swapbytes').checked = !!cp.swapBytes;
  $('re-stringlength').value = cp.stringlength == null ? '' : String(cp.stringlength);
  regConverterShown();
  $('regedit-title').textContent = idx == null ? t('reg_add') : t('reg_edit');
  // Re-apply translations for the dynamically-opened editor (hints, labels).
  const form = $('regedit-form');
  form.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key && t(key)) el.textContent = t(key);
  });
  $('regedit-overlay').hidden = false;
  applyHelpIcons(form);
}
$('re-converter')?.addEventListener('change', regConverterShown);
$('regedit-cancel')?.addEventListener('click', () => { $('regedit-overlay').hidden = true; });
$('regedit-ok')?.addEventListener('click', () => {
  const name = $('re-name').value.trim();
  const mqttname = $('re-mqttname').value.trim();
  const registerType = parseInt($('re-registertype').value, 10);
  const modbusAddress = $('re-modbusaddress').value.trim() === '' ? undefined : parseInt($('re-modbusaddress').value.trim(), 10);
  const readonly = $('re-readonly').checked;
  const entityCategory = $('re-category').value || undefined;
  const converter = $('re-converter').value;
  const cp = {};
  if (converter === 'number') {
    const setNum = (k, v) => { if (v !== '') { const n = Number(v); if (!isNaN(n)) cp[k] = n; } };
    setNum('multiplier', $('re-multiplier').value); setNum('offset', $('re-offset').value); setNum('decimals', $('re-decimals').value);
    setNum('numberFormat', $('re-numberformat').value);
    const uom = $('re-uom').value.trim(); if (uom) cp.uom = uom;
    const dc = $('re-deviceclass').value.trim(); if (dc) cp.device_class = dc;
    if ($('re-stateclass').value !== '') cp.state_class = parseInt($('re-stateclass').value, 10);
    const min = $('re-min').value.trim(), max = $('re-max').value.trim();
    if (min !== '' || max !== '') {
      cp.identification = {};
      if (min !== '') cp.identification.min = Number(min);
      if (max !== '') cp.identification.max = Number(max);
    }
    setNum('step', $('re-step').value);
    if ($('re-swapwords').checked) cp.swapWords = true;
    if ($('re-swapbytes').checked) cp.swapBytes = true;
  } else if (converter === 'text') {
    const sl = $('re-stringlength').value.trim();
    if (sl !== '') cp.stringlength = parseInt(sl, 10);
  } else if (converter === 'select') {
    // options preserved from existing entity
    const old = editingRegIdx != null && templateSpec.entities[editingRegIdx] ? templateSpec.entities[editingRegIdx].converterParameters || {} : {};
    cp.options = old.options;
  }
  const spec = activeSpec || templateSpec;
  const ents = (spec && spec.entities) || (spec.entities = []);
  const en = {
    id: editingRegIdx != null ? (ents[editingRegIdx].id) : ((spec.nextEntityId) || (spec.nextEntityId = 1)),
    name: name || undefined,
    mqttname: mqttname || undefined,
    registerType, modbusAddress, readonly, converter,
    converterParameters: cp,
    valid: true
  };
  // category: 'value' (default), 'config' (device config - not published), 'diagnostic'
  const category = $('re-category').value || 'value';
  if (category === 'config') en.category = 'config';
  else if (category === 'diagnostic') en.entityCategory = 'diagnostic';
  // condition
  const condReg = $('re-cond-register').value.trim();
  if (condReg !== '') {
    const cond = { register: parseInt(condReg, 10) };
    const bits = $('re-cond-bits').value.trim();
    if (bits !== '') cond.bits = bits.split(',').map((b) => parseInt(b.trim(), 10)).filter((n) => !isNaN(n));
    const eq = $('re-cond-equals').value.trim();
    if (eq !== '') cond.equals = parseInt(eq, 10);
    en.condition = cond;
  }
  if (editingRegIdx != null) {
    const old = ents[editingRegIdx];
    en.id = old.id;
    if (old.converter === 'select' && converter === 'select') en.converterParameters = Object.assign({}, old.converterParameters, cp);
    ents[editingRegIdx] = en;
  } else {
    if (typeof spec.nextEntityId === 'number') spec.nextEntityId++;
    ents.push(en);
  }
  $('regedit-overlay').hidden = true;
  renderActiveRegisters();
});
$('tpledit-ok')?.addEventListener('click', async () => {
  const filename = $('te-filename').value.trim().replace(/\.yaml$/, '');
  const model = $('te-model').value.trim();
  const manufacturer = $('te-manufacturer').value.trim();
  if (!filename) return toast(t('err_no_name'), 'error');
  const spec = Object.assign({}, templateSpec || emptyTemplateSpec(), {
    filename: filename + '.yaml',
    model: model || undefined,
    manufacturer: manufacturer || undefined
  });
  if (!Array.isArray(spec.entities)) spec.entities = [];
  if (typeof spec.files !== 'object' || spec.files === null) spec.files = [];
  if (!Array.isArray(spec.i18n)) spec.i18n = [];
  if (spec.identified == null) spec.identified = 0;
  if (spec.status == null) spec.status = 3;
  try {
    // A template needs a home slave to be saved via the specification route. Find the first connection/slave.
    const bus = (state.busses || [])[0];
    const slave = bus && bus.slaves && bus.slaves[0];
    if (!bus || !slave) {
      toast(t('err_no_bus') + ' — ' + t('add_slave'), 'error');
      return;
    }
    await api('/api/specification?busid=' + bus.busId + '&slaveid=' + slave.slaveid + '&originalFilename=' +
      encodeURIComponent(editingTemplate || filename + '.yaml'), { method: 'POST', body: JSON.stringify(spec) });
    toast(editingTemplate ? t('template_updated') : t('template_added'), 'success');
    $('tpledit-overlay').hidden = true;
    templateSpec = null;
    await loadAll();
  } catch (e) {
    toast(t('err_save_template') + e.message, 'error');
  }
});
window.openAddTemplate = openAddTemplate;

let pendingRemoveTemplate = null;
function confirmRemoveTemplate(filename) {
  pendingRemoveTemplate = filename;
  $('modal-title').textContent = t('remove_device');
  $('modal-body').textContent = t('remove_bus_body');
  $('modal-overlay').hidden = false;
}

/* ---------------- generic confirm ---------------- */
$('modal-cancel')?.addEventListener('click', () => { $('modal-overlay').hidden = true; pendingRemoveBus = null; pendingRemoveSlave = null; pendingRemoveTemplate = null; });
$('modal-overlay')?.addEventListener('click', (e) => {
  if (e.target === $('modal-overlay')) { $('modal-overlay').hidden = true; pendingRemoveBus = null; pendingRemoveSlave = null; pendingRemoveTemplate = null; }
});
$('modal-ok')?.addEventListener('click', async () => {
  const bus = pendingRemoveBus;
  const slave = pendingRemoveSlave;
  const tpl = pendingRemoveTemplate;
  $('modal-overlay').hidden = true;
  pendingRemoveBus = null; pendingRemoveSlave = null; pendingRemoveTemplate = null;
  try {
    if (bus != null) {
      await api('/api/bus?busid=' + bus, { method: 'DELETE' });
      toast(t('device_removed'), 'success');
    } else if (slave) {
      await api('/api/slave?busid=' + slave.busid + '&slaveid=' + slave.slaveid + '&detachReferences=true', { method: 'DELETE' });
      toast(t('device_removed'), 'success');
    } else if (tpl) {
      await api('/api/specification?spec=' + encodeURIComponent(tpl), { method: 'DELETE' });
      toast(t('template_removed'), 'success');
    }
    await loadAll();
  } catch (e) {
    toast(t('err_remove_device') + e.message, 'error');
  }
});

/* ---------------- add-options ---------------- */
function openAddModal(kind) {
  if (kind === 'bus') openAddBus();
  else if (kind === 'slave') openAddSlave();
  else if (kind === 'template') openAddTemplate();
}
document.querySelectorAll('.add-option').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    const cat = e.target.closest('[data-addcat]').getAttribute('data-addcat');
    if (cat) openAddModal(cat);
  });
});

/* ---------------- config editor ---------------- */
const CONFIG_HIDDEN = new Set([
  'version', 'appVersion', 'httpport', 'httpsPort', 'httpsCertFile', 'httpsKeyFile',
  'rootUrl', 'frontendDir', 'supervisor_host', 'tcpBridgePort', 'mqttusehassio',
  'githubPersonalToken', 'filelocation', 'fakeModbus'
]);
// Ordered MQTT + general fields shown in the config modal (single MQTT server assumption).
const MQTT_FIELDS = [
  { key: 'mqttserverurl', labelKey: 'cfg_mqtt_url', type: 'text', placeholder: 'mqtt://mosquitto:1883', helpKey: 'cfg_mqtt_url_help' },
  { key: 'mqttuser', labelKey: 'cfg_mqtt_user', type: 'text', helpKey: 'cfg_mqtt_user_help' },
  { key: 'mqttpassword', labelKey: 'cfg_mqtt_password', type: 'password', helpKey: 'cfg_mqtt_password_help' },
  { key: 'mqttbasetopic', labelKey: 'cfg_mqtt_base_topic', type: 'text', placeholder: 'modbus2mqtt', helpKey: 'cfg_mqtt_base_topic_help' },
  { key: 'mqttdiscoveryprefix', labelKey: 'cfg_mqtt_discovery_prefix', type: 'text', placeholder: 'homeassistant', helpKey: 'cfg_mqtt_discovery_prefix_help' },
  { key: 'mqttdiscoverylanguage', labelKey: 'cfg_mqtt_discovery_lang', type: 'text', placeholder: 'en', helpKey: 'cfg_mqtt_discovery_lang_help' },
  { key: 'mqttcafile', labelKey: 'cfg_mqtt_ca_file', type: 'file-combo', helpKey: 'cfg_mqtt_ca_file_help' },
  { key: 'mqttcertfile', labelKey: 'cfg_mqtt_cert_file', type: 'file-combo', helpKey: 'cfg_mqtt_cert_file_help' },
  { key: 'mqttkeyfile', labelKey: 'cfg_mqtt_key_file', type: 'file-combo', helpKey: 'cfg_mqtt_key_file_help' }
];
const CONFIG_FIELDS = [
  { key: 'debugComponents', labelKey: 'cfg_debug_components', type: 'text', helpKey: 'cfg_debug_components_help' },
  { key: 'displayHex', labelKey: 'cfg_display_hex', type: 'bool', helpKey: 'cfg_display_hex_help' }
];
const CONFIG_KEYMAP = {
  mqttuser: 'mqttconnect.username',
  mqttpassword: 'mqttconnect.password',
  mqttserverurl: 'mqttconnect.mqttserverurl',
  mqttbasetopic: 'mqttbasetopic',
  mqttdiscoveryprefix: 'mqttdiscoveryprefix',
  mqttdiscoverylanguage: 'mqttdiscoverylanguage',
  mqttcafile: 'mqttcaFile', mqttcertfile: 'mqttcertFile', mqttkeyfile: 'mqttkeyFile',
  debugComponents: 'debugComponents', displayHex: 'displayHex'
};
function configDottedKey(fieldKey) {
  return CONFIG_KEYMAP[fieldKey] || fieldKey;
}
// ssl file list cache
let stateSslFiles = [];
async function loadSslFiles() {
  try { stateSslFiles = await api('/api/sslfiles'); } catch (e) { stateSslFiles = []; }
}
// lookup helpers for the current config
function configGet(conf, dottedKey) {
  return dottedKey.split('.').reduce((o, k) => (o == null ? o : o[k]), conf);
}
function configSet(conf, dottedKey, val) {
  const parts = dottedKey.split('.');
  let cur = conf;
  parts.slice(0, -1).forEach((p) => { cur[p] = cur[p] || {}; cur = cur[p]; });
  if (val === undefined || val === '') { delete cur[parts[parts.length - 1]]; }
  else { cur[parts[parts.length - 1]] = val; }
}
async function loadConfig() {
  try {
    state.config = await api('/api/configuration');
    renderGateway();
  } catch (e) {
    toast(t('err_load_config') + e.message, 'error');
  }
}
function helpIcon(field) {
  if (!field.helpKey) return '';
  return '<span class="help-icon" data-tip="' + escapeHtml(t(field.helpKey)) + '">ⓘ</span>';
}
function labelWithHelp(field, id) {
  return '<label for="' + id + '">' + escapeHtml(t(field.labelKey)) + ' ' + helpIcon(field) + '</label>';
}
function renderConfigField(flatGet, field, idPrefix) {
  const val = configGet(flatGet, configDottedKey(field.key));
  const label = t(field.labelKey);
  const id = (idPrefix || 'cfg-') + field.key;
  if (field.type === 'password') {
    return '<div class="field"><label for="' + id + '">' + escapeHtml(label) + ' ' + helpIcon(field) + '</label>' +
      '<input type="password" id="' + id + '" data-cfgkey="' + field.key + '" value="' + escapeHtml(String(val == null ? '' : val)) + '" autocomplete="new-password"></div>';
  }
  if (field.type === 'bool') {
    const checked = ['1', 'true', 'yes', 'on'].includes(String(val == null ? '' : val).trim().toLowerCase());
    return '<div class="field config-bool"><label for="' + id + '">' + escapeHtml(label) + ' ' + helpIcon(field) + '</label>' +
      '<input type="checkbox" id="' + id + '" data-cfgkey="' + field.key + '"' + (checked ? ' checked' : '') + '>' +
      '<input type="hidden" data-cfgkey="' + field.key + '" data-boolhidden="' + field.key + '" value="' + (checked ? '1' : '0') + '"></div>';
  }
  if (field.type === 'file-combo') {
    // text input + datalist + browse button (combobox like the EEP field); shows current value
    const opts = (stateSslFiles || []).map((f) => '<option value="' + escapeHtml(f) + '"></option>').join('');
    return '<div class="field"><label for="' + id + '">' + escapeHtml(label) + ' ' + helpIcon(field) + '</label>' +
      '<div class="eep-combo file-combo">' +
        '<input type="text" id="' + id + '" data-cfgkey="' + field.key + '" list="' + id + '-list" value="' + escapeHtml(String(val == null ? '' : val)) + '" placeholder="cert.pem">' +
        '<datalist id="' + id + '-list">' + opts + '</datalist>' +
        '<button type="button" class="btn btn-sm file-browse" data-for="' + field.key + '" title="' + escapeHtml(t('cfg_browse_files')) + '">📂</button>' +
      '</div></div>';
  }
  const ph = field.placeholder ? ' placeholder="' + escapeHtml(field.placeholder) + '"' : '';
  return '<div class="field"><label for="' + id + '">' + escapeHtml(label) + ' ' + helpIcon(field) + '</label>' +
    '<input type="text" id="' + id + '" data-cfgkey="' + field.key + '" value="' + escapeHtml(String(val == null ? '' : val)) + '"' + ph + '></div>';
}
function bindConfigCheckboxes(grid) {
  grid.querySelectorAll('input[type=checkbox][data-cfgkey]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const hidden = grid.querySelector('input[data-boolhidden="' + cb.getAttribute('data-cfgkey') + '"]');
      if (hidden) hidden.value = cb.checked ? '1' : '0';
    });
  });
}
// ---- MQTT popup ----
async function openMqttEdit() {
  const grid = $('mqtt-grid');
  if (!grid || !state.config) return;
  await loadSslFiles();
  const getter = state.config;
  grid.classList.add('config-two-col');
  grid.innerHTML = MQTT_FIELDS.map((f) => renderConfigField(getter, f, 'mcfg-')).join('');
  bindConfigCheckboxes(grid);
  grid.querySelectorAll('.file-browse').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.getAttribute('data-for');
      const target = grid.querySelector('input[data-cfgkey="' + key + '"]');
      // Use the picked file from the ssl files list (the combobox datalist already lists them).
      // If a native file picker is available (input type=file overlay), we'd use it; here we
      // cycle through the known ssl files as the "file browser".
      if (!target || !stateSslFiles.length) return;
      const cur = (stateSslFiles || []).indexOf(target.value);
      const next = stateSslFiles[(cur + 1) % stateSslFiles.length];
      target.value = next || '';
    });
  });
  $('mqttedit-overlay').hidden = false;
  applyHelpIcons($('mqtt-grid'));
}
$('mqtt-status')?.addEventListener('click', openMqttEdit);
$('mqttedit-cancel')?.addEventListener('click', () => { $('mqttedit-overlay').hidden = true; });
$('mqttedit-save')?.addEventListener('click', async () => {
  const merged = JSON.parse(JSON.stringify(state.config || {}));
  const fieldMap = {
    mqttuser: 'mqttconnect.username',
    mqttpassword: 'mqttconnect.password',
    mqttserverurl: 'mqttconnect.mqttserverurl',
    mqttcafile: 'mqttcaFile', mqttcertfile: 'mqttcertFile', mqttkeyfile: 'mqttkeyFile'
  };
  document.querySelectorAll('#mqtt-grid [data-cfgkey]').forEach((inp) => {
    if (inp.type === 'checkbox') return;
    const k = inp.getAttribute('data-cfgkey');
    let v = inp.value.trim();
    if (fieldMap[k]) { configSet(merged, fieldMap[k], v === '' ? undefined : v); return; }
    if (v === '') v = undefined;
    configSet(merged, k, v);
  });
  try {
    await api('/api/configuration', { method: 'POST', body: JSON.stringify(merged) });
    toast(t('config_saved'), 'success');
    $('mqttedit-overlay').hidden = true;
    state.config = merged;
    renderGateway();
  } catch (e) {
    toast(t('err_save_config') + e.message, 'error');
  }
});
// ---- General config popup (MQTT removed — separate popup) ----
async function openConfigEdit() {
  const grid = $('config-grid');
  if (!grid || !state.config) return;
  const getter = state.config;
  grid.classList.add('config-two-col');
  grid.innerHTML = CONFIG_FIELDS.map((f) => renderConfigField(getter, f, 'cfg-')).join('');
  bindConfigCheckboxes(grid);
  $('configedit-overlay').hidden = false;
  applyHelpIcons();
}
// load ssl file list once at boot as well
loadSslFiles();
$('btn-top-config')?.addEventListener('click', openConfigEdit);
$('configedit-cancel')?.addEventListener('click', () => { $('configedit-overlay').hidden = true; });
$('configedit-save')?.addEventListener('click', async () => {
  const merged = JSON.parse(JSON.stringify(state.config || {}));
  document.querySelectorAll('#config-grid [data-cfgkey]').forEach((inp) => {
    if (inp.type === 'checkbox') return;
    const k = inp.getAttribute('data-cfgkey');
    let v = inp.value.trim();
    if (v === '') v = undefined;
    else if (v === 'true' || v === 'false') v = (v === 'true');
    else {
      const n = Number(v);
      if (v.trim() !== '' && !isNaN(n) && /^-?\d+(\.\d+)?$/.test(v.trim())) v = n;
    }
    configSet(merged, k, v);
  });
  try {
    await api('/api/configuration', { method: 'POST', body: JSON.stringify(merged) });
    toast(t('config_saved'), 'success');
    $('configedit-overlay').hidden = true;
    state.config = merged;
    renderGateway();
  } catch (e) {
    toast(t('err_save_config') + e.message, 'error');
  }
});
// Auto-open the MQTT popup if no MQTT server is configured yet (first load).
async function maybeAutoOpenMqtt() {
  await loadConfig();
  const cfg = state.config || {};
  const url = cfg.mqttconnect && cfg.mqttconnect.mqttserverurl ? cfg.mqttconnect.mqttserverurl : null;
  const hassio = state.auth && state.auth.mqttConfigured;
  if (!url && !hassio) openMqttEdit();
}

/* ---------------- help icons on all configurable settings ---------------- */
/* Adds a themed ⓘ per field: looks up "help_<fieldId>" (or help_<i18nKey>)
   in the lang tables. Call after each modal is opened/populated. */
function applyHelpIcons(root) {
  const scope = root || document;
  scope.querySelectorAll('.field').forEach((f) => {
    if (f.querySelector('.help-icon')) return; // already done
    const label = f.querySelector('label');
    if (!label) return;
    const input = f.querySelector('input[id], select[id], textarea[id]');
    let key = null;
    if (input) key = 'help_' + input.id;
    if (!key || !t(key) || t(key) === key) {
      // fall back to the label's data-i18n to find a "help_<key>" translation
      const i18n = label.getAttribute('data-i18n');
      if (i18n && t('help_' + i18n) && t('help_' + i18n) !== 'help_' + i18n) key = 'help_' + i18n;
    }
    if (!key || !t(key) || t(key) === key) return;
    const icon = document.createElement('span');
    icon.className = 'help-icon';
    icon.setAttribute('data-tip', t(key));
    icon.textContent = '\u24d8';
    label.appendChild(icon);
  });
}

/* ---------------- themed tooltip ---------------- */
(function () {
  let tipEl = null;
  function showTip(text, x, y) {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'ui-tooltip';
      document.body.appendChild(tipEl);
    }
    tipEl.textContent = text;
    tipEl.style.display = 'block';
    const rect = tipEl.getBoundingClientRect();
    let left = x + 12;
    if (left + rect.width > window.innerWidth - 8) left = x - rect.width - 12;
    let top = y + 14;
    if (top + rect.height > window.innerHeight - 8) top = y - rect.height - 10;
    tipEl.style.left = left + 'px';
    tipEl.style.top = top + 'px';
  }
  function hideTip() { if (tipEl) tipEl.style.display = 'none'; }
  document.addEventListener('mouseover', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
    if (el && el.getAttribute('data-tip') && el.getAttribute('data-tip') !== '—') {
      const r = el.getBoundingClientRect();
      showTip(el.getAttribute('data-tip'), r.left, r.bottom);
    }
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target && e.target.closest && e.target.closest('[data-tip]')) hideTip();
  });
})();

/* ---------------- theme ---------------- */
function currentTheme() { return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'; }
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('m2m-theme', theme); } catch (e) { /* ignore */ }
}
let themeExplicit = false;
try { themeExplicit = localStorage.getItem('m2m-theme') !== null; } catch (e) { /* ignore */ }
window.matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', (e) => {
  if (!themeExplicit) setTheme(e.matches ? 'light' : 'dark');
});
$('theme-toggle')?.addEventListener('click', () => {
  themeExplicit = true;
  setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
});


/* ---------------- custom select (language) ----------------
   The native <select> stays in the DOM (hidden) so existing code that
   reads/writes lang-select keeps working. The visible round trigger +
   dropdown mirror HA_enoceanmqtt: theme-aware, uppercase, checkmark on
   the selected language. */
function initCustomSelect(selectId) {
  const sel = $(selectId);
  if (!sel || sel.dataset.csInit === '1') return;
  sel.dataset.csInit = '1';

  const wrap = document.createElement('div');
  wrap.className = 'custom-select' + (selectId === 'lang-select' ? ' cs-lang-select' : ' cs-sender-select');
  sel.parentNode.insertBefore(wrap, sel);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'cs-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  wrap.appendChild(trigger);

  const list = document.createElement('ul');
  list.className = 'cs-list';
  list.setAttribute('role', 'listbox');
  wrap.appendChild(list);

  sel.classList.add('cs-native');
  sel.setAttribute('aria-hidden', 'true');
  sel.tabIndex = -1;

  const syncTrigger = () => {
    const o = sel.selectedOptions && sel.selectedOptions[0];
    trigger.textContent = (o ? o.textContent : sel.value) || '\u2014';
  };

  const rebuild = () => {
    const cur = sel.value;
    const opts = Array.from(sel.querySelectorAll('option'));
    list.innerHTML = opts.map((o) => {
      const label = o.textContent;
      const dis = o.disabled;
      const cls = dis ? ' disabled' : (o.value === cur || o.selected ? ' selected' : '');
      return '<li data-value="' + escapeHtml(o.value) + '" class="' + cls.trim() + '">' +
        '<span>' + escapeHtml(label) + '</span></li>';
    }).join('');
    syncTrigger();
  };
  const open = () => { syncTrigger(); list.hidden = false; };
  const close = () => { list.hidden = true; };
  syncTrigger();
  rebuild();
  close();

  const mo = new MutationObserver(() => rebuild());
  mo.observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected'] });
  sel.addEventListener('change', syncTrigger);

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (list.hidden) open(); else close();
  });
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); open();
      const first = list.querySelector('li:not(.disabled)');
      if (first) first.focus();
    } else if (e.key === 'Escape') {
      close(); trigger.focus();
    }
  });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li || li.classList.contains('disabled')) return;
    sel.value = li.dataset.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    rebuild();
    close();
    trigger.focus();
  });
  list.addEventListener('keydown', (e) => {
    const items = Array.from(list.querySelectorAll('li:not(.disabled)'));
    if (!items.length) return;
    const i = items.indexOf(e.target);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.target.click(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); trigger.focus(); }
  });
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) close();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !list.hidden) { e.preventDefault(); close(); trigger.focus(); }
  });
}

/* ---------------- init ---------------- */
(function () {
  try {
    const saved = localStorage.getItem('m2m-lang');
    currentLang = (saved === 'de' || saved === 'fr' || saved === 'it') ? saved : 'en';
    const sel = $('lang-select');
    if (sel) sel.value = currentLang;
  } catch (e) { /* ignore */ }
  initCustomSelect('lang-select');
  initTemplateCombo();
  applyTranslations();
  loadAll();
  maybeAutoOpenMqtt();
  setInterval(loadAll, 5000);
})();