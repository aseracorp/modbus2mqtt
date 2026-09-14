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
    const slaves = (bus.slaves || []).map((s) => `
      <div class="slave-row" data-busid="${bus.busId}" data-slaveid="${s.slaveid}">
        <span class="slave-name">${escapeHtml(getSlaveName(s))}</span>
        <span class="slave-tpl">${escapeHtml(getSlaveTemplateName(s.specificationid))}</span>
        <span class="slave-id">#${s.slaveid}</span>
        <span class="slave-actions">
          <button class="icon-btn slave-poll" title="${t('poll_now')}" data-busid="${bus.busId}" data-slaveid="${s.slaveid}">⚡</button>
          <button class="icon-btn slave-edit" title="${t('edit_device')}" data-busid="${bus.busId}" data-slaveid="${s.slaveid}">✎</button>
          <button class="icon-btn slave-del" title="${t('remove_device')}" data-busid="${bus.busId}" data-slaveid="${s.slaveid}">✕</button>
        </span>
      </div>`).join('');
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
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">' + t('no_templates') + '</td></tr>';
    return;
  }
  tbody.innerHTML = state.specs.map((s) => `
    <tr data-filename="${escapeHtml(s.filename)}">
      <td>${escapeHtml(s.model || s.filename)}</td>
      <td>${escapeHtml(s.model || '')}</td>
      <td>${escapeHtml(s.manufacturer || '')}</td>
      <td><span class="status-badge ${tplStatusClass(s.status)}">${escapeHtml(tplStatusText(s.status))}</span></td>
      <td><div class="row-actions">
        <button class="icon-btn tpl-edit" title="${t('edit_device')}" data-filename="${escapeHtml(s.filename)}">✎</button>
        <button class="icon-btn tpl-del" title="${t('remove_device')}" data-filename="${escapeHtml(s.filename)}">✕</button>
      </div></td>
    </tr>`).join('');
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
    if (cur) sel.value = cur;
  } catch (e) { /* ignore */ }
}

/* ---------------- add / edit connection ---------------- */
let editingBusId = null;

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
}
function updateBusTypeFields() {
  const isRtu = $('be-type').value === 'rtu';
  document.querySelectorAll('.be-tcp').forEach((el) => { el.hidden = isRtu; });
  document.querySelectorAll('.be-rtu').forEach((el) => { el.hidden = !isRtu; });
}
$('be-type')?.addEventListener('change', updateBusTypeFields);
$('busedit-cancel')?.addEventListener('click', () => { $('busedit-overlay').hidden = true; });
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
  if (cur) sel.value = cur;
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
  populateBusSelect();
  populateSlaveSelect();
  updatePollModeFields();
  $('slaveedit-overlay').hidden = false;
}
function openEditSlave(busid, slaveid) {
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
  updatePollModeFields();
  $('slaveedit-overlay').hidden = false;
}
function updatePollModeFields() {
  const pm = $('se-pollmode').value;
  $('se-pollinterval-f').hidden = !(pm === '0' || pm === '2' || pm === '4');
  $('se-reference-f').hidden = (pm === '4');
}
$('se-pollmode')?.addEventListener('change', updatePollModeFields);
$('slaveedit-cancel')?.addEventListener('click', () => { $('slaveedit-overlay').hidden = true; });
$('slaveedit-ok')?.addEventListener('click', async () => {
  const busid = Number($('se-busselect').value);
  if (!busid) return toast(t('err_no_bus'), 'error');
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
  body.pollMode = pollMode;
  if (pollInterval && !isNaN(pollInterval)) body.pollInterval = pollInterval;
  if (rootTopic) body.rootTopic = rootTopic;
  body.qos = qos;
  if (maxReg && !isNaN(maxReg)) body.maxRegistersPerRequest = maxReg;
  if (configUrl) body.configurationUrl = configUrl;
  if (!isNaN(referenceId) && referenceId > 0) body.referenceSlaveId = referenceId;

  try {
    await api('/api/slave?busid=' + busid, { method: 'POST', body: JSON.stringify(body) });
    toast(editingSlave ? t('device_updated') : t('device_added'), 'success');
    $('slaveedit-overlay').hidden = true;
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
function openAddTemplate() {
  editingTemplate = null;
  $('tpledit-title').textContent = t('add_template');
  $('te-filename').value = ''; $('te-model').value = ''; $('te-manufacturer').value = '';
  $('tpledit-overlay').hidden = false;
}
function openEditTemplate(filename) {
  const sp = (state.specs || []).find((s) => s.filename === filename);
  if (!sp) return;
  editingTemplate = filename;
  $('tpledit-title').textContent = t('edit_bus') + ' — ' + filename;
  $('te-filename').value = sp.filename.replace(/\.yaml$/, '');
  $('te-model').value = sp.model || '';
  $('te-manufacturer').value = sp.manufacturer || '';
  $('tpledit-overlay').hidden = false;
}
$('tpledit-cancel')?.addEventListener('click', () => { $('tpledit-overlay').hidden = true; });
$('tpledit-ok')?.addEventListener('click', async () => {
  const filename = $('te-filename').value.trim().replace(/\.yaml$/, '');
  const model = $('te-model').value.trim();
  const manufacturer = $('te-manufacturer').value.trim();
  if (!filename) return toast(t('err_no_name'), 'error');
  try {
    const spec = {
      filename: filename + '.yaml',
      model: model || undefined,
      manufacturer: manufacturer || undefined,
      files: [], entities: [], i18n: [],
      identified: 0,
      status: 3
    };
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
  'mqttcaFile', 'mqttkeyFile', 'mqttcertFile', 'githubPersonalToken', 'filelocation'
]);
const CONFIG_LABELS = {
  mqttbasetopic: 'MQTT base topic', mqttdiscoveryprefix: 'MQTT discovery prefix',
  mqttdiscoverylanguage: 'MQTT discovery language',
  mqttserverurl: 'MQTT server URL', username: 'MQTT username', password: 'MQTT password',
  clientId: 'MQTT client ID', connectTimeout: 'MQTT connect timeout (ms)', keepalive: 'MQTT keepalive (s)',
  ssl: 'MQTT SSL', clean: 'MQTT clean session', protocol: 'MQTT protocol',
  fakeModbus: 'Fake Modbus', debugComponents: 'Debug components', displayHex: 'Display hex',
  host: 'MQTT host', port: 'MQTT port'
};
function configLabel(key) {
  return CONFIG_LABELS[key] || key;
}
const CONFIG_BOOL = new Set(['fakeModbus', 'ssl', 'clean', 'mqttusehassio', 'displayHex']);
function isBoolConf(k, v) {
  if (CONFIG_BOOL.has(k)) return true;
  const sv = String(v == null ? '' : v).trim().toLowerCase();
  return ['0', '1', 'true', 'false', 'yes', 'no', 'on', 'off'].includes(sv) && /^(0|1|true|false|yes|no|on|off)$/i.test(sv);
}
function flattenConfig(conf, prefix) {
  const out = {};
  const walk = (obj, path) => {
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      Object.entries(obj).forEach(([k, v]) => {
        if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, path ? path + '.' + k : k);
        else out[path ? path + '.' + k : k] = v;
      });
    } else {
      out[path] = obj;
    }
  };
  walk(conf, prefix || '');
  return out;
}
function unflattenConfig(flat) {
  const out = {};
  Object.entries(flat).forEach(([k, v]) => {
    const parts = k.split('.');
    let cur = out;
    parts.forEach((p, i) => {
      if (i === parts.length - 1) { cur[p] = v; }
      else { cur[p] = cur[p] || {}; cur = cur[p]; }
    });
  });
  return out;
}
async function loadConfig() {
  try {
    state.config = await api('/api/configuration');
    renderGateway();
  } catch (e) {
    toast(t('err_load_config') + e.message, 'error');
  }
}
function openConfigEdit() {
  const grid = $('config-grid');
  if (!grid || !state.config) return;
  const flat = flattenConfig(state.config, '');
  const keys = Object.keys(flat).filter((k) => !CONFIG_HIDDEN.has(k));
  grid.classList.add('config-two-col');
  grid.innerHTML = keys.map((k) => {
    const label = configLabel(k);
    const raw = flat[k];
    if (isBoolConf(k, raw)) {
      const checked = ['1', 'true', 'yes', 'on'].includes(String(raw == null ? '' : raw).trim().toLowerCase());
      return '<div class="field config-bool"><label for="cfg-' + escapeHtml(k) + '">' + escapeHtml(label) + '</label>' +
        '<input type="checkbox" id="cfg-' + escapeHtml(k) + '" data-cfgkey="' + escapeHtml(k) + '"' + (checked ? ' checked' : '') + '>' +
        '<input type="hidden" data-cfgkey="' + escapeHtml(k) + '" data-boolhidden="' + escapeHtml(k) + '" value="' + (checked ? '1' : '0') + '"></div>';
    }
    return '<div class="field"><label for="cfg-' + escapeHtml(k) + '">' + escapeHtml(label) + '</label>' +
      '<input type="text" id="cfg-' + escapeHtml(k) + '" data-cfgkey="' + escapeHtml(k) + '" value="' + escapeHtml(String(raw)) + '"></div>';
  }).join('');
  grid.querySelectorAll('input[type=checkbox][data-cfgkey]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const hidden = grid.querySelector('input[data-boolhidden="' + cb.getAttribute('data-cfgkey') + '"]');
      if (hidden) hidden.value = cb.checked ? '1' : '0';
    });
  });
  $('configedit-overlay').hidden = false;
}
$('btn-top-config')?.addEventListener('click', openConfigEdit);
$('configedit-cancel')?.addEventListener('click', () => { $('configedit-overlay').hidden = true; });
function configPayloadFromGrid() {
  const flat = {};
  document.querySelectorAll('#config-grid [data-cfgkey]').forEach((inp) => {
    if (inp.type === 'checkbox') return; // handled by hidden sibling
    const k = inp.getAttribute('data-cfgkey');
    let v = inp.value;
    if (v === '') v = undefined;
    else if (v === 'true' || v === 'false') v = (v === 'true');
    else {
      const n = Number(v);
      if (v.trim() !== '' && !isNaN(n) && /^-?\d+(\.\d+)?$/.test(v.trim())) v = n;
    }
    flat[k] = v;
  });
  return unflattenConfig(flat);
}
$('configedit-save')?.addEventListener('click', async () => {
  const payload = configPayloadFromGrid();
  // merge the edited mqttconnect + top-level into the current config
  const merged = JSON.parse(JSON.stringify(state.config || {}));
  Object.assign(merged, payload);
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

/* ---------------- init ---------------- */
(function () {
  try {
    const saved = localStorage.getItem('m2m-lang');
    currentLang = (saved === 'de' || saved === 'fr' || saved === 'it') ? saved : 'en';
    const sel = $('lang-select');
    if (sel) sel.value = currentLang;
  } catch (e) { /* ignore */ }
  initTemplateCombo();
  applyTranslations();
  loadAll();
  setInterval(loadAll, 5000);
})();