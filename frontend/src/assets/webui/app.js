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
let lastRenderedLang = null;
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
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    if (key && t(key)) el.title = t(key);
  });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    const key = el.getAttribute('data-i18n-ph');
    if (key && t(key)) el.setAttribute('placeholder', t(key));
  });
  // Dynamic lists render spec-derived text (localized template names), so they
  // must be re-rendered on language change too — otherwise the template names
  // (and other dynamic i18n text) keep the previous language until a refresh.
  // (renderGateway is intentionally omitted: it would fire a (throttled) live
  // MQTT probe on every language switch for no benefit.)
  if (currentLang !== lastRenderedLang) {
    lastRenderedLang = currentLang;
    renderBusses?.();
    renderTemplates?.();
    populateSlaveSelect?.();
    populateTemplateList?.();
  }
}
$('lang-select')?.addEventListener('change', (e) => setLang(e.target.value));

/* ---------------- loading ---------------- */
async function loadAll() {
  try {
    const [busses, specs, auth, qosWarn] = await Promise.all([
      api('/api/busses'),
      api('/api/specifications'),
      api('/userAuthenticationStatus'),
      api('/api/qos/warnings').catch(() => ({}))
    ]);
    state.busses = busses || [];
    state.specs = specs || [];
    state.auth = auth || {};
    state.qosWarnings = qosWarn || {};
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
  return getSpecificationText(s, 'name') || s.model || filename;
}
function getSlaveTemplateManufacturer(filename) {
  const s = state.specs.find((sp) => sp.filename === filename);
  return s ? s.manufacturer : '';
}
// Localized template name from the spec i18n (falls back to en, then to model/filename).
// Mirrors the backend getSpecificationI18nText(): look up `textId` in the given
// (or current UI) language block first, then in the 'en' block.
function getSpecificationText(spec, textId, lang) {
  if (!spec || !spec.i18n) return null;
  const want = lang || currentLang;
  const langBlock = spec.i18n.find((b) => b.lang === want);
  if (langBlock) {
    const tx = langBlock.texts.find((t) => t.textId === textId);
    if (tx && tx.text) return tx.text;
  }
  if (want !== 'en') {
    const enBlock = spec.i18n.find((b) => b.lang === 'en');
    if (enBlock) {
      const tx = enBlock.texts.find((t) => t.textId === textId);
      if (tx && tx.text) return tx.text;
    }
  }
  return null;
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
// Language-aware datasheet resolution. A datasheet file may carry a `lang`
// (en/de/fr/it); pick the current UI language first, fall back to English,
// then to the first datasheet available.
function getTemplateDocUrl(filename, lang) {
  const files = getTemplateFiles(filename);
  const docs = files.filter((f) => f.usage === 'doc');
  if (!docs.length) return '';
  const want = lang || currentLang;
  let doc = docs.find((f) => f.lang === want);
  if (!doc) doc = docs.find((f) => f.lang === 'en');
  if (!doc) doc = docs.find((f) => !f.lang);
  if (!doc) doc = docs[0];
  return resolveFileUrl(doc);
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
      const warnKey = bus.busId + 's' + s.slaveid;
      const qosWarn = (state.qosWarnings || {})[warnKey];
      const warnBadge = qosWarn && qosWarn.length
        ? '<span class="qos-warn" title="' + escapeHtml(qosWarn.join('\n')) + '">⚠ QoS</span>'
        : '';
      return `
      <div class="slave-row" data-busid="${bus.busId}" data-slaveid="${s.slaveid}">
        ${imgCell}
        <span class="slave-name">${escapeHtml(getSlaveName(s))}${warnBadge}</span>
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
            ${(bus.connectionData && bus.connectionData.serialport)
              ? '<button class="icon-btn bus-sniffer ' + snifferEyeClass(bus.busId) + '" title="' + snifferEyeTitle(bus.busId) + '" data-busid="' + bus.busId + '">👁</button>'
              : ''}
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
  list.querySelectorAll('.bus-sniffer').forEach((b) => {
    b.addEventListener('click', (e) => { e.stopPropagation(); openSniffer(b.getAttribute('data-busid')); });
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
    const tplName = getSpecificationText(s, 'name') || s.model || s.filename;
    return `
    <tr data-filename="${escapeHtml(s.filename)}">
      ${imgCell}
      <td>${escapeHtml(tplName)}</td>
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
  editingSlaveBus = busid; editingSlaveId = null;
  editingSlave = null;
  $('slaveedit-title').textContent = t('add_slave_title');
  $('se-busselect').value = busid != null ? String(busid) : (state.busses.length ? String(state.busses[0].busId) : '');
  $('se-slaveid').value = '';
  $('se-name').value = '';
  $('se-template-search').value = '';
  $('se-template-drop').hidden = true;
  $('se-pollmode').value = '0';
  $('se-pollinterval').value = '1000';
  $('se-httppush').value = '';
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
// Overlay the live values read from the device onto slaveSpec, so the register
// table shows the current modbus values instead of '—'. /api/modbus/specification
// returns the spec with mqttValue populated for the registers actually present.
function refreshSlaveValues(busid, slaveid, specid) {
  return new Promise((resolve) => {
    api('/api/modbus/specification?busid=' + busid + '&slaveid=' + slaveid + '&spec=' + encodeURIComponent(specid))
      .then((live) => {
        if (live && Array.isArray(live.entities) && slaveSpec && Array.isArray(slaveSpec.entities)) {
          live.entities.forEach((le) => {
            const tgt = slaveSpec.entities.find((e) => e.id === le.id);
            if (tgt) {
              if (le.mqttValue !== undefined) tgt.mqttValue = le.mqttValue;
              if (le.modbusValue !== undefined) tgt.modbusValue = le.modbusValue;
              if (le.identified !== undefined) tgt.identified = le.identified;
            }
          });
        }
        resolve();
      })
      .catch(() => resolve());
  });
}
async function openEditSlave(busid, slaveid) {
  editingSlaveBus = busid; editingSlaveId = slaveid;
  const bus = (state.busses || []).find((b) => b.busId === Number(busid));
  if (!bus) return;
  const slave = bus.slaves.find((s) => s.slaveid === Number(slaveid));
  if (!slave) return;
  editingSlave = { busid: Number(busid), slaveid: Number(slaveid) };
  slaveSpecDirty = false;
  $('slaveedit-title').textContent = t('edit_slave_title');
  $('se-busselect').value = String(bus.busId);
  $('se-slaveid').value = String(slave.slaveid);
  $('se-name').value = slave.name || '';
  $('se-template-search').value = getSlaveTemplateName(slave.specificationid);
  $('se-template-drop').hidden = true;
  const pollMode = slave.pollMode != null ? slave.pollMode : 0;
  $('se-pollmode').value = String(pollMode === 4 ? 4 : (pollMode === 5 ? 5 : (pollMode === 2 ? 2 : (pollMode === 1 ? 1 : (pollMode === 3 ? 3 : 0)))));
  $('se-pollinterval').value = slave.pollInterval != null ? String(slave.pollInterval) : (slave.pollSchedule ? '' : '1000');
  $('se-httppush').value = (slave.httpPush && slave.httpPush.url) || '';
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
  // Overlay the live values read from the device, so the register table shows
  // the current modbus values instead of '—'.
  activeSpec = slaveSpec;
  await refreshSlaveValues(busid, slaveid, slave.specificationid || slaveSpec.filename || '');
  renderDeviceRegisters();
  updatePollModeFields();
  $('slaveedit-overlay').hidden = false;
  applyHelpIcons();
}
function updatePollModeFields() {
  const pm = $('se-pollmode').value;
  // Interval is the base polling cycle in interval/interval+trigger/http-push modes
  // and the "regular" QoS cycle in dynamic polling mode.
  $('se-pollinterval-f').hidden = !(pm === '0' || pm === '2' || pm === '4' || pm === '5');
  $('se-httppush-f').hidden = (pm !== '4');
  $('se-reference-f').hidden = (pm === '4');
}
$('se-pollmode')?.addEventListener('change', updatePollModeFields);
$('se-reg-add')?.addEventListener('click', () => {
  activeSpec = slaveSpec;
  openRegEdit(null);
});
// Slave-ID scan: poll the selected bus for responsive slave ids and offer them as a dropdown.
$('se-scan-slaves')?.addEventListener('click', async () => {
  const busid = parseInt($('se-busselect')?.value, 10);
  if (isNaN(busid)) return toast(t('err_no_bus'), 'error');
  const btn = $('se-scan-slaves');
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '…';
  try {
    const rc = await api('/api/modbus/scan-slaves?busid=' + busid);
    const ids = (rc && rc.slaveIds) || [];
    const dl = $('se-slave-scan-list');
    dl.innerHTML = ids.map((id) => '<option value="' + id + '"></option>').join('');
    if (ids.length) {
      $('se-slaveid').value = String(ids[0]);
      toast(t('scan_slaves_found') + ids.join(', '), 'success');
    } else {
      toast(t('scan_slaves_none'), 'warn');
    }
  } catch (e) {
    toast(t('err_scan_slaves') + (e && e.message ? e.message : ''), 'error');
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
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
  // If the device is based on a template but its registers were edited, clone the
  // template into a per-device spec and switch the device to it, so the device's
  // changes are persisted and the public template stays untouched.
  const deviceSpecDirty = slaveSpecDirty && template && inlineEnts.length > 0;
  if ((!template && inlineEnts.length) || deviceSpecDirty) {
    if (deviceSpecDirty) {
      // Build a stable, distinguishable per-device clone name:
      //   <source-template>-<busid>-<slaveid>.yaml
      // A device that was already switched to its clone (earlier save) keeps
      // that clone name — but only when it really is a per-device clone
      // (<source>-<bus>-<slave>), never the bare template name: creating a new
      // device from a *cloned* template must still produce its own clone name
      // instead of silently sharing the source template's filename.
      const tplBase = (template.filename || '').replace(/\.yaml$/, '')
      const curBase = (slaveSpec.filename || '').replace(/\.yaml$/, '')
      const cloneSuffix = '-' + busid + '-' + slaveid
      // Already a per-device clone of this very template (either selected as the
      // template, or the device was switched to it earlier and the selected
      // template fell back to the published original): keep the clone name,
      // never append the suffix a second time.
      const isPerDeviceClone =
        curBase === tplBase + cloneSuffix ||
        (curBase === tplBase && tplBase.endsWith(cloneSuffix))
      if (!isPerDeviceClone) {
        slaveSpec.filename = (tplBase || 'slave-' + busid + '-' + slaveid) + cloneSuffix + '.yaml'
      }
    } else {
      slaveSpec.filename = slaveSpec.filename || ('slave-' + busid + '-' + slaveid);
    }
    slaveSpec.entities = inlineEnts;
    slaveSpec.i18n = slaveSpec.i18n || [];
    slaveSpec.files = slaveSpec.files || [];
    slaveSpec.identified = slaveSpec.identified == null ? 0 : slaveSpec.identified;
    slaveSpec.status = slaveSpec.status == null ? 3 : slaveSpec.status;
    body.specificationid = slaveSpec.filename.replace(/\.yaml$/, '');
    // Give the per-device clone a display name distinct from the source
    // template: the Templates table, the template dropdown and the device card
    // all show the spec's `model`, so a clone must not look identical to the
    // original (the bare filename is not shown anywhere prominent). On re-save
    // the loaded clone already carries the suffix — keep it (never double it).
    if (deviceSpecDirty) {
      const devSuffix = ' (Device ' + busid + '-' + slaveid + ')'
      // The base is the template model without any per-device suffix: when the
      // selected template IS an existing clone (re-save), its model already
      // carries " (Device x-y)" and must not be appended again.
      const baseModel = (template.model || template.filename || 'template')
        .replace(/\.yaml$/, '')
        .replace(/\s*\(Device \d+-\d+\)$/, '')
      // Rename only when the model is still the template's plain model (fresh
      // clone, or the resolved template fell back to the original) or empty —
      // never clobber a custom model the user set on a clone.
      const needsDistinctName =
        !slaveSpec.model || slaveSpec.model === baseModel || slaveSpec.model === baseModel + devSuffix
      if (needsDistinctName) slaveSpec.model = baseModel + devSuffix
    }
  }
  body.pollMode = pollMode;
  if (pollInterval && !isNaN(pollInterval)) body.pollInterval = pollInterval;
  if (rootTopic) body.rootTopic = rootTopic;
  const httpPushUrl = $('se-httppush').value.trim();
  if (httpPushUrl) body.httpPush = { url: httpPushUrl };
  else {
    // The "keep PAT" branch needs the slave currently being edited; it is not
    // a local here (openEditSlave has its own), so resolve it from state.
    const curSlave = ((state.busses || []).find((b) => b.busId === Number(editingSlaveBus))?.slaves || [])
      .find((s) => s.slaveid === Number(editingSlaveId))
    if (curSlave && curSlave.httpPush) body.httpPush = { url: '', hasPat: !!curSlave.httpPush.patEnc }; // clear url, keep PAT
  }
  body.qos = qos;
  if (maxReg && !isNaN(maxReg)) body.maxRegistersPerRequest = maxReg;
  if (configUrl) body.configurationUrl = configUrl;
  if (!isNaN(referenceId) && referenceId > 0) body.referenceSlaveId = referenceId;

  try {
    await api('/api/slave?busid=' + busid, { method: 'POST', body: JSON.stringify(body) });
    // Save the device-scoped spec (registers added without a template, or a
    // template that was cloned because its registers were edited).
    if ((!template || deviceSpecDirty) && inlineEnts.length && slaveSpec.filename) {
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
  // Don't clobber an open dropdown while the user is interacting with it:
  // loadAll() re-runs every 30s and would rebuild the list, losing the filter
  // and scroll position (observed as "dropdown resets after a few seconds").
  const drop = $('se-template-drop');
  const input = $('se-template-search');
  if (drop && !drop.hidden && input && document.activeElement === input) return;
  _tplSearchList = state.specs || [];
  ul.innerHTML = _tplSearchList.map((sp) => {
    const tplName = getSpecificationText(sp, 'name') || sp.model || sp.filename;
    return '<li data-tpl="' + escapeHtml(sp.filename) + '" data-model="' + escapeHtml(sp.model || '') + '" data-manufacturer="' + escapeHtml(sp.manufacturer || '') + '">' +
      '<span class="eep-code">' + escapeHtml(sp.filename) + '</span>' +
      '<span class="eep-name">' + escapeHtml(tplName) + (sp.manufacturer ? ' · ' + escapeHtml(sp.manufacturer) : '') + '</span></li>';
  }).join('');
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
  // Sync the filter from the input value on focus: opening the dropdown on an
  // already-prefilled field (editing an existing device) must show only the
  // matching templates instead of the full unfiltered list.
  input.addEventListener('focus', () => { filter = input.value; render(); drop.hidden = false; });
  input.addEventListener('input', () => { filter = input.value; render(); drop.hidden = false; });
  input.addEventListener('blur', () => setTimeout(() => { drop.hidden = true; }, 150));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); const c = list.querySelector('li:not([hidden])'); if (c) c.focus(); }
    else if (e.key === 'Escape') drop.hidden = true;
  });
  // Select with mousedown: it fires before the input's blur, so the click is
  // never swallowed by the blur-hide timeout.
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-tpl]');
    if (!li) return;
    e.preventDefault();
    input.value = li.getAttribute('data-model') || li.getAttribute('data-tpl');
    drop.hidden = true;
  });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-tpl]');
    if (!li) return;
    input.value = li.getAttribute('data-model') || li.getAttribute('data-tpl');
    drop.hidden = true;
    filter = input.value;
  });
  list.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const li = e.target.closest('li[data-tpl]'); if (li) li.click(); }
  });
}
function resolveTemplate(value) {
  const v = (value || '').trim().toLowerCase();
  if (!v) return null;
  const matches = (state.specs || []).filter((sp) => {
    if (sp.filename.toLowerCase() === v) return true;
    if (sp.filename.toLowerCase() === (v.endsWith('.yaml') ? v : v + '.yaml')) return true;
    if (sp.model && sp.model.toLowerCase() === v) return true;
    if (sp.manufacturer && sp.manufacturer.toLowerCase() === v) return true;
    // The template input is pre-filled with the localized display name when
    // editing an existing device (getSlaveTemplateName), so a name like
    // "Water Level Sensor" must resolve back to the spec even when it differs
    // from model/filename.
    const display = getSpecificationText(sp, 'name');
    if (display && display.toLowerCase() === v) return true;
    return false;
  });
  if (!matches.length) return null;
  // Prefer the local (cloned/added) spec over the published one when both share
  // the same model: a device that was switched to its per-device clone must
  // resolve to that clone, so re-saving keeps the clone instead of re-cloning.
  return matches.find((sp) => sp.status === 1 || sp.status === 2) || matches[0];
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
// original filename/name the edit popup opened with (used to detect a real
// user rename, so saving an untouched popup never renames the YAML file)
let editingTemplateOriginalFilename = null;
let editingTemplateOriginalName = null;
// working copy of the template being added/edited (full ImodbusSpecification)
let templateSpec = null;
let slaveSpec = null;
let slaveSpecDirty = false;
let editingSlaveBus = null, editingSlaveId = null;
// spec that the register editor currently edits (templateSpec or slaveSpec)
let activeSpec = null;

function emptyTemplateSpec() {
  return { filename: '', model: undefined, manufacturer: undefined, files: [], entities: [], i18n: [], identified: 0, status: 3, nextEntityId: 1 };
}

async function openAddTemplate() {
  editingTemplate = null;
  editingTemplateOriginalFilename = null;
  editingTemplateOriginalName = null;
  templateSpec = emptyTemplateSpec();
  // The template editor owns the register context; drop any stale device
  // activeSpec left over from a previously closed slave popup.
  activeSpec = null;
  $('tpledit-title').textContent = t('add_template');
  // Reset the popup language and use it for the shown fields.
  templatePopupLang = 'en';
  const tplSel = $('te-lang-select');
  if (tplSel) tplSel.value = templatePopupLang;
  $('te-name').value = ''; $('te-model').value = ''; $('te-manufacturer').value = '';
  seedTemplateMedia(null);
  renderTemplateRegisters();
  $('tpledit-overlay').hidden = false;
  applyHelpIcons();
}
async function openEditTemplate(filename) {
  const sp = (state.specs || []).find((s) => s.filename === filename);
  if (!sp) return;
  editingTemplate = filename;
  // The template editor owns the register context; drop any stale device
  // activeSpec left over from a previously closed slave popup.
  activeSpec = null;
  // Remember what the popup was opened with so the save handler can tell a
  // real name edit from an untouched prefilled field (and avoid renaming the
  // file just because the popup was opened and OK'd).
  editingTemplateOriginalFilename = filename;
  editingTemplateOriginalName = getSpecificationText(sp, 'name') || sp.model || filename.replace(/\.yaml$/, '');
  $('tpledit-title').textContent = t('edit_template') + ' — ' + editingTemplateOriginalName;
  // Popup language starts at en so editing a template always shows the
  // canonical English name first; the popup selector then switches views.
  templatePopupLang = 'en';
  const tplSel = $('te-lang-select');
  if (tplSel) tplSel.value = templatePopupLang;
  $('te-name').value = getSpecTextRaw(sp, 'en', 'name') || sp.model || filename.replace(/\.yaml$/, '');
  $('te-model').value = sp.model || '';
  $('te-manufacturer').value = sp.manufacturer || '';
  try {
    const full = await api('/api/specification?spec=' + encodeURIComponent(sp.filename) + '&filedata=true');
    templateSpec = full || emptyTemplateSpec();
    templateSpec.filename = sp.filename;
  } catch (e) {
    templateSpec = emptyTemplateSpec();
    templateSpec.filename = sp.filename;
  }
  seedTemplateMedia(templateSpec);
  renderTemplateRegisters();
  $('tpledit-overlay').hidden = false;
  applyHelpIcons();
}
// Persist the name currently shown in the popup back into the spec's i18n
// block for the active popup language, then switch the popup to another
// language. All languages stay in templateSpec.i18n and are saved together.
function switchTemplatePopupLang(lang) {
  if (!templateSpec) return;
  const nameEl = $('te-name');
  if (nameEl) setSpecText(templateSpec, templatePopupLang, 'name', nameEl.value);
  templatePopupLang = (lang === 'de' || lang === 'fr' || lang === 'it' || lang === 'en') ? lang : 'en';
  const sel = $('te-lang-select');
  if (sel) sel.value = templatePopupLang;
  // Reload the shown name from the newly selected language block (fall back
  // to the model / original name when that language has no translation yet).
  const spec0 = templateSpec || emptyTemplateSpec();
  const raw = getSpecTextRaw(spec0, templatePopupLang, 'name');
  const fallback = editingTemplateOriginalName || spec0.model || (spec0.filename || '').replace(/\.yaml$/, '');
  if (nameEl) nameEl.value = raw || fallback;
  // Register names follow the popup language, so re-render the table.
  renderTemplateRegisters();
}
$('te-lang-select')?.addEventListener('change', (e) => switchTemplatePopupLang(e.target.value));
$('tpledit-cancel')?.addEventListener('click', () => { $('tpledit-overlay').hidden = true; templateSpec = null; resetTemplateMedia(); });
$('te-reg-add')?.addEventListener('click', () => openRegEdit(null));

/* ---- template media listeners ---- */
// image: URL typed manually
$('te-img-url')?.addEventListener('input', () => {
  const v = $('te-img-url').value.trim();
  if (v) {
    tplMedia.image = { url: v, data: '', mimeType: '' };
  } else if (tplMedia.image && !tplMedia.image.data) {
    tplMedia.image = null;
  }
  renderTemplateMedia();
});
// image: upload
$('te-img-file')?.addEventListener('change', () => {
  const f = $('te-img-file').files && $('te-img-file').files[0];
  if (!f) return;
  readFileAsBase64(f).then((r) => {
    tplMedia.image = { url: r.name, data: r.data, mimeType: r.mimeType };
    toast(t('tpl_file_staged') + ' ' + f.name, 'info');
    renderTemplateMedia();
  });
});
// image: clear
document.querySelector('.tpl-img-clear')?.addEventListener('click', () => {
  const had = tplMedia.image;
  resetTemplateMedia();
  if (had) toast(t('tpl_image_removed'), 'info');
});
function renderTemplateRegisters() {
  const tbody = $('te-reg-body');
  const ents = sortRegisters((templateSpec && templateSpec.entities) || []);
  if (!ents.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="8">' + t('reg_none') + '</td></tr>';
    return;
  }
  // The template shows every register (no values loaded); there is no Value column
  // because a template does not hold any live values.
  tbody.innerHTML = ents.map((en) => {
    const eid = en.id != null ? en.id : ('x' + specIndexOf(templateSpec, en))
    const cp = en.converterParameters || {};
    const isNum = converterName(en) === 'number';
    const rw = en.readonly ? 'R' : 'R/W';
    const cat = en.category === 'config' ? 'config' : (en.entityCategory === 'diagnostic' ? 'diagnostic' : 'value');
    const cond = entityCondMark(en);
    return '<tr data-eid="' + eid + '">' +
      '<td>' + escapeHtml(regName(en)) + ' ' + cond + '</td>' +
      '<td>' + escapeHtml(regTypeName(en.registerType)) + '</td>' +
      '<td>' + escapeHtml(String(en.modbusAddress == null ? '' : en.modbusAddress)) + '</td>' +
      '<td>' + escapeHtml(rw) + '</td>' +
      '<td>' + escapeHtml(converterName(en)) + '</td>' +
      '<td>' + escapeHtml(isNum ? (cp.uom || '') : '') + '</td>' +
      '<td class="cfg-badge ' + cat + '">' + cat + '</td>' +
      '<td class="qos-cell"><span class="qos-tag ' + qosClass(en) + '" title="' + escapeHtml(qosTip(en)) + '">' + escapeHtml(qosName(en)) + '</span></td>' +
      '<td><div class="row-actions">' +
        '<button class="icon-btn reg-edit" data-eid="' + eid + '" title="' + t('edit_device') + '">⚙</button>' +
        '<button class="icon-btn reg-del" data-eid="' + eid + '" title="' + t('remove_device') + '">✕</button>' +
      '</div></td></tr>';
  }).join('');
  tbody.querySelectorAll('.reg-edit').forEach((b) => b.addEventListener('click', () => { const en = entityByEid(templateSpec, b.getAttribute('data-eid')); if (en) { activeSpec = templateSpec; openRegEditForEntity(en); } }));
  tbody.querySelectorAll('.reg-del').forEach((b) => {
    b.addEventListener('click', () => {
      const en = entityByEid(templateSpec, b.getAttribute('data-eid'));
      if (!en) return;
      templateSpec.entities = (templateSpec.entities || []).filter((x) => x !== en);
      renderTemplateRegisters();
    });
  });
}
/* ---------------- template media (image + datasheets) ---------------- */
// Editable media state for the template popup. We work on a copy that is
// written back into templateSpec.files on save, so cancelled edits never leak.
const TEMPLATE_LANGS = ['en', 'de', 'fr', 'it'];
let tplMedia = { image: null, docs: {} }; // image: {url,data,mimeType} | null; docs: {lang: {url,data,mimeType}|null}

function resetTemplateMedia() {
  tplMedia = { image: null, docs: {} };
  TEMPLATE_LANGS.forEach((l) => { tplMedia.docs[l] = null; });
  const urlEl = $('te-img-url');
  if (urlEl) urlEl.value = '';
  const preview = $('te-img-preview');
  if (preview) preview.innerHTML = '';
  const fileEl = $('te-img-file');
  if (fileEl) fileEl.value = '';
}
// Seed the editable media state from an existing spec's files array.
function seedTemplateMedia(spec) {
  resetTemplateMedia();
  const files = (spec && spec.files) || [];
  files.forEach((f) => {
    if (!f || !f.url) return;
    if (f.usage === 'img' || f.usage === 'icon') {
      tplMedia.image = { url: f.url, data: f.data || '', mimeType: f.mimeType || '' };
    } else if (f.usage === 'doc') {
      const lang = TEMPLATE_LANGS.includes(f.lang) ? f.lang : (f.lang || 'en');
      tplMedia.docs[lang] = { url: f.url, data: f.data || '', mimeType: f.mimeType || '' };
    }
  });
  renderTemplateMedia();
}
function renderTemplateMedia() {
  // image preview
  const preview = $('te-img-preview');
  const urlEl = $('te-img-url');
  if (urlEl) urlEl.value = tplMedia.image ? tplMedia.image.url : '';
  if (preview) {
    if (tplMedia.image && tplMedia.image.url) {
      const src = tplMedia.image.data ? 'data:' + (tplMedia.image.mimeType || 'image/png') + ';base64,' + tplMedia.image.data
        : tplMedia.image.url;
      preview.innerHTML = '<img src="' + escapeHtml(src) + '" alt="" class="tpl-img-thumb">';
    } else {
      preview.innerHTML = '';
    }
  }
  // per-language datasheet rows
  const rows = $('te-doc-rows');
  if (rows) {
    rows.innerHTML = TEMPLATE_LANGS.map((lang) => {
      const v = tplMedia.docs[lang];
      const val = v ? v.url : '';
      return '<div class="tpl-doc-row" data-lang="' + lang + '">' +
        '<span class="tpl-doc-lang">' + escapeHtml(lang) + '</span>' +
        '<input type="text" class="tpl-doc-url" data-lang="' + lang + '" value="' + escapeHtml(val) + '" data-ph="tpl_doc_url_ph" placeholder="https://…/datasheet.pdf" autocomplete="off">' +
        '<input type="file" class="tpl-doc-file" data-lang="' + lang + '" accept=".pdf,.doc,.docx,application/pdf" style="display:none">' +
        '<button type="button" class="btn btn-sm tpl-doc-upload" data-lang="' + lang + '" data-i18n="tpl_upload">Upload</button>' +
        '<button type="button" class="btn btn-sm tpl-doc-clear" data-lang="' + lang + '" data-i18n="tpl_remove">Remove</button>' +
      '</div>';
    }).join('');
    rows.querySelectorAll('.tpl-doc-url').forEach((inp) => {
      inp.addEventListener('input', () => {
        const lang = inp.getAttribute('data-lang');
        const v = inp.value.trim();
        tplMedia.docs[lang] = v
          ? { url: v, data: '', mimeType: '' }
          : null;
      });
    });
    rows.querySelectorAll('.tpl-doc-upload').forEach((btn) => {
      btn.addEventListener('click', () => {
        const lang = btn.getAttribute('data-lang');
        const fileEl = rows.querySelector('.tpl-doc-file[data-lang="' + lang + '"]');
        if (fileEl) fileEl.click();
      });
    });
    rows.querySelectorAll('.tpl-doc-file').forEach((fileEl) => {
      fileEl.addEventListener('change', () => {
        const lang = fileEl.getAttribute('data-lang');
        const f = fileEl.files && fileEl.files[0];
        if (!f) return;
        readFileAsBase64(f).then((r) => {
          tplMedia.docs[lang] = { url: r.name, data: r.data, mimeType: r.mimeType };
          // keep the row in sync: show the local filename as placeholder while data is staged
          const urlInp = rows.querySelector('.tpl-doc-url[data-lang="' + lang + '"]');
          if (urlInp) urlInp.value = '';
          toast(t('tpl_file_staged') + ' ' + f.name, 'info');
        });
      });
    });
    rows.querySelectorAll('.tpl-doc-clear').forEach((btn) => {
      btn.addEventListener('click', () => {
        const lang = btn.getAttribute('data-lang');
        tplMedia.docs[lang] = null;
        const urlInp = rows.querySelector('.tpl-doc-url[data-lang="' + lang + '"]');
        if (urlInp) urlInp.value = '';
        const fileEl = rows.querySelector('.tpl-doc-file[data-lang="' + lang + '"]');
        if (fileEl) fileEl.value = '';
      });
    });
  }
  applyHelpIcons();
}
// Read a File into { name, data(base64 payload), mimeType }. The data is the
// raw base64 (without the data: prefix) so the backend can store it directly.
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve({
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        data: comma >= 0 ? result.substring(comma + 1) : result,
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
function renderActiveRegisters() {
  if (activeSpec === slaveSpec) renderDeviceRegisters();
  else renderTemplateRegisters();
}
function renderDeviceRegisters() {
  const tbody = $('se-reg-body');
  if (!tbody) return;
  const all = sortRegisters((slaveSpec && slaveSpec.entities) || []);
  // In the device view, hide registers the device does not actually have:
  // conditional entities whose conditions are not met (mqttValue empty / not
  // identified) are still in the spec but are not present on the device.
  // Config registers are kept. Handles both `condition` and `conditions`.
  const ents = all.filter((en) => {
    const hasCond = (en.conditions && en.conditions.length > 0) || en.condition
    if (!hasCond) return true
    // Inactive conditional entity (backend reports mqttValue '' and/or notIdentified)
    if (en.mqttValue === '' || en.mqttValue === undefined || en.mqttValue === null) return false
    return true
  })
  if (!ents.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="9">' + t('reg_none') + '</td></tr>';
    return;
  }
  tbody.innerHTML = ents.map((en) => {
    const eid = en.id != null ? en.id : ('x' + (specIndexOf(slaveSpec, en)))
    const cp = en.converterParameters || {};
    const isNum = converterName(en) === 'number';
    const rw = en.readonly ? 'R' : 'R/W';
    const cat = en.category === 'config' ? 'config' : (en.entityCategory === 'diagnostic' ? 'diagnostic' : 'value');
    const cond = entityCondMark(en);
    const shown = en.mqttValue != null ? en.mqttValue : '—';
    const writeBtn = en.readonly ? '' :
      '<button class="icon-btn reg-write" data-eid="' + eid + '" title="' + t('reg_write') + '">✎</button>';
    return '<tr data-eid="' + eid + '">' +
      '<td>' + escapeHtml(regName(en)) + ' ' + cond + '</td>' +
      '<td>' + escapeHtml(regTypeName(en.registerType)) + '</td>' +
      '<td>' + escapeHtml(String(en.modbusAddress == null ? '' : en.modbusAddress)) + '</td>' +
      '<td>' + escapeHtml(rw) + '</td>' +
      '<td>' + escapeHtml(converterName(en)) + '</td>' +
      '<td>' + escapeHtml(isNum ? (cp.uom || '') : '') + '</td>' +
      '<td class="cfg-badge ' + cat + '">' + cat + '</td>' +
      '<td class="qos-cell"><span class="qos-tag ' + qosClass(en) + '" title="' + escapeHtml(qosTip(en)) + '">' + escapeHtml(qosName(en)) + '</span></td>' +
      '<td class="reg-value-cell"><span class="reg-value" data-tip="' + escapeHtml(valueTooltip(en)) + '">' + escapeHtml(shown) + '</span>' + writeBtn + '</td>' +
      '<td><div class="row-actions">' +
        '<button class="icon-btn reg-edit" data-eid="' + eid + '" title="' + t('edit_device') + '">⚙</button>' +
        '<button class="icon-btn reg-del" data-eid="' + eid + '" title="' + t('remove_device') + '">✕</button>' +
      '</div></td></tr>';
  }).join('');
  tbody.querySelectorAll('.reg-edit').forEach((b) => b.addEventListener('click', () => { const en = entityByEid(slaveSpec, b.getAttribute('data-eid')); if (en) { activeSpec = slaveSpec; openRegEditForEntity(en); } }));
  tbody.querySelectorAll('.reg-del').forEach((b) => {
    b.addEventListener('click', () => {
      const en = entityByEid(slaveSpec, b.getAttribute('data-eid'));
      if (!en) return;
      slaveSpec.entities = (slaveSpec.entities || []).filter((x) => x !== en);
      // Deleting a register is a spec edit as well: when the device is based on
      // a template this must trigger the clone-template-on-save, otherwise the
      // removed register reappears on the next edit (the template is untouched).
      slaveSpecDirty = true;
      renderDeviceRegisters();
    });
  });
}

// Render a register's condition marker(s). Supports a legacy single `condition`
// and the newer `conditions` array (all must be met); multiple conditions are
// shown with a count.
// Read a raw translated text from a spec i18n block (no UI-language fallback).
function getSpecTextRaw(spec, lang, textId) {
  if (!spec || !Array.isArray(spec.i18n)) return null;
  const block = spec.i18n.find((b) => b.lang === lang);
  if (!block || !Array.isArray(block.texts)) return null;
  const tx = block.texts.find((t) => t.textId === textId);
  return (tx && tx.text) ? tx.text : null;
}

// The template popup owns a language selector that is independent of the
// global UI language: it controls which language's names are shown/edited in
// the popup, while the UI stays in the global language.
let templatePopupLang = 'en';

// Mirror the backend setSpecificationI18nText(): set (or delete when text is
// null/empty) a translated text for `textId` in the given language block.
function setSpecText(spec, lang, textId, text) {
  if (!spec || !Array.isArray(spec.i18n)) spec.i18n = [];
  let block = spec.i18n.find((b) => b.lang === lang);
  if (!block) {
    block = { lang: lang, texts: [] };
    spec.i18n.push(block);
  }
  if (!Array.isArray(block.texts)) block.texts = [];
  const idx = block.texts.findIndex((t) => t.textId === textId);
  if (idx >= 0) {
    if (text && text.trim() !== '') block.texts[idx].text = text.trim();
    else block.texts.splice(idx, 1);
  } else if (text && text.trim() !== '') {
    block.texts.push({ textId: textId, text: text.trim() });
  }
}

// Resolve a register's display name: prefer the spec's i18n name for the current
// language (template translations), fall back to the English/`name` field.
function regName(en) {
  if (en && en.id != null) {
    const specForI18n = (activeSpec !== null && activeSpec === slaveSpec) ? slaveSpec : templateSpec
    if (specForI18n && Array.isArray(specForI18n.i18n)) {
      // While the template popup is open, show the popup's own language
      // instead of the global UI language; the device popup and the closed
      // popup keep the global language.
      const tplOpen = !!templateSpec && $('tpledit-overlay') && !$('tpledit-overlay').hidden
      const want = tplOpen ? templatePopupLang : currentLang
      const langEntry = specForI18n.i18n.find((i) => i.lang === want) || specForI18n.i18n.find((i) => i.lang === 'en')
      if (langEntry && Array.isArray(langEntry.texts)) {
        const hit = langEntry.texts.find((tx) => tx.textId === 'e' + en.id)
        if (hit && hit.text) return hit.text
      }
    }
  }
  return (en && en.name) || ''
}
function entityCondMark(en) {
  const conds = (en.conditions && en.conditions.length > 0) ? en.conditions : (en.condition ? [en.condition] : [])
  if (conds.length === 0) return ''
  const parts = conds.map((c) => String(c.register) + (c.bit != null ? '.' + c.bit : '') + (c.mask != null ? '&0x' + c.mask.toString(16) : '') + (c.values != null ? ' in ' + c.values.join('/') : (c.comparator && c.comparator !== 'eq' ? ' ' + c.comparator + ' ' + c.value : '')))
  const title = t('reg_cond') + ': ' + parts.join(' AND ')
  return '<span class="reg-cond-mark" title="' + escapeHtml(title) + '">⚑' + (conds.length > 1 ? conds.length : '') + '</span>'
}
function converterName(en) {
  if (!en || en.converter == null) return '';
  if (typeof en.converter === 'object') return en.converter.name || '';
  return String(en.converter);
}
// Human-readable QoS level label for the register tables.
// Values are the QoSLevel priorities (0 realtime … 10000 static); an unset/unknown
// value renders as the category-derived default ("auto").
// The raw numeric priority is intentionally hidden from users — the interval
// meaning is conveyed via tooltip instead (see qosTip).
function qosName(en) {
  if (!en) return '';
  const v = en.qos;
  const names = { 0: 'realtime', 10: 'fast', 100: 'regular', 1000: 'slow', 10000: 'static' };
  if (names[v] != null) return names[v];
  const cat = en.category === 'config' ? 'config' : (en.entityCategory === 'diagnostic' ? 'diagnostic' : 'value');
  const defs = { value: 100, diagnostic: 1000, config: 10000 };
  const d = defs[cat];
  return 'auto · ' + (d != null ? names[d] : '');
}
// Tooltip text explaining what a QoS level means, shown over the QoS tag.
const qosLevelHelp = {
  0: 'Realtime: read every 250 ms',
  10: 'Fast: read every 2 s',
  100: 'Regular: read every poll cycle',
  1000: 'Slow: read every 100 s',
  10000: 'Static: read every hour'
};
function qosTip(en) {
  if (!en) return '';
  if (qosLevelHelp[en.qos] != null) return qosLevelHelp[en.qos] + ' — only used in "Dynamic polling (QoS)" mode.';
  const cat = en.category === 'config' ? 'config' : (en.entityCategory === 'diagnostic' ? 'diagnostic' : 'value');
  const d = { value: 100, diagnostic: 1000, config: 10000 }[cat];
  const base = d != null && qosLevelHelp[d] ? qosLevelHelp[d].toLowerCase() : '';
  return 'Auto — uses the ' + cat + ' default (' + base + '). Only used in "Dynamic polling (QoS)" mode.';
}
function qosClass(en) {
  if (!en || en.qos == null) return '';
  switch (en.qos) {
    case 0: return 'qos-realtime';
    case 10: return 'qos-fast';
    case 100: return 'qos-regular';
    case 1000: return 'qos-slow';
    case 10000: return 'qos-static';
    default: return '';
  }
}
// sort: Category (config -> value -> diag) then Address (low->high)
function catRank(en) {
  if (en.category === 'config') return 0;
  if (en.category === 'diagnostic' || en.entityCategory === 'diagnostic') return 2;
  return 1;
}
// Tooltip for the value column: value description from the template docs
// (converterParameters.description / valueDescription) plus condition info.
function valueTooltip(en) {
  const parts = []
  const d = en.converterParameters && (en.converterParameters.description || en.converterParameters.valueDescription)
  if (d) parts.push(d)
  // A selection (select converter) has a fixed set of raw->label options.
  if (converterName(en) === 'select' && en.converterParameters && Array.isArray(en.converterParameters.options)) {
    const opts = en.converterParameters.options
      .map((o) => (o && o.name != null ? o.key + ' = ' + o.name : String(o)))
      .join(', ')
    if (opts) parts.push(t('reg_select_options') + ': ' + opts)
  } else if (converterName(en) === 'number') {
    // For plain numeric registers describe the allowed range (min..max + unit).
    const id = en.converterParameters && en.converterParameters.identification
    if (id && (id.min !== undefined || id.max !== undefined)) {
      const unit = en.converterParameters && en.converterParameters.uom ? en.converterParameters.uom : ''
      const lo = id.min !== undefined ? id.min : '−∞'
      const hi = id.max !== undefined ? id.max : '∞'
      parts.push(t('reg_range') + ': ' + lo + ' … ' + hi + (unit ? ' ' + unit : ''))
    }
  }
  if (en.mqttValue != null && en.mqttValue !== '') {
    const unit = en.converterParameters && en.converterParameters.uom ? en.converterParameters.uom : ''
    // For select-sensors show the matching option label when available.
    let shown = en.mqttValue
    if (converterName(en) === 'select' && en.converterParameters && Array.isArray(en.converterParameters.options)) {
      const hit = en.converterParameters.options.find((o) =>
        (o.name != null && String(o.name) === String(en.mqttValue)) ||
        (o.key != null && String(o.key) === String(en.mqttValue)))
      if (hit && hit.name != null) shown = hit.name + ' (' + en.mqttValue + ')'
    }
    parts.push(t('reg_value_display') + ': ' + shown + (unit ? ' ' + unit : ''))
  }
  return parts.join('\n') || t('reg_value')
}

function sortRegisters(ents) {
  const arr = (ents || []).slice();
  arr.sort((a, b) => {
    const c = catRank(a) - catRank(b);
    if (c !== 0) return c;
    return (a.modbusAddress == null ? 0 : a.modbusAddress) - (b.modbusAddress == null ? 0 : b.modbusAddress);
  });
  return arr;
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
let editingRegEntity = null;
function specIndexOf(spec, en) {
  const arr = (spec && spec.entities) || []
  return arr.indexOf(en)
}
function entityByEid(spec, eid) {
  if (!spec || !spec.entities) return undefined
  if (eid == null) return undefined
  const n = Number(eid)
  if (!isNaN(n)) return spec.entities.find((e) => e.id === n)
  if (String(eid).startsWith('x')) {
    const idx = Number(String(eid).slice(1))
    return spec.entities[idx]
  }
  return undefined
}

function renderConditionRows(conds) {
  const rows = $('re-cond-rows');
  if (!rows) return;
  const c = conds && conds.length ? conds : [{}];
  rows.innerHTML = c.map((cond, i) => {
    let regStr = cond.register != null ? String(cond.register) : '';
    if (cond.bit != null) regStr += '.' + cond.bit;
    if (cond.mask != null) regStr += '&0x' + cond.mask.toString(16);
    return '<div class="reg-condition-row">' +
      '<input type="text" class="rc-register" placeholder="501, 500.1 or 0&0xF" title="Condition register address; optionally .bit (500.1) or &mask (0&0xF)" value="' + escapeHtml(regStr) + '">' +
      '<select class="rc-cmp">' +
        '<option value="eq"' + (cond.comparator==='eq'?' selected':'') + '>=</option>' +
        '<option value="ne"' + (cond.comparator==='ne'?' selected':'') + '>≠</option>' +
        '<option value="lt"' + (cond.comparator==='lt'?' selected':'') + '>&lt;</option>' +
        '<option value="le"' + (cond.comparator==='le'?' selected':'') + '>≤</option>' +
        '<option value="gt"' + (cond.comparator==='gt'?' selected':'') + '>&gt;</option>' +
        '<option value="ge"' + (cond.comparator==='ge'?' selected':'') + '>≥</option>' +
        '<option value="contains"' + (cond.comparator==='contains'?' selected':'') + '>contains</option>' +
        '<option value="hasbit"' + (cond.comparator==='hasbit'?' selected':'') + '>has bit</option>' +
      '</select>' +
      '<input type="text" class="rc-value" placeholder="1 or 1,8" title="Value to compare (or comma-separated OR-set, e.g. 1,8)" value="' + escapeHtml(cond.value != null ? String(cond.value) : (cond.values != null ? cond.values.join(',') : '')) + '">' +
      '<button type="button" class="btn btn-sm rc-del" title="' + t('remove') + '">✕</button>' +
    '</div>';
  }).join('');
  rows.querySelectorAll('.rc-del').forEach((b) => b.addEventListener('click', () => { b.closest('.reg-condition-row').remove(); }));
}
function readConditionRows() {
  const rows = $('re-cond-rows');
  if (!rows) return [];
  return Array.from(rows.querySelectorAll('.reg-condition-row')).map((row) => {
    const regStr = row.querySelector('.rc-register').value.trim();
    const m = regStr.match(/^(\d+)(?:\.(\d+))?(?:&(0x[0-9a-fA-F]+|\d+))?$/i);
    if (!m) return null;
    const cond = { register: parseInt(m[1], 10), comparator: row.querySelector('.rc-cmp').value || 'eq' };
    if (m[2] !== undefined) cond.bit = parseInt(m[2], 10);
    if (m[3] !== undefined) cond.mask = (/^0x/i.test(m[3]) ? parseInt(m[3], 16) : parseInt(m[3], 10));
    const cv = row.querySelector('.rc-value').value.trim();
    if (cv !== '') {
      // comma-separated = OR-set (values); otherwise single numeric value
      if (cv.includes(',')) cond.values = cv.split(',').map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n));
      else {
        const n = parseFloat(cv);
        if (!isNaN(n)) cond.value = n;
      }
    }
    return cond;
  }).filter((c) => c !== null);
}

function openRegEdit(idx) {
  const spec = activeSpec || templateSpec;
  const en = idx == null ? null : entityByEid(spec, idx);
  openRegEditForEntity(en);
}
function openRegEditForEntity(en) {
  const isNew = en == null;
  if (isNew) en = { converter: 'number', converterParameters: {}, registerType: 3, readonly: true };
  editingRegEntity = isNew ? null : en;
  editingRegIdx = en && en.id != null ? en.id : null;
  const cp = (en && en.converterParameters) || {};
  $('re-name').value = en.name || '';
  // Per-language translated names: prefill from the active spec's i18n block.
  const i18nSpec = activeSpec || templateSpec;
  const i18nEnt = (i18nSpec && en && en.id != null) ? i18nSpec : null;
  ['en', 'de', 'fr', 'it'].forEach((l) => {
    const el = $('re-name-' + l);
    if (el) el.value = (i18nEnt && getSpecificationText(i18nEnt, 'e' + en.id, l)) || '';
  });
  $('re-mqttname').value = en.mqttname || '';
  $('re-registertype').value = String(en.registerType == null ? 3 : en.registerType);
  $('re-modbusaddress').value = en.modbusAddress == null ? '' : String(en.modbusAddress);
  $('re-readonly').checked = !!en.readonly;
  $('re-category').value = en.category || en.entityCategory || 'value';
  $('re-qos').value = en.qos != null ? String(en.qos) : '';
  // conditions (register[.bit], comparator, value) - array of AND-combined conditions
  renderConditionRows((en.conditions && en.conditions.length) ? en.conditions : (en.condition ? [en.condition] : []));
  $('re-value-desc').value = (en.converterParameters && (en.converterParameters.description || en.converterParameters.valueDescription)) || '';
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
  $('regedit-title').textContent = editingRegIdx == null ? t('reg_add') : t('reg_edit');
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
$('re-cond-add')?.addEventListener('click', () => {
  const rows = $('re-cond-rows');
  if (!rows) return;
  // append a blank row: render current rows + one empty
  const cur = Array.from(rows.querySelectorAll('.reg-condition-row')).map((row) => {
    const regStr = row.querySelector('.rc-register').value.trim();
    const m = regStr.match(/^(\d+)(?:\.(\d+))?(?:&(0x[0-9a-fA-F]+|\d+))?$/i);
    const cond = m ? { register: parseInt(m[1], 10), comparator: row.querySelector('.rc-cmp').value || 'eq' } : {};
    if (m && m[2] !== undefined) cond.bit = parseInt(m[2], 10);
    if (m && m[3] !== undefined) cond.mask = (/^0x/i.test(m[3]) ? parseInt(m[3], 16) : parseInt(m[3], 10));
    const cv = row.querySelector('.rc-value').value.trim();
    if (cv !== '') {
      if (cv.includes(',')) cond.values = cv.split(',').map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n));
      else { const n = parseFloat(cv); if (!isNaN(n)) cond.value = n; }
    }
    return cond;
  });
  renderConditionRows([...cur, {}]);
});
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
    // options preserved from the entity being edited (same spec, resolved by id)
    const spec0 = activeSpec || templateSpec;
    const ents0 = (spec0 && spec0.entities) || [];
    const oldEnt = editingRegEntity || (editingRegIdx != null ? entityByEid(spec0, editingRegIdx) : null);
    const oldCp = (oldEnt && oldEnt.converterParameters) || {};
    if (Array.isArray(oldCp.options)) cp.options = oldCp.options;
    else if (editingRegIdx == null && !oldEnt) cp.options = [];
  }
  const spec = activeSpec || templateSpec;
  const ents = (spec && spec.entities) || (spec.entities = []);
  const editing = editingRegEntity || (editingRegIdx != null ? entityByEid(spec, editingRegIdx) : null);
  const en = {
    id: editing ? editing.id : ((spec.nextEntityId) || (spec.nextEntityId = 1)),
    name: name || undefined,
    mqttname: mqttname || undefined,
    registerType, modbusAddress, readonly, converter,
    converterParameters: cp,
    valid: true
  };
  // Persist per-language translated names into the spec's i18n blocks (the
  // register list renders these via regName()/getSpecificationText()). The
  // textId is 'e<id>', same scheme the backend uses for register names.
  if (spec && en.id != null) {
    const enNameEl = $('re-name-en');
    // A fresh register may have its English name typed into the translated
    // EN field only; make sure the canonical en.name stays in sync.
    if ((!name || name === '') && enNameEl && enNameEl.value.trim() !== '') en.name = enNameEl.value.trim();
    ['de', 'fr', 'it', 'en'].forEach((l) => {
      const el = $('re-name-' + l);
      if (el) setSpecText(spec, l, 'e' + en.id, el.value.trim());
    });
  }
  // category: 'value' (default), 'config' (device config - not published), 'diagnostic'
  const category = $('re-category').value || 'value';
  if (category === 'config') en.category = 'config';
  else if (category === 'diagnostic') en.entityCategory = 'diagnostic';
  // QoS (dynamic polling): explicit level, or unset => category-derived default ("auto")
  const qosVal = $('re-qos').value;
  if (qosVal !== '' && qosVal != null) en.qos = parseInt(qosVal, 10);
  else delete en.qos;
  // conditions: array of AND-combined register conditions
  const conds = readConditionRows();
  if (conds.length > 0) { en.conditions = conds; delete en.condition; }
  else { delete en.conditions; delete en.condition; }
  // value description (template docs)
  const vdesc = $('re-value-desc').value.trim();
  if (vdesc !== '') {
    en.converterParameters = en.converterParameters || {};
    en.converterParameters.valueDescription = vdesc;
  } else if (en.converterParameters) {
    delete en.converterParameters.valueDescription;
  }
  if (editing) {
    en.id = editing.id;
    if (editing.converter === 'select' && converter === 'select') en.converterParameters = Object.assign({}, editing.converterParameters, cp);
    const pos = ents.indexOf(editing);
    if (pos >= 0) ents[pos] = en;
    else ents.push(en);
  } else {
    if (typeof spec.nextEntityId === 'number') spec.nextEntityId++;
    ents.push(en);
  }
  $('regedit-overlay').hidden = true;
  editingRegEntity = null;
  if (activeSpec === slaveSpec) slaveSpecDirty = true;
  renderActiveRegisters();
});
function slugifyFilename(name) {
  // Template name -> file name: lowercase, accents stripped, non-alnum -> '-'
  return (name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
$('tpledit-ok')?.addEventListener('click', async () => {
  // Persist the currently shown language before reading anything, so the
  // final spec.i18n contains the edits made in every language (the popup
  // shows one language at a time, but saves all of them together).
  if (templateSpec) setSpecText(templateSpec, templatePopupLang, 'name', $('te-name').value);
  const name = $('te-name').value.trim();
  const model = $('te-model').value.trim();
  const manufacturer = $('te-manufacturer').value.trim();
  if (!name) return toast(t('err_no_name'), 'error');
  // The canonical (English) name drives the file name; the visible field may
  // show a different language. Prefer the EN i18n block, then the model.
  const enName = getSpecTextRaw(templateSpec, 'en', 'name') || templateSpec.model ||
    (editingTemplateOriginalName || name);
  // Only derive a new YAML filename when the user actually renamed the
  // template; opening the popup and saving it untouched must keep the existing
  // file (the name field is prefilled with the localized name, not the model).
  const editingOriginalBase = editingTemplateOriginalFilename
    ? editingTemplateOriginalFilename.replace(/\.yaml$/, '')
    : null;
  const userEditedName = editingTemplateOriginalName !== null && enName !== editingTemplateOriginalName;
  const filename = (userEditedName && slugifyFilename(enName)) || editingOriginalBase || slugifyFilename(enName) || 'template';
  const spec = Object.assign({}, templateSpec || emptyTemplateSpec(), {
    filename: filename + '.yaml',
    // model stays the bare model code when set; falls back to the name for
    // adds / renames (so name-only templates still get a model), but never
    // overwrites an existing model with the (possibly localized) display name
    // when the user didn't actually change anything.
    model: model || ((userEditedName || editingOriginalBase === null) ? enName : undefined) || undefined,
    manufacturer: manufacturer || undefined
  });
  if (!Array.isArray(spec.entities)) spec.entities = [];
  if (!Array.isArray(spec.i18n)) spec.i18n = [];
  if (spec.identified == null) spec.identified = 0;
  if (spec.status == null) spec.status = 3;
  // Build the files array from the media editor state. The image is the first
  // img/icon entry; each language gets its own doc entry (with lang). Uploaded
  // files carry base64 `data` + mimeType and must reference the canonical
  // static path the backend writes them to: specifications/files/<name>/<base>.
  // Remote URLs keep their fileLocation=Global (1) so they are not persisted
  // locally.
  const mediaBase = filename.replace(/\.yaml$/, '');
  const mediaFiles = [];
  if (tplMedia.image && tplMedia.image.url) {
    const imgUrl = tplMedia.image.data
      ? 'specifications/files/' + mediaBase + '/' + tplMedia.image.url.split('/').pop()
      : tplMedia.image.url;
    mediaFiles.push({
      url: imgUrl,
      fileLocation: tplMedia.image.data ? 0 : 1,
      usage: 'img',
      ...(tplMedia.image.data ? { data: tplMedia.image.data, mimeType: tplMedia.image.mimeType || 'image/png' } : {}),
    });
  }
  TEMPLATE_LANGS.forEach((lang) => {
    const d = tplMedia.docs[lang];
    if (d && d.url) {
      const docUrl = d.data
        ? 'specifications/files/' + mediaBase + '/' + d.url.split('/').pop()
        : d.url;
      mediaFiles.push({
        url: docUrl,
        fileLocation: d.data ? 0 : 1,
        usage: 'doc',
        lang: lang,
        ...(d.data ? { data: d.data, mimeType: d.mimeType || 'application/pdf' } : {}),
      });
    }
  });
  spec.files = mediaFiles;
  try {
    // Templates are self-contained: no bus/slave is required to save them (a
    // public template is cloned into the local dir by the backend on save).
    await api('/api/specification?originalFilename=' +
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
  $('modal-title').textContent = t('remove_template_title');
  $('modal-body').textContent = t('remove_template_body');
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
    const label = tpl != null ? t('err_remove_template') : t('err_remove_device');
    toast(label + e.message, 'error');
  }
});

// Write a register value (r/w registers only). Uses the existing write endpoint.
async function writeRegisterValue(busid, slaveid, spec, entityid, value) {
  const url = '/api/modbus/write/entity?busid=' + busid + '&slaveid=' + slaveid +
    '&entityid=' + entityid + '&mqttValue=' + encodeURIComponent(String(value));
  await api(url, { method: 'POST', body: JSON.stringify(spec) });
}
// Inline-edit a register value (r/w registers only): clicking the pencil turns the
// value cell into an editable input with a confirm (✓) and cancel (✕) button.
function startInlineEdit(btn, spec, en) {
  if (!en) return;
  const cell = btn.closest('td');
  if (!cell) return;
  const cur = en.mqttValue != null ? en.mqttValue : '';
  // Select converters (e.g. unit_system: SI / Imperial) are edited with a
  // dropdown of the option labels instead of a free-text field, so the display
  // value and the written value are consistent (the backend resolves the label).
  const isSelect = converterName(en) === 'select' && en.converterParameters && Array.isArray(en.converterParameters.options);
  let editor
  if (isSelect) {
    const opts = en.converterParameters.options
    const matchedIdx = opts.findIndex((o) =>
      (o.key != null && String(o.key) === String(cur)) ||
      (o.name != null && String(o.name) === String(cur)))
    // Pre-select the option matching the current value. When nothing matches
    // (value not read yet, or a raw key), offer a placeholder instead of
    // silently selecting the first option.
    const optionsHtml = opts.map((o, i) => {
      const sel = i === matchedIdx ? ' selected' : ''
      return '<option value="' + escapeHtml(String(o.key)) + '"' + sel + '>' + escapeHtml(o.name != null ? o.name : String(o.key)) + '</option>'
    }).join('')
    editor = '<select class="reg-inline-select">' +
      (matchedIdx < 0 ? '<option value="" disabled selected>' + escapeHtml(t('reg_select_placeholder')) + '</option>' : '') +
      optionsHtml + '</select>'
  } else {
    editor = '<input type="text" value="' + escapeHtml(String(cur)) + '">'
  }
  cell.innerHTML = '<span class="reg-inline">' + editor +
    '<button class="reg-ok" title="' + t('save') + '">✓</button>' +
    '<button class="reg-cancel" title="' + t('cancel') + '">✕</button>' +
    '</span>';
  const input = cell.querySelector('input, select');
  input.focus();
  const finish = (ok) => {
    if (ok) {
      const val = input.value;
      if (isSelect && val === '') {
        // Placeholder still selected — no real option chosen; leave the value untouched.
        renderDeviceRegisters();
        return;
      }
      const busid = editingSlaveBus != null ? editingSlaveBus : (state.busses[0] && state.busses[0].busId);
      const slaveid = editingSlaveId != null ? editingSlaveId : (state.busses[0] && state.busses[0].slaves && state.busses[0].slaves[0] && state.busses[0].slaves[0].slaveid);
      writeRegisterValue(busid, slaveid, spec, en.id, val)
        .then(() => {
          toast(t('config_saved'), 'success');
          // Re-read the register values from the device so the table reflects the
          // actual (single, converted) value that was written.
          if (spec === slaveSpec || spec === (activeSpec || slaveSpec)) {
            refreshSlaveValues(busid, slaveid, spec.filename || slaveSpec.filename || '')
              .then(() => renderDeviceRegisters());
          } else {
            en.mqttValue = val;
            renderDeviceRegisters();
          }
        })
        .catch((err) => { toast((err && err.message) || t('err_save_config'), 'error'); renderDeviceRegisters(); });
    } else {
      renderDeviceRegisters();
    }
  };
  cell.querySelector('.reg-ok').addEventListener('click', () => finish(true));
  cell.querySelector('.reg-cancel').addEventListener('click', () => finish(false));
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') finish(true); if (ev.key === 'Escape') finish(false); });
}
// Delegate reg-write clicks on both register tables (template editor uses a bus/slave context via editingBus/editingSlave when set)
document.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('.reg-write') : null;
  if (!btn) return;
  const tbody = btn.closest('tbody');
  const eid = btn.getAttribute('data-eid');
  const spec = (tbody && tbody.id === 'te-reg-body') ? templateSpec : slaveSpec;
  const en = entityByEid(spec, eid);
  startInlineEdit(btn, spec, en);
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
  { key: 'debugComponents', labelKey: 'cfg_debug_components', type: 'multi-select', optionsUrl: '/api/debugComponents', helpKey: 'cfg_debug_components_help' }
];
const CONFIG_KEYMAP = {
  mqttuser: 'mqttconnect.username',
  mqttpassword: 'mqttconnect.password',
  mqttserverurl: 'mqttconnect.mqttserverurl',
  mqttbasetopic: 'mqttbasetopic',
  mqttdiscoveryprefix: 'mqttdiscoveryprefix',
  mqttdiscoverylanguage: 'mqttdiscoverylanguage',
  mqttcafile: 'mqttcaFile', mqttcertfile: 'mqttcertFile', mqttkeyfile: 'mqttkeyFile',
  debugComponents: 'debugComponents'
};
function configDottedKey(fieldKey) {
  return CONFIG_KEYMAP[fieldKey] || fieldKey;
}
// ssl file list cache
let stateSslFiles = [];
let stateSslFilesRoot = '';
let stateSslFilesError = '';
async function loadSslFiles() {
  try {
    const r = await api('/api/sslfiles');
    // Backend returns { files, root }; older responses may be a bare array.
    stateSslFiles = Array.isArray(r) ? r : (r && Array.isArray(r.files) ? r.files : []);
    stateSslFilesRoot = (r && r.root) || '';
    stateSslFilesError = '';
  } catch (e) {
    // Any failure is reported so the user knows the listing failed instead of
    // seeing a fake "no files".
    stateSslFiles = [];
    stateSslFilesRoot = '';
    stateSslFilesError = e.message || 'error';
  }
}
// ---- server file browser (cert/key picker) ----
// Opens a small modal listing the files in the ssl directory (from
// /api/sslfiles). Clicking a file writes its name into the field the browse
// button belongs to and closes the modal.
let fileBrowserTarget = null;
async function openFileBrowser(btn) {
  fileBrowserTarget = btn.getAttribute('data-for');
  const list = $('filebrowse-list');
  const overlay = $('filebrowse-overlay');
  if (!list || !overlay) return;
  await loadSslFiles();
  const titleEl = $('filebrowse-title');
  if (titleEl) {
    titleEl.textContent = (t('cfg_browse_files') || 'Browse server files') + (stateSslFilesRoot ? ' — ' + stateSslFilesRoot : '');
  }
  if (stateSslFilesError) {
    list.innerHTML = '<div class="fb-empty fb-error">' + escapeHtml(t('cfg_browse_error') || 'Could not load server files') + ': ' + escapeHtml(stateSslFilesError) + '</div>';
  } else if (!stateSslFiles.length) {
    list.innerHTML = '<div class="fb-empty">' + escapeHtml(t('cfg_browse_empty') || 'No server files available') + '</div>';
  } else {
    list.innerHTML = stateSslFiles.map((f) =>
      '<div class="fb-entry" data-file="' + escapeHtml(f) + '">' +
      '<span class="fb-icon">📄</span><span>' + escapeHtml(f) + '</span></div>'
    ).join('');
  }
  overlay.hidden = false;
}
function bindFileBrowser() {
  const overlay = $('filebrowse-overlay');
  const list = $('filebrowse-list');
  if (!overlay || !list) return;
  overlay.addEventListener('click', (e) => {
    const entry = e.target.closest('.fb-entry');
    if (!entry) return;
    const key = fileBrowserTarget;
    const grid = $('mqtt-grid');
    const target = grid ? grid.querySelector('input[data-cfgkey="' + key + '"]') : null;
    if (target) target.value = entry.getAttribute('data-file') || '';
    overlay.hidden = true;
    fileBrowserTarget = null;
  });
  $('filebrowse-cancel')?.addEventListener('click', () => {
    overlay.hidden = true;
    fileBrowserTarget = null;
  });
}
// debug component catalog cache (for the multi-select in the config modal)
let stateDebugComponents = [];
async function loadDebugComponents() {
  try { stateDebugComponents = await api('/api/debugComponents'); } catch (e) { stateDebugComponents = []; }
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
  if (field.type === 'multi-select') {
    // Checkbox list fed by an async options endpoint; values are stored as a
    // comma-separated string (matches the backend Debug.enable() format), with
    // the active components preselected.
    const selected = String(val == null ? '' : val).split(',').map((s) => s.trim()).filter(Boolean);
    const cbs = (stateDebugComponents || [])
      .map((c) =>
        '<label class="debug-cb"><input type="checkbox" value="' + escapeHtml(c.name) + '"' + (selected.includes(c.name) ? ' checked' : '') + ' data-cfgkey="' + field.key + '" data-debugcb="1">' +
        '<span class="debug-cb-name">' + escapeHtml(c.name) + '</span>' +
        '<span class="debug-cb-desc">' + escapeHtml(c.description || '') + '</span></label>'
      )
      .join('');
    return '<div class="field field-debug"><label for="' + id + '">' + escapeHtml(label) + ' ' + helpIcon(field) + '</label>' +
      '<div class="debug-checklist" id="' + id + '">' + cbs + '</div>' +
      '<div class="field-help">' + escapeHtml(t(field.helpKey)) + '</div></div>';
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
    btn.addEventListener('click', () => openFileBrowser(btn));
  });
  $('mqttedit-overlay').hidden = false;
  applyHelpIcons($('mqtt-grid'));
}
$('mqtt-status')?.addEventListener('click', openMqttEdit);
$('mqttedit-cancel')?.addEventListener('click', () => { $('mqttedit-overlay').hidden = true; });
// Collect the current MQTT popup field values into `merged` without saving. Shared by
// the save handler and the "Test connection" button so the test always reflects what is
// currently typed in the form (even unsaved changes).
function collectMqttForm(merged) {
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
  return merged;
}
$('mqttedit-test')?.addEventListener('click', async () => {
  const resultEl = $('mqtt-test-result');
  const btn = $('mqttedit-test');
  if (!resultEl || !btn) return;
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = '…';
  try {
    const merged = collectMqttForm(JSON.parse(JSON.stringify(state.config || {})));
    const url = merged.mqttconnect && merged.mqttconnect.mqttserverurl;
    if (!url) {
      resultEl.className = 'mqtt-test-result mqtt-test-error';
      resultEl.textContent = t('mqtt_test_no_url') || 'Enter an MQTT server URL first.';
      resultEl.hidden = false;
      return;
    }
    const r = await api('/api/validate/mqtt', {
      method: 'POST',
      body: JSON.stringify({ mqttconnect: merged.mqttconnect })
    });
    if (r && r.valid) {
      resultEl.className = 'mqtt-test-result mqtt-test-ok';
      resultEl.textContent = t('mqtt_test_ok') || 'Connection successful';
    } else {
      resultEl.className = 'mqtt-test-result mqtt-test-error';
      resultEl.textContent = (r && r.message) || (t('mqtt_test_fail') || 'Connection failed');
    }
    resultEl.hidden = false;
  } catch (e) {
    resultEl.className = 'mqtt-test-result mqtt-test-error';
    resultEl.textContent = t('mqtt_test_fail') + ' ' + (e && e.message ? e.message : '');
    resultEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
});
$('mqttedit-save')?.addEventListener('click', async () => {
  const merged = collectMqttForm(JSON.parse(JSON.stringify(state.config || {})));
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
  await loadDebugComponents();
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
  // Collect debug-component checkboxes first (grouped by data-cfgkey into comma
  // strings). Every key present in the form is (re)set — even when nothing is
  // checked, so a component can be fully disabled (previously an empty group was
  // skipped and the stale comma-joined value stayed in the config).
  const cbGroups = new Map();
  document.querySelectorAll('#config-grid input[data-debugcb]').forEach((cb) => {
    const k = cb.getAttribute('data-cfgkey');
    if (!cbGroups.has(k)) cbGroups.set(k, []);
    if (cb.checked) cbGroups.get(k).push(cb.value);
  });
  cbGroups.forEach((names, k) => {
    configSet(merged, k, names.length ? names.join(',') : undefined);
  });
  document.querySelectorAll('#config-grid [data-cfgkey]').forEach((inp) => {
    if (inp.type === 'checkbox') return; // debug checkboxes handled above; bool fields are handled below
    const k = inp.getAttribute('data-cfgkey');
    if (cbGroups.has(k)) return;          // already set from checkboxes
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

/* ---------------- image hover popup (no lightbox) ---------------- */
/* Hovering a template/device thumbnail shows a small popup with the full
   image. It follows the mouse and disappears again as soon as the mouse
   leaves the thumbnail - no overlay, no click-to-dismiss. */
(function initImagePopup() {
  const pop = document.getElementById('img-pop');
  const img = document.getElementById('img-pop-img');
  if (!pop || !img) return;
  let hideTimer = null;
  let shown = false;

  function show(src) {
    clearTimeout(hideTimer);
    if (!img.src || img.src !== src) img.src = src;
    shown = true;
    pop.classList.add('show');
    pop.hidden = false;
    pop.style.left = ''; pop.style.top = '';
    img.onload = () => { if (shown) position(); };
  }
  function hide() {
    clearTimeout(hideTimer);
    if (!shown) return;
    shown = false;
    pop.classList.remove('show');
    pop.hidden = true;
    img.src = '';
  }
  function position() {
    if (!shown || !pop._thumb) return;
    const r = pop._thumb.getBoundingClientRect();
    let left = r.left;
    let top = r.bottom + 8;
    const pw = pop.offsetWidth || 300;
    const ph = pop.offsetHeight || 300;
    if (left + pw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pw - 8);
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 8);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }
  // Hovering a template/device thumbnail shows the popup next to it.
  document.addEventListener('mouseover', (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG' && (t.closest('.tpl-img') || t.closest('.slave-img'))) {
      pop._thumb = t;
      show(t.src);
      // The popup may not be laid out yet; the img.onload repositions.
      if (img.complete && img.naturalWidth > 0) position();
      else setTimeout(position, 10);
    }
  });
  document.addEventListener('mouseout', (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG' && (t.closest('.tpl-img') || t.closest('.slave-img'))) {
      hideTimer = setTimeout(hide, 60);
    }
  });
  // Keep it open while the mouse is moving over the popup itself (no flicker).
  pop.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  pop.addEventListener('mouseleave', hide);
  // Recount when the window is resized.
  window.addEventListener('resize', () => { if (shown) position(); });
  window.addEventListener('scroll', () => { if (shown) position(); }, true);
})();

/* ---------------- RTU sniffer ---------------- */
let snifferBusId = null;
let snifferPollTimer = null;          // fallback polling (SSE unavailable)
let snifferGlobalSse = null;          // EventSource for global (all-bus) sniffer changes
let snifferGlobalSseDisabled = false; // permanently give up on SSE after repeated hard failures
let snifferState = null;
let snifferFilters = {};   // { table: { field: filterValues[] } } — array = multi-select (OR)
let snifferAnnotateTarget = null; // { busId, slaveId, address, converter?, uom? }
let snifferTableData = { telegrams: [], devices: [], registers: [] };
// Time-range filter for the telegram table (epoch seconds; null = no bound).
let snifferTelegramTimeFilter = { from: null, to: null };
// Pagination state. Telegram + history tables are server-side paged
// (?limit=&offset=, response {rows,total}); devices/registers are client-side
// paged slices of the full set.
let snifferTelegramPage = 1;
let snifferTelegramPageSize = 200;
let snifferHistoryPage = 1;
let snifferHistoryPageSize = 100;
let snifferHistoryFilter = { from: null, to: null };
let snifferDevicePage = 1;
let snifferDevicePageSize = 50;
let snifferRegisterPage = 1;
let snifferRegisterPageSize = 25;
let snifferTrend = null; // { busId, slaveId, address, title, uom }

/* ---------------- eye icon / bus list status ---------------- */
// The sniffer eye-icon lives in the bus list (renderBusses). We refresh its
// running/stopped state here without re-rendering the whole list.
let snifferEyeReconnectTimer = null;
let snifferEyeStates = {}; // { busId: 'running' | 'stopped' | 'error' | 'unknown' }

async function refreshSnifferEyeStates() {
  const buttons = document.querySelectorAll('.bus-sniffer');
  if (!buttons.length) return;
  const busIds = Array.from(new Set(Array.from(buttons).map((b) => Number(b.getAttribute('data-busid')))));
  await Promise.all(busIds.map(async (busId) => {
    try {
      const st = await api('/api/sniffer/state?busid=' + busId);
      snifferEyeStates[busId] = st && st.running ? 'running' : (st && st.error ? 'error' : 'stopped');
    } catch (e) {
      snifferEyeStates[busId] = 'unknown';
    }
  }));
  buttons.forEach((b) => {
    const busId = Number(b.getAttribute('data-busid'));
    const st = snifferEyeStates[busId] || 'stopped';
    b.classList.remove('sn-eye-running', 'sn-eye-stopped', 'sn-eye-error', 'sn-eye-unknown');
    b.classList.add('sn-eye-' + st);
    b.title = snifferEyeTitle(busId);
  });
}
function snifferEyeClass(busId) {
  const st = snifferEyeStates[busId] || 'stopped';
  return 'sn-eye-' + st;
}
function snifferEyeTitle(busId) {
  const st = snifferEyeStates[busId] || 'stopped';
  return st === 'running' ? t('sniffer_running')
    : st === 'error' ? t('sniffer_stopped') + ' (⚠)'
    : t('sniffer_stopped');
}
function startSnifferEyeRefresh() {
  stopSnifferEyeRefresh();
  refreshSnifferEyeStates();
  // Push-based: a single global SSE stream reports any sniffer change across
  // all buses. On each event we refresh only the eye states (cheap) and, if
  // the sniffer dialog is open, the table for the active bus. Falls back to a
  // 2s poll while the SSE is (re)connecting, and RECONNECTS the stream after a
  // hard close instead of giving up forever — a proxy restart would otherwise
  // leave the eye on the slow poll indefinitely.
  let retryDelay = 500;
  const startFallbackPoll = () => {
    // Share ONE poll timer with the dialog (startSnifferPolling). The poll
    // refreshes the eye badges AND the open dialog's tables, so a single
    // interval covers both.
    if (snifferPollTimer) return;
    snifferPollTimer = setInterval(() => {
      refreshSnifferEyeStates();
      if (snifferBusId != null) snifferRefresh();
    }, 2000);
  };
  const stopFallbackPoll = () => {
    if (snifferPollTimer) { clearInterval(snifferPollTimer); snifferPollTimer = null; }
  };
  const connect = () => {
    if (snifferGlobalSse) { try { snifferGlobalSse.close(); } catch (e) { /* ignore */ } snifferGlobalSse = null; }
    if (typeof EventSource === 'undefined' || snifferGlobalSseDisabled) { startFallbackPoll(); return; }
    let es;
    try {
      es = new EventSource('/api/sniffer/events');
    } catch (e) { startFallbackPoll(); return; }
    snifferGlobalSse = es;
    es.addEventListener('change', (ev) => {
      // Stream is alive again - reset the reconnect backoff. Bus list is
      // already rendered; just refresh the eye badges + (if the dialog is
      // open) the active bus's tables.
      retryDelay = 500;
      refreshSnifferEyeStates();
      if (snifferBusId != null && typeof snifferRefresh === 'function') snifferRefresh();
    });
    es.onopen = () => { stopFallbackPoll(); retryDelay = 500; };
    es.onerror = () => {
      // The EventSource is in CONNECTING (transient network/proxy blip) or
      // CLOSED (hard failure). Keep the poll running while it is gone; on a
      // hard close CLOSE and re-create the stream with backoff — the browser
      // auto-reconnects only while CONNECTING, not after CLOSED.
      startFallbackPoll();
      if (es.readyState === EventSource.CLOSED) {
        if (snifferGlobalSse === es) { try { es.close(); } catch (e) { /* ignore */ } snifferGlobalSse = null; }
        clearTimeout(snifferEyeReconnectTimer);
        snifferEyeReconnectTimer = setTimeout(() => { if (snifferGlobalSse === null) connect(); }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 15000);
      }
    };
  };
  connect();
}
function stopSnifferEyeRefresh() {
  if (snifferPollTimer) { clearInterval(snifferPollTimer); snifferPollTimer = null; }
  if (snifferEyeReconnectTimer) { clearTimeout(snifferEyeReconnectTimer); snifferEyeReconnectTimer = null; }
  if (snifferGlobalSse) { try { snifferGlobalSse.close(); } catch (e) { /* ignore */ } snifferGlobalSse = null; }
}

async function openSniffer(busid) {
  snifferBusId = Number(busid);
  try {
    const cfg = await api('/api/sniffer/config?busid=' + snifferBusId);
    if ($('sn-enabled')) $('sn-enabled').checked = !!cfg.enabled;
  } catch (e) { /* defaults are fine */ }
  $('sniffer-overlay').hidden = false;
  resetSnifferFilters();
  await loadSnifferSlaveTemplates();
  // Show what the database already has, regardless of running state.
  await snifferRefresh();
  // The dialog just fetched the authoritative state — make the bus-list eye
  // reflect it immediately instead of waiting for the next SSE/poll tick.
  if (snifferState) snifferEyeStates[snifferBusId] = snifferState.running ? 'running' : (snifferState.error ? 'error' : 'stopped');
  document.querySelectorAll('.bus-sniffer[data-busid="' + snifferBusId + '"]').forEach((b) => {
    const st = snifferEyeStates[snifferBusId] || 'stopped';
    b.classList.remove('sn-eye-running', 'sn-eye-stopped', 'sn-eye-error', 'sn-eye-unknown');
    b.classList.add('sn-eye-' + st);
    b.title = snifferEyeTitle(snifferBusId);
  });
  refreshSnifferEyeStates();
  startSnifferLiveUpdates();
}

function closeSniffer() {
  stopSnifferLiveUpdates();
  $('sniffer-overlay').hidden = true;
  snifferBusId = null;
}

/* ---------------- live updates (global SSE + polling fallback) ----------------
 * The bus list keeps ONE global SSE stream open (/api/sniffer/events without
 * busid). It refreshes the eye badges on every change AND refreshes the open
 * sniffer dialog's tables for the active bus. The eye-refresh code owns the
 * SSE stream AND its fallback poll; the dialog simply reuses that same poll
 * (startSnifferLiveUpdates becomes a no-op if the eye poll is already running),
 * so there is never more than one poll timer for the whole page.
 */
function startSnifferLiveUpdates() {
  if (snifferBusId == null) return;
  // If the SSE stream is up, the global 'change' handler already refreshes the
  // dialog tables; nothing to do. If it is down (connecting/closing), make
  // sure the eye fallback poll is ticking — it also re-fetches the dialog.
  if (typeof EventSource === 'undefined' || snifferGlobalSseDisabled || !snifferGlobalSse) {
    startSnifferPolling();
  }
}
// The polling timer is owned by the eye-refresh code (startSnifferEyeRefresh):
// it must keep running even with the dialog closed so the bus-list eye badges
// stay fresh. Closing the dialog therefore does NOT stop it.
function stopSnifferLiveUpdates() {
  /* no-op — see comment above */
}
function startSnifferPolling() {
  stopSnifferPolling();
  snifferPollTimer = setInterval(() => {
    refreshSnifferEyeStates();
    if (snifferBusId != null) snifferRefresh();
  }, 2000);
}
function stopSnifferPolling() {
  if (snifferPollTimer) { clearInterval(snifferPollTimer); snifferPollTimer = null; }
}

function snifferTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function snifferHexRow(hex) {
  if (!hex) return '';
  return String(hex).match(/.{1,2}/g)?.join(' ') || String(hex);
}
function snifferDir(d) { return d === 'request' ? '→' : '←'; }

/* ---------------- sniffer column filters (multi-select dropdown) ---------------- */
function resetSnifferFilters() {
  snifferFilters = {};
  hideSnifferFilterPopup();
  document.querySelectorAll('.sn-filter-ico').forEach((ico) => {
    setSnifferFilterIndicator(ico);
  });
}
function tableNameFor(icon) {
  const panel = icon.closest('.sniffer-tab-panel');
  if (!panel) return null;
  return panel.id === 'sntab-telegrams' ? 'telegrams' : panel.id === 'sntab-devices' ? 'devices' : 'registers';
}
function setSnifferFilterIndicator(icon) {
  const th = icon ? icon.closest('th') : null;
  const field = icon ? icon.getAttribute('data-snf') : null;
  const table = icon ? tableNameFor(icon) : null;
  // The timestamp funnel indicates the ACTIVE TIME RANGE (server-side from/to),
  // not a multi-select list.
  if (field === 'timestamp') {
    const active = snifferTelegramTimeFilter.from != null || snifferTelegramTimeFilter.to != null;
    if (icon) {
      icon.classList.toggle('active', active);
      let badge = icon.querySelector('.sn-filter-badge');
      if (active) {
        const label = (snifferTelegramTimeFilter.from
          ? snifferTime(snifferTelegramTimeFilter.from) : '…') + ' – ' +
          (snifferTelegramTimeFilter.to ? snifferTime(snifferTelegramTimeFilter.to) : '…');
        icon.setAttribute('aria-label', t('sniffer_filter_active') + ' ' + label);
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'sn-filter-badge';
          icon.appendChild(badge);
        }
        badge.textContent = '⏱';
      } else {
        icon.removeAttribute('aria-label');
        if (badge) badge.remove();
      }
    }
    if (th) th.classList.toggle('sn-filtered', active);
    return;
  }
  const vals = (table && field && snifferFilters[table] && snifferFilters[table][field]) || [];
  const has = Array.isArray(vals) && vals.length > 0;
  if (icon) {
    icon.classList.toggle('active', has);
    // Keep the funnel SVG; show a count badge when the column is filtered.
    let badge = icon.querySelector('.sn-filter-badge');
    if (has) {
      icon.setAttribute('aria-label', t('sniffer_filter_active') + ' ' + vals.length);
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'sn-filter-badge';
        icon.appendChild(badge);
      }
      badge.textContent = vals.length;
    } else {
      icon.removeAttribute('aria-label');
      if (badge) badge.remove();
    }
  }
  if (th) th.classList.toggle('sn-filtered', has);
}

/* The shared popup: shows the present values as checkboxes plus a manual input. */
let snFilterPopupIcon = null; // the .sn-filter-ico that opened the popup
function openSnifferFilterPopup(icon) {
  const field = icon.getAttribute('data-snf');
  const table = tableNameFor(icon);
  if (!table || !field) return;
  snFilterPopupIcon = icon;
  // Position under the header cell.
  const th = icon.closest('th');
  const rect = th.getBoundingClientRect();
  const popup = $('sn-filter-popup');
  popup.hidden = false;
  const pw = popup.offsetWidth || 240;
  let left = rect.left;
  if (left + pw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pw - 8);
  popup.style.left = left + 'px';
  popup.style.top = (rect.bottom + 4) + 'px';
  $('sn-filter-popup-field').textContent = t('sniffer_filter_field').replace('{field}', snifferFilterFieldLabel(field));
  $('sn-filter-custom').value = '';

  // The timestamp column filter is a TIME RANGE (from/to), not a value list:
  // every telegram has a unique timestamp, so checkboxes would be useless.
  // Show the from/to datetime pickers wired to the server-side from/to query.
  const isTime = field === 'timestamp';
  const timeRange = $('sn-filter-timerange');
  const valueWrap = $('sn-filter-values');
  const customWrap = $('sn-filter-custom');
  if (isTime) {
    timeRange.hidden = false;
    valueWrap.hidden = true;
    customWrap.hidden = true;
    $('sn-tg-from').value = snifferTelegramTimeFilter.from ? snifferEpochToDatetimeLocal(snifferTelegramTimeFilter.from) : '';
    $('sn-tg-to').value = snifferTelegramTimeFilter.to ? snifferEpochToDatetimeLocal(snifferTelegramTimeFilter.to) : '';
    // Reflect an active range on the funnel icon (badge with "from..to").
    setSnifferFilterIndicator(icon);
    return;
  }
  timeRange.hidden = true;
  valueWrap.hidden = false;
  customWrap.hidden = false;

  // Build the value checkboxes from the current rows.
  const rows = snifferTableData[table] || [];
  const present = new Map();
  rows.forEach((row) => {
    const v = row[field];
    if (v === undefined || v === null) return;
    const key = String(v);
    if (!present.has(key)) present.set(key, { label: field === 'crcOk' ? (v ? '✓' : '✗') : (field === 'direction' ? snifferDir(v) : key), raw: key });
  });
  const active = (snifferFilters[table] && snifferFilters[table][field]) || [];
  const container = $('sn-filter-values');
  container.innerHTML = '';
  Array.from(present.values())
    .sort((a, b) => a.raw.localeCompare(b.raw, undefined, { numeric: true }))
    .forEach((entry) => {
      const checked = active.includes(entry.raw);
      const label = document.createElement('label');
      label.className = 'sn-filter-value';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = checked;
      cb.dataset.value = entry.raw;
      cb.addEventListener('change', () => {
        let vals = (snifferFilters[table] && snifferFilters[table][field]) || [];
        if (cb.checked) { if (!vals.includes(entry.raw)) vals.push(entry.raw); }
        else vals = vals.filter((v) => v !== entry.raw);
        snifferFilters[table] = snifferFilters[table] || {};
        snifferFilters[table][field] = vals;
        setSnifferFilterIndicator(icon);
        snifferRefreshRender();
      });
      const span = document.createElement('span');
      span.className = 'snfv-label';
      span.textContent = entry.label;
      label.appendChild(cb); label.appendChild(span);
      container.appendChild(label);
    });
  if (!container.children.length) {
    container.innerHTML = '<div class="sn-muted">' + t('sniffer_filter_no_values') + '</div>';
  }
}
function hideSnifferFilterPopup() {
  const popup = $('sn-filter-popup');
  if (popup) popup.hidden = true;
  snFilterPopupIcon = null;
}
function applySnifferCustomFilter() {
  if (!snFilterPopupIcon) return;
  const field = snFilterPopupIcon.getAttribute('data-snf');
  const table = tableNameFor(snFilterPopupIcon);
  if (!table || !field) return;
  const val = $('sn-filter-custom').value.trim();
  if (!val) return;
  let vals = (snifferFilters[table] && snifferFilters[table][field]) || [];
  if (!vals.includes(val)) vals.push(val);
  snifferFilters[table] = snifferFilters[table] || {};
  snifferFilters[table][field] = vals;
  setSnifferFilterIndicator(snFilterPopupIcon);
  snifferRefreshRender();
  hideSnifferFilterPopup();
}
function clearSnifferFilter() {
  if (!snFilterPopupIcon) return;
  const field = snFilterPopupIcon.getAttribute('data-snf');
  const table = tableNameFor(snFilterPopupIcon);
  // The timestamp funnel clears the server-side TIME RANGE, not a value list.
  if (field === 'timestamp') {
    if (snifferTelegramTimeFilter.from != null || snifferTelegramTimeFilter.to != null) {
      clearSnifferTelegramTimeFilter();
    }
    hideSnifferFilterPopup();
    return;
  }
  if (table && field && snifferFilters[table]) delete snifferFilters[table][field];
  setSnifferFilterIndicator(snFilterPopupIcon);
  snifferRefreshRender();
  hideSnifferFilterPopup();
}
// Human-readable (translated) label for a filter field: maps the raw column
// key to its i18n key; falls back to the raw key when unknown.
const SNIFFER_FILTER_FIELD_I18N = {
  timestamp: 'sniffer_time', direction: 'sniffer_dir', slaveId: 'sniffer_slave',
  functionName: 'sniffer_func', address: 'sniffer_addr', length: 'sniffer_len',
  rawHex: 'sniffer_data', crcOk: 'sniffer_crc', firstSeen: 'sniffer_first_seen',
  lastSeen: 'sniffer_last_seen', requestCount: 'sniffer_reqs', responseCount: 'sniffer_resps',
  errorCount: 'sniffer_errors', lastFunction: 'sniffer_last_func', rawValue: 'sniffer_raw_value',
  value: 'sniffer_interp_value', converter: 'sniffer_converter', uom: 'sniffer_uom',
};
function snifferFilterFieldLabel(field) {
  const key = SNIFFER_FILTER_FIELD_I18N[field];
  return key ? t(key) : field;
}
// Multi-select match: row passes when ANY selected value matches (OR).
function snifferFilterValue(row, field, needles) {
  if (!Array.isArray(needles) || needles.length === 0) return true;
  const raw = row[field];
  const hay = raw === undefined || raw === null ? '' : String(raw);
  const h = hay.toLowerCase();
  for (const needle of needles) {
    const n = String(needle).toLowerCase();
    if (n === '') continue;
    // Boolean fields (CRC): accept true/false/yes/no/ok/bad plus glyphs.
    if (field === 'crcOk' || typeof raw === 'boolean') {
      const b = raw === true || raw === 1 || String(raw) === 'true';
      if (n === 'true' || n === 'yes' || n === 'ok' || n === '✓' || n === '1') { if (b) return true; continue; }
      if (n === 'false' || n === 'no' || n === 'bad' || n === '✗' || n === '0') { if (!b) return true; continue; }
    }
    // Direction accepts short forms.
    if (field === 'direction') {
      if ((n === 'req' || n === 'request' || n === '→' || n === '>') && (h.startsWith('req') || h === '→')) return true;
      if ((n === 'res' || n === 'response' || n === '←' || n === '<') && (h.startsWith('res') || h === '←')) return true;
    }
    // Numeric fields: exact match.
    if (field === 'slaveId' || field === 'address' || field === 'length' ||
        field === 'requestCount' || field === 'responseCount' || field === 'errorCount') {
      if (hay.trim() === n) return true;
      continue;
    }
    if (h.includes(n)) return true;
  }
  return false;
}
function applySnifferFilters(rows, table) {
  const filters = snifferFilters[table];
  if (!filters || !Object.keys(filters).length) return rows;
  return rows.filter((row) => {
    return Object.entries(filters).every(([field, needles]) => snifferFilterValue(row, field, needles));
  });
}
/* Re-render the tables from the cached data (used by filter changes). */
function snifferRefreshRender() {
  renderSnifferTelegrams(snifferTableData.telegrams);
  renderSnifferDevices(snifferTableData.devices);
  renderSnifferRegisters(snifferTableData.registers);
}

/* ---------------- sniffer clear database ---------------- */
async function snifferClearDatabase() {
  if (snifferBusId == null) return;
  if (!confirm(t('sniffer_clear_db_confirm'))) return;
  try {
    await api('/api/sniffer/reset?busid=' + snifferBusId, { method: 'POST' });
    toast(t('sniffer_clear_db_done'), 'success');
    snifferRefresh();
    refreshSnifferEyeStates();
  } catch (e) {
    toast(t('err_sniffer_clear_db') + (e && e.message ? e.message : e), 'error');
  }
}

// Convert the raw converter string ("number", "number * 0.1", "select", …)
// to the localized label: the type name is translated via t('conv_<type>'),
// parameters (multiplier/offset) stay numeric and language-neutral.
function snifferConverterLabel(raw) {
  if (!raw) return raw || '';
  const rawStr = String(raw);
  const m = /^([a-z]+)(.*)$/i.exec(rawStr);
  if (m) {
    const type = m[1].toLowerCase();
    const tx = t('conv_' + type);
    if (tx && tx !== 'conv_' + type) return tx + m[2];
  }
  return rawStr;
}
/* ---------------- sniffer register annotation (pencil) + template ---------------- */
function templatesForSniffer() {
  // All available specs (already in state.specs from the main load).
  return (state.specs || []).slice();
}
// Client-side cache of per-slave template assignments stored in the sniffer
// database (for slaves that are NOT configured in the bus). key: busId -> slaveId -> spec filename
let snifferSlaveTemplateCache = {};
function getSlaveTemplateId(slaveId) {
  if (snifferBusId == null) return ''; // bus 0 is a VALID id (0 is falsy!)
  const bus = (state.busses || []).find((b) => b.busId === snifferBusId);
  if (bus) {
    const slave = (bus.slaves || []).find((s) => s.slaveid === slaveId);
    if (slave && slave.specificationid) return slave.specificationid;
  }
  return (snifferSlaveTemplateCache[snifferBusId] && snifferSlaveTemplateCache[snifferBusId][slaveId]) || '';
}
function snifferAnnotateConverterFromText(text) {
  // Parses the legacy free-text converter ("0.1", "number * 0.1", "value / 10",
  // "number * 2 + 5") back into structured fields for the editor.
  const out = { type: 'number', multiplier: '', offset: '', decimals: '', raw: text || '' };
  if (!text) return out;
  // "text" / "value" / "select" keywords survive as the converter type.
  const m = /^(text|value|select|binary)\b/i.exec(text);
  if (m) out.type = m[1].toLowerCase();
  const low = text.toLowerCase().replace(/,/g, '.');
  const mult = /\*\s*([0-9]+(?:\.[0-9]+)?)/.exec(low) || /^([0-9]+(?:\.[0-9]+)?)\s*\*?\s*$/.exec(low);
  if (mult) out.multiplier = mult[1];
  const div = /(\/|:)\s*([0-9]+(?:\.[0-9]+)?)/.exec(low);
  if (div) { out.multiplier = ''; out.divisor = div[2]; }
  const off = /([+-])\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(low);
  if (off && !/(\*|\/|:)\s*[0-9.]+\s*$/.test(low)) out.offset = (off[1] === '-' ? '-' : '') + off[2];
  const dec = /decimals?\s*[:=]\s*([0-9]+)/.exec(text);
  if (dec) out.decimals = dec[1];
  return out;
}
function snifferAnnotateConverterToText(f) {
  // Structured editor fields -> legacy free-text converter string understood by
  // the backend parser (multiplier/divisor/offset). Returns '' when nothing
  // meaningful was configured.
  const type = (f.type || 'number').toLowerCase();
  if (type !== 'number') return type;
  const mult = parseFloat(f.multiplier);
  const off = parseFloat(f.offset);
  const dec = parseFloat(f.decimals);
  let s = '';
  if (!Number.isNaN(mult) && mult !== 0 && mult !== 1) s = 'number * ' + mult;
  else if (!Number.isNaN(dec) && dec > 0) s = 'number * ' + (1 / dec);
  if (s && !Number.isNaN(off) && off !== 0) s += (off > 0 ? ' + ' : ' - ') + Math.abs(off);
  return s;
}
function openSnifferAnnotate(target) {
  snifferAnnotateTarget = target;
  $('sn-annotate-slave').value = '#' + target.slaveId;
  // Template combo: preselect the slave's current template, if any
  // (displayed as its localized name; saved back as the spec filename).
  const tpl = $('sn-annotate-template-search');
  const current = getSlaveTemplateId(target.slaveId) || '';
  tpl.value = current ? getSlaveTemplateName(current) : '';
  $('sn-annotate-template-drop').hidden = true;
  $('sn-annotate-description').value = target.description || '';
  // Show the LOCALIZED description when a template entity backs this row (the
  // table itself also renders it translated; keep the editor consistent).
  if (target.specKey && target.entityId != null && !target.annotated) {
    const spec = (state.specs || []).find((s) => s.filename === target.specKey);
    if (spec) {
      const tx = getSpecificationText(spec, 'e' + target.entityId);
      if (tx) $('sn-annotate-description').value = tx;
    }
  }
  // Converter fields: prefer the template's structured parameters when the
  // row came from a template (so e.g. multiplier 0.1 shows up instead of
  // just "number"). Manual rows fall back to parsing the free-text converter.
  let cf;
  if (target.converterParameters && (target.converterParameters.multiplier != null || target.converterParameters.offset != null || target.converterParameters.decimals != null)) {
    const cp = target.converterParameters;
    cf = {
      type: /^text$/i.test(target.converter || '') ? 'text'
        : /^select$/i.test(target.converter || '') ? 'select'
        : /^binary$/i.test(target.converter || '') ? 'binary'
        : /^value$/i.test(target.converter || '') ? 'value'
        : 'number',
      multiplier: cp.multiplier != null ? String(cp.multiplier) : '',
      offset: cp.offset != null ? String(cp.offset) : '',
      decimals: cp.decimals != null ? String(cp.decimals) : '',
    };
  } else {
    cf = snifferAnnotateConverterFromText(target.converter);
  }
  const typeSel = $('sn-annotate-converter-type');
  typeSel.value = cf.type;
  $('sn-annotate-multiplier').value = cf.multiplier || '';
  $('sn-annotate-offset').value = cf.offset || '';
  $('sn-annotate-decimals').value = cf.decimals || '';
  snifferAnnotateConvShown();
  $('sn-annotate-uom').value = target.uom || '';
  $('sn-annotate-overlay').hidden = false;
}
function snifferAnnotateConvShown() {
  const num = $('sn-annotate-conv-num');
  if (!num) return;
  num.hidden = ($('sn-annotate-converter-type').value !== 'number');
}
function closeSnifferAnnotate() {
  snifferAnnotateTarget = null;
  $('sn-annotate-overlay').hidden = true;
}
/* Template combo inside the annotate dialog: same look & feel as the
   other template pickers (search input + dropdown list). */
function initSnifferAnnotateTemplateCombo() {
  const input = $('sn-annotate-template-search');
  const list = $('sn-annotate-template-list');
  const drop = $('sn-annotate-template-drop');
  if (!input || !list || !drop) return;
  const renderList = () => {
    list.innerHTML = templatesForSniffer().map((sp) => {
      const tplName = getSpecificationText(sp, 'name') || sp.model || sp.filename;
      return '<li data-tpl="' + escapeHtml(sp.filename) + '" data-model="' + escapeHtml(sp.model || '') + '" data-manufacturer="' + escapeHtml(sp.manufacturer || '') + '">' +
        '<span class="eep-code">' + escapeHtml(sp.filename) + '</span>' +
        '<span class="eep-name">' + escapeHtml(tplName) + (sp.manufacturer ? ' · ' + escapeHtml(sp.manufacturer) : '') + '</span></li>';
    }).join('');
  };
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
  const selectLi = (li) => {
    input.value = li.getAttribute('data-model') || li.getAttribute('data-tpl');
    drop.hidden = true;
    filter = input.value;
  };
  renderList();
  // When the dialog opens, the input is prefilled with the current template:
  // on first focus show the full list anyway (empty filter), matching the
  // other combos.
  input.addEventListener('focus', () => { filter = ''; render(); drop.hidden = false; });
  input.addEventListener('input', () => { filter = input.value; render(); drop.hidden = false; });
  input.addEventListener('blur', () => setTimeout(() => { drop.hidden = true; }, 150));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); const c = list.querySelector('li:not([hidden])'); if (c) c.focus(); }
    else if (e.key === 'Escape') drop.hidden = true;
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-tpl]');
    if (!li) return;
    e.preventDefault();
    selectLi(li);
  });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-tpl]');
    if (!li) return;
    selectLi(li);
  });
  list.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const li = e.target.closest('li[data-tpl]'); if (li) selectLi(li); }
  });
}
async function saveSnifferAnnotate() {
  if (!snifferAnnotateTarget) return;
  const tgt = snifferAnnotateTarget;
  const description = $('sn-annotate-description').value.trim();
  const converter = snifferAnnotateConverterToText({
    type: $('sn-annotate-converter-type').value,
    multiplier: $('sn-annotate-multiplier').value.trim(),
    offset: $('sn-annotate-offset').value.trim(),
    decimals: $('sn-annotate-decimals').value.trim(),
  });
  const uom = $('sn-annotate-uom').value.trim();
  // Resolve the search input (name / model / filename) back to the spec.
  const templateResolved = resolveTemplate($('sn-annotate-template-search').value);
  const template = templateResolved ? templateResolved.filename : '';
  try {
    // Template assignment (optional): changing it re-interprets via the spec.
    if (template) {
      await api('/api/sniffer/registers/template', {
        method: 'POST',
        body: JSON.stringify({ busId: tgt.busId, slaveId: tgt.slaveId, specificationid: template })
      });
    } else if (!templateResolved && $('sn-annotate-template-search').value.trim() && getSlaveTemplateId(tgt.slaveId)) {
      // User typed something unresolvable into the template field: keep the
      // current assignment instead of wiping it silently.
      toast(t('sniffer_template_not_found'), 'error');
      return;
    } else if (template === '' && getSlaveTemplateId(tgt.slaveId)) {
      // User explicitly emptied the field: detach.
      await api('/api/sniffer/registers/template', {
        method: 'POST',
        body: JSON.stringify({ busId: tgt.busId, slaveId: tgt.slaveId, specificationid: '' })
      });
    }
    // Converter annotation (only when a template was not assigned: the UI
    // keeps both fields, but a template takes precedence server-side).
    if (converter || uom) {
      await api('/api/sniffer/registers/annotation', {
        method: 'POST',
        body: JSON.stringify({ busId: tgt.busId, slaveId: tgt.slaveId, address: tgt.address, converter, uom, description })
      });
    }
    closeSnifferAnnotate();
    toast(t('sniffer_saved'), 'success');
    await loadSnifferSlaveTemplates();
    await snifferRefresh();
    await loadAll(); // bus list template names + slave-ids refreshed
  } catch (e) {
    toast(t('err_sniffer_annotate') + (e && e.message ? e.message : e), 'error');
  }
}

function bindSnifferTrendButtons() {
  document.querySelectorAll('.sn-trend-btn').forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      snifferTrend = {
        busId: Number(btn.getAttribute('data-busid')),
        slaveId: Number(btn.getAttribute('data-slaveid')),
        address: Number(btn.getAttribute('data-address')),
        title: btn.getAttribute('data-title') || ('Register ' + btn.getAttribute('data-address')),
        uom: btn.getAttribute('data-uom') || '',
      };
      openSnifferTrend();
    });
  });
}
/* ---------------- sniffer value trend (SVG chart popup) ---------------- */
// Chart state
let snifferTrendView = null; // { from, to } visible window (epoch seconds)
let snifferTrendData = [];   // [{ t, v }] chronological
let snifferTrendDrag = null; // { startX, from, to }

function openSnifferTrend() {
  if (!snifferTrend) return;
  $('sn-trend-title').textContent = snifferTrend.title + (snifferTrend.uom ? ' — ' + snifferTrend.uom : '');
  $('sn-trend-overlay').hidden = false;
  const body = $('sn-trend-body');
  body.innerHTML = '<div class="sn-trend-loading">' + t('sniffer_trend_loading') + '</div>';
  snifferTrendView = null;
  snifferTrendData = [];
  snifferLoadTrend();
}
function closeSnifferTrend() {
  $('sn-trend-overlay').hidden = true;
  snifferTrend = null;
  snifferTrendView = null;
  snifferTrendData = [];
}
async function snifferLoadTrend() {
  const tr = snifferTrend;
  if (!tr) return;
  const body = $('sn-trend-body');
  try {
    const rows = await api('/api/sniffer/registers/history?busid=' + tr.busId + '&slaveid=' + tr.slaveId + '&address=' + tr.address + '&limit=2000');
    if (!snifferTrend || snifferTrend !== tr) return;
    // rows are newest-first from the backend; chart wants chronological.
    const pts = (rows || [])
      .map((r) => ({ t: r.timestamp, v: r.values && r.values.length ? r.values[0] : NaN }))
      .filter((pt) => !Number.isNaN(pt.v))
      .reverse();
    snifferTrendData = pts;
    if (!pts.length) {
      body.innerHTML = '<div class="sn-trend-empty">' + t('sniffer_trend_no_data') + '</div>';
      return;
    }
    snifferTrendView = { from: pts[0].t, to: pts[pts.length - 1].t };
    snifferRenderTrend();
  } catch (e) {
    body.innerHTML = '<div class="sn-trend-empty">' + t('err_load') + '</div>';
  }
}
function snifferTrendYRange() {
  const v = snifferTrendView;
  const vis = snifferTrendData.filter((p) => p.t >= v.from && p.t <= v.to);
  let lo = Infinity, hi = -Infinity;
  for (const p of vis) { if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v; }
  if (!vis.length) { lo = 0; hi = 1; }
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08;
  return { lo: lo - pad, hi: hi + pad };
}
function snifferRenderTrend() {
  const body = $('sn-trend-body');
  if (!body || !snifferTrendView || !snifferTrendData.length) return;
  const v = snifferTrendView;
  const W = 860, H = 340, padL = 56, padR = 16, padT = 26, padB = 32;
  const yr = snifferTrendYRange();
  const x = (t) => padL + ((t - v.from) / (v.to - v.from || 1)) * (W - padL - padR);
  const y = (val) => padT + (1 - (val - yr.lo) / (yr.hi - yr.lo || 1)) * (H - padT - padB);
  const vis = snifferTrendData.filter((p) => p.t >= v.from && p.t <= v.to);
  const line = vis.map((p) => x(p.t).toFixed(1) + ',' + y(p.v).toFixed(1)).join(' ');
  const area = (vis.length ? x(vis[0].t).toFixed(1) + ',' + (H - padB) + ' ' : '') + line +
    (vis.length ? ' ' + x(vis[vis.length - 1].t).toFixed(1) + ',' + (H - padB) : '');
  // Grid
  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const gy = yr.lo + ((yr.hi - yr.lo) * i) / 4;
    grid += '<line class="sn-trend-grid" x1="' + padL + '" y1="' + y(gy).toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y(gy).toFixed(1) + '"/>' +
      '<text class="sn-trend-tick" x="' + (padL - 6) + '" y="' + (y(gy) + 3).toFixed(1) + '" text-anchor="end">' + snifferTrendFmtY(gy) + '</text>';
  }
  for (let i = 0; i <= 5; i++) {
    const gx = v.from + ((v.to - v.from) * i) / 5;
    grid += '<line class="sn-trend-grid" x1="' + x(gx).toFixed(1) + '" y1="' + padT + '" x2="' + x(gx).toFixed(1) + '" y2="' + (H - padB) + '"/>' +
      '<text class="sn-trend-tick" x="' + x(gx).toFixed(1) + '" y="' + (H - padB + 15) + '" text-anchor="middle">' + snifferTrendFmtX(gx) + '</text>';
  }
  body.innerHTML =
    '<svg id="sn-trend-svg" viewBox="0 0 ' + W + ' ' + H + '" class="sn-trend-svg" preserveAspectRatio="xMidYMid meet">' +
    grid +
    (vis.length ? '<polygon class="sn-trend-area" points="' + area + '"/>' : '') +
    (vis.length ? '<polyline class="sn-trend-line" points="' + line + '"/>' : '') +
    '</svg>' +
    '<div class="sn-trend-range">' +
      '<span>' + snifferTrendFmtX(v.from) + '</span><span>→</span><span>' + snifferTrendFmtX(v.to) + '</span>' +
      '<span> · ' + snifferTrendData.length + ' ' + t('sniffer_trend_points') + '</span>' +
    '</div>';
  bindSnifferTrendSvg();
}
function snifferTrendFmtY(val) {
  return Number.isInteger(val) ? String(val) : val.toFixed(2);
}
function snifferTrendFmtX(t) {
  const d = new Date(t * 1000);
  const p = (n) => String(n).padStart(2, '0');
  const span = (snifferTrendView ? snifferTrendView.to - snifferTrendView.from : 0);
  if (span > 6 * 3600) {
    return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function bindSnifferTrendSvg() {
  const svg = $('sn-trend-svg');
  if (!svg) return;
  const W = 860, H = 340, padL = 56, padR = 16;
  const tFromX = (px) => {
    const v = snifferTrendView;
    const frac = (px - padL) / (W - padL - padR);
    return v.from + frac * (v.to - v.from);
  };
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (W / rect.width);
    const t0 = tFromX(px);
    const v = snifferTrendView;
    const factor = e.deltaY > 0 ? 1.25 : 0.8;
    const span = (v.to - v.from) * factor;
    const frac = (t0 - v.from) / (v.to - v.from || 1);
    let nf = t0 - span * frac;
    let nt = nf + span;
    const minT = snifferTrendData[0].t;
    const maxT = snifferTrendData[snifferTrendData.length - 1].t;
    if (nf < minT) { nf = minT; nt = nf + span; }
    if (nt > maxT) { nt = maxT; nf = nt - span; }
    snifferTrendView = { from: nf, to: nt };
    snifferRenderTrend();
  }, { passive: false });
  svg.addEventListener('mousedown', (e) => {
    snifferTrendDrag = { startX: e.clientX, from: snifferTrendView.from, to: snifferTrendView.to };
    svg.classList.add('sn-dragging');
  });
  window.addEventListener('mousemove', (e) => {
    if (!snifferTrendDrag) return;
    const rect = svg.getBoundingClientRect();
    const spanT = snifferTrendView.to - snifferTrendView.from;
    const pxSpan = W - padL - padR;
    const dt = ((e.clientX - snifferTrendDrag.startX) * spanT) / pxSpan;
    snifferTrendView = { from: snifferTrendDrag.from - dt, to: snifferTrendDrag.to - dt };
    snifferRenderTrend();
  });
  window.addEventListener('mouseup', () => {
    if (snifferTrendDrag) {
      snifferTrendDrag = null;
      svg.classList.remove('sn-dragging');
    }
  });
}
function snifferTrendResize() {
  if (!snifferTrendView) return;
  const minT = snifferTrendData[0].t;
  const maxT = snifferTrendData[snifferTrendData.length - 1].t;
  snifferTrendView = { from: minT, to: maxT };
  snifferRenderTrend();
}
function snifferTrendPreset(sec) {
  if (!snifferTrendView || !snifferTrendData.length) return;
  const maxT = snifferTrendData[snifferTrendData.length - 1].t;
  const minT = snifferTrendData[0].t;
  snifferTrendView = { from: Math.max(minT, maxT - sec), to: maxT };
  snifferRenderTrend();
}

function bindSnifferPencils() {
  document.querySelectorAll('.sn-pencil').forEach((btn) => {
    // Re-bind only fresh buttons (they are re-created on every render).
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const cpm = btn.getAttribute('data-cp-multiplier');
      const cpo = btn.getAttribute('data-cp-offset');
      const cpd = btn.getAttribute('data-cp-decimals');
      const target = {
        busId: Number(btn.getAttribute('data-busid')),
        slaveId: Number(btn.getAttribute('data-slaveid')),
        address: Number(btn.getAttribute('data-address')),
        converter: btn.getAttribute('data-converter') || '',
        uom: btn.getAttribute('data-uom') || '',
        description: btn.getAttribute('data-description') || '',
        specKey: btn.getAttribute('data-speckey') || '',
        entityId: btn.getAttribute('data-entityid') !== '' ? btn.getAttribute('data-entityid') : undefined,
        converterParameters: (cpm !== null || cpo !== null || cpd !== null)
          ? { multiplier: cpm !== '' ? Number(cpm) : undefined, offset: cpo !== '' ? Number(cpo) : undefined, decimals: cpd !== '' ? Number(cpd) : undefined }
          : undefined
      };
      openSnifferAnnotate(target);
    });
  });
}

/* ---------------- telegram time-range filter ---------------- */
function snifferTgDatetimeToEpoch(v) {
  // datetime-local "YYYY-MM-DDTHH:mm" -> epoch seconds (local time).
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}
function snifferEpochToDatetimeLocal(epoch) {
  // epoch seconds -> "YYYY-MM-DDTHH:mm" in the LOCAL timezone (datetime-local).
  if (epoch == null) return '';
  const d = new Date(epoch * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function applySnifferTelegramTimeFilter() {
  snifferTelegramTimeFilter.from = snifferTgDatetimeToEpoch($('sn-tg-from').value);
  snifferTelegramTimeFilter.to = snifferTgDatetimeToEpoch($('sn-tg-to').value);
  // Update the funnel icon in the Time column header (badge with active range).
  document.querySelectorAll('.sn-filter-ico[data-snf="timestamp"]').forEach((ico) => setSnifferFilterIndicator(ico));
  snifferRefresh();
}
function clearSnifferTelegramTimeFilter() {
  snifferTelegramTimeFilter = { from: null, to: null };
  $('sn-tg-from').value = '';
  $('sn-tg-to').value = '';
  document.querySelectorAll('.sn-filter-ico[data-snf="timestamp"]').forEach((ico) => setSnifferFilterIndicator(ico));
  snifferRefresh();
}
function bindSnifferTelegramTimeFilter() {
  $('sn-tg-apply')?.addEventListener('click', () => { applySnifferTelegramTimeFilter(); hideSnifferFilterPopup(); });
  $('sn-tg-clear')?.addEventListener('click', () => { clearSnifferTelegramTimeFilter(); hideSnifferFilterPopup(); });
}

async function loadSnifferSlaveTemplates() {
  if (snifferBusId == null) return;
  try {
    const res = await api('/api/sniffer/slave-templates?busid=' + snifferBusId);
    const map = {};
    (res || []).forEach((t) => { map[t.slaveId] = t.specificationid; });
    snifferSlaveTemplateCache[snifferBusId] = map;
  } catch (e) { /* non-fatal */ }
}
async function snifferRefresh() {
  if (snifferBusId == null) return;
  const bid = snifferBusId;
  try {
    const stateRes = await api('/api/sniffer/state?busid=' + bid);
    if (snifferBusId !== bid) return; // closed/changed meanwhile
    snifferState = stateRes;
    const running = stateRes && stateRes.running;
    const badge = $('sn-status-badge');
    const textEl = $('sn-status-text');
    if (running) {
      badge.className = 'sniffer-running-badge';
      textEl.textContent = t('sniffer_running');
    } else if (stateRes && stateRes.error) {
      badge.className = 'sniffer-error-badge';
      textEl.textContent = t('sniffer_stopped');
    } else {
      badge.className = 'sniffer-stopped-badge';
      textEl.textContent = t('sniffer_stopped');
    }
    const extra = $('sn-status-extra');
    if (stateRes && stateRes.error) {
      extra.textContent = stateRes.error;
      extra.style.color = 'var(--danger, #b22222)';
    } else if (running && stateRes.telegramCount != null) {
      extra.textContent = stateRes.telegramCount + ' ' + t('sniffer_telegrams').toLowerCase();
      extra.style.color = '';
    } else {
      // Keep showing the DB totals even when stopped.
      const n = (snifferTableData.telegrams || []).length;
      extra.textContent = n > 0 ? (t('sniffer_stored') + ': ' + n) : '';
      extra.style.color = '';
    }
    $('sn-start').hidden = running;
    $('sn-stop').hidden = !running;

    // Always load from the database, running or not. The live telegram table
    // is server-side paged: we request one page and remember the total.
    // Optional time-range filter (from/to as epoch seconds) narrows the
    // history; a page size of 0 means "everything" (legacy behavior).
    const tgFrom = snifferTelegramTimeFilter.from;
    const tgTo = snifferTelegramTimeFilter.to;
    let tgUrl = '/api/sniffer/telegrams?busid=' + bid;
    const pageSize = snifferTelegramPageSize > 0 ? snifferTelegramPageSize : 0;
    if (pageSize > 0) {
      tgUrl += '&limit=' + pageSize + '&offset=' + ((snifferTelegramPage - 1) * pageSize);
    } else {
      tgUrl += '&limit=2000';
    }
    if (tgFrom != null) tgUrl += '&from=' + tgFrom;
    if (tgTo != null) tgUrl += '&to=' + tgTo;
    const [tgRes, devs, regs] = await Promise.all([
      api(tgUrl),
      api('/api/sniffer/devices?busid=' + bid),
      api('/api/sniffer/registers?busid=' + bid)
    ]);
    if (snifferBusId !== bid) return;
    const tgs = Array.isArray(tgRes) ? tgRes : ((tgRes && tgRes.rows) || []);
    const tgTotal = Array.isArray(tgRes) ? tgs.length : ((tgRes && tgRes.total) || tgs.length);
    snifferTableData = { telegrams: tgs, telegramsTotal: tgTotal, devices: devs || [], registers: regs || [] };
    snifferRefreshRender();
    renderSnifferPager('telegram', tgs.length, tgTotal, snifferTelegramPage, snifferTelegramPageSize);
    bindSnifferPencils();
    bindSnifferTrendButtons();
  } catch (e) {
    // transient — keep polling/live updates
  }
}

/* ---------------- sniffer pager ---------------- */
// Renders a prev/next + page-info control into #sn-<key>-pager.
// `key` is one of 'telegram' | 'history' | 'device' | 'register'.
function renderSnifferPager(key, onPage, total, page, pageSize) {
  const el = $('sn-' + key + '-pager');
  if (!el) return;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const hasMany = total > pageSize;
  el.hidden = !hasMany;
  if (!hasMany) { el.innerHTML = ''; return; }
  const from = total === 0 ? 0 : ((page - 1) * pageSize) + 1;
  const to = Math.min(total, page * pageSize);
  el.innerHTML =
    '<button data-act="first" ' + (page <= 1 ? 'disabled' : '') + '>«</button>' +
    '<button data-act="prev" ' + (page <= 1 ? 'disabled' : '') + '>‹</button>' +
    '<span class="sn-pager-page">' + from + '–' + to + ' / ' + total + '</span>' +
    '<button data-act="next" ' + (page >= pages ? 'disabled' : '') + '>›</button>' +
    '<button data-act="last" ' + (page >= pages ? 'disabled' : '') + '>»</button>';
  el.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      const act = b.getAttribute('data-act');
      let np = page;
      if (act === 'first') np = 1;
      else if (act === 'prev') np = page - 1;
      else if (act === 'next') np = page + 1;
      else if (act === 'last') np = pages;
      np = Math.min(Math.max(1, np), pages);
      if (np === page) return;
      if (key === 'telegram') { snifferTelegramPage = np; snifferRefresh(); }
      else if (key === 'history') { snifferHistoryPage = np; snifferLoadHistory(); }
      else if (key === 'device') { snifferDevicePage = np; renderSnifferDevices(snifferTableData.devices); }
      else if (key === 'register') { snifferRegisterPage = np; renderSnifferRegisters(snifferTableData.registers); }
    });
  });
}

/* ---------------- sniffer history (server-side paged) ---------------- */
async function snifferLoadHistory() {
  if (snifferBusId == null) return;
  const bid = snifferBusId;
  const body = $('sn-history-body');
  if (body) body.innerHTML = '<tr><td colspan="8" class="sniffer-empty">' + t('sniffer_loading') + '</td></tr>';
  try {
    const size = snifferHistoryPageSize || 100;
    let url = '/api/sniffer/telegrams?busid=' + bid + '&limit=' + size + '&offset=' + ((snifferHistoryPage - 1) * size);
    if (snifferHistoryFilter.from != null) url += '&from=' + snifferHistoryFilter.from;
    if (snifferHistoryFilter.to != null) url += '&to=' + snifferHistoryFilter.to;
    const res = await api(url);
    if (snifferBusId !== bid) return;
    const rows = (res && res.rows) || [];
    const total = (res && res.total) || rows.length;
    renderSnifferHistory(rows);
    renderSnifferPager('history', rows.length, total, snifferHistoryPage, size);
  } catch (e) {
    if (body) body.innerHTML = '<tr><td colspan="8" class="sniffer-empty">' + t('err_load') + '</td></tr>';
  }
}
function renderSnifferHistory(rows) {
  const body = $('sn-history-body');
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="8" class="sniffer-empty">' + t('sniffer_no_telegrams') + '</td></tr>';
    return;
  }
  body.innerHTML = rows.map((tg) => {
    const crcOk = tg.crcOk === undefined ? '' : (tg.crcOk ? '✓' : '✗');
    const cls = tg.crcOk === false ? ' class="sniffer-crc-bad"' : '';
    return '<tr' + cls + '><td>' + snifferFullTime(tg.timestamp) + '</td>' +
      '<td class="sniffer-mono">' + snifferDir(tg.direction) + '</td>' +
      '<td>' + (tg.slaveId ?? '') + '</td>' +
      '<td>' + escapeHtml(tg.functionName || ('0x' + Number(tg.functionCode).toString(16))) + '</td>' +
      '<td>' + (tg.address ?? '') + '</td>' +
      '<td>' + (tg.length ?? '') + '</td>' +
      '<td class="sniffer-mono">' + snifferHexRow(tg.rawHex) + '</td>' +
      '<td>' + crcOk + '</td></tr>';
  }).join('');
}
function snifferFullTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function applySnifferHistoryFilter() {
  snifferHistoryFilter.from = snifferTgDatetimeToEpoch($('sn-his-from').value);
  snifferHistoryFilter.to = snifferTgDatetimeToEpoch($('sn-his-to').value);
  snifferHistoryPage = 1;
  snifferLoadHistory();
}
function clearSnifferHistoryFilter() {
  snifferHistoryFilter = { from: null, to: null };
  $('sn-his-from').value = '';
  $('sn-his-to').value = '';
  snifferHistoryPage = 1;
  snifferLoadHistory();
}

function renderSnifferTelegrams(tgs) {
  const body = $('sn-telegram-body');
  if (!body) return;
  const filtered = applySnifferFilters(tgs, 'telegrams');
  if (!filtered.length) {
    body.innerHTML = '<tr><td colspan="8" class="sniffer-empty">' + t('sniffer_no_telegrams') + '</td></tr>';
    return;
  }
  body.innerHTML = filtered.map((tg) => {
    const crcOk = tg.crcOk === undefined ? '' : (tg.crcOk ? '✓' : '✗');
    const cls = tg.crcOk === false ? ' class="sniffer-crc-bad"' : '';
    return '<tr' + cls + '><td>' + snifferTime(tg.timestamp) + '</td>' +
      '<td class="sniffer-mono">' + snifferDir(tg.direction) + '</td>' +
      '<td>' + (tg.slaveId ?? '') + '</td>' +
      '<td>' + escapeHtml(tg.functionName || ('0x' + Number(tg.functionCode).toString(16))) + '</td>' +
      '<td>' + (tg.address ?? '') + '</td>' +
      '<td>' + (tg.length ?? '') + '</td>' +
      '<td class="sniffer-mono">' + snifferHexRow(tg.rawHex) + '</td>' +
      '<td>' + crcOk + '</td></tr>';
  }).join('');
}
function renderSnifferDevices(devs) {
  const body = $('sn-device-body');
  if (!body) return;
  const filtered = applySnifferFilters(devs, 'devices');
  if (!filtered.length) {
    body.innerHTML = '<tr><td colspan="7" class="sniffer-empty">' + t('sniffer_no_devices') + '</td></tr>';
    renderSnifferPager('device', 0, 0, 1, snifferDevicePageSize);
    return;
  }
  const pages = Math.max(1, Math.ceil(filtered.length / snifferDevicePageSize));
  if (snifferDevicePage > pages) snifferDevicePage = pages;
  const start = (snifferDevicePage - 1) * snifferDevicePageSize;
  const slice = filtered.slice(start, start + snifferDevicePageSize);
  body.innerHTML = slice.map((d) =>
    '<tr><td>' + d.slaveId + '</td><td>' + snifferTime(d.firstSeen) + '</td>' +
    '<td>' + snifferTime(d.lastSeen) + '</td><td>' + (d.requestCount ?? 0) + '</td>' +
    '<td>' + (d.responseCount ?? 0) + '</td><td>' + (d.errorCount ?? 0) + '</td>' +
    '<td>' + escapeHtml(d.lastFunction || '') + '</td></tr>'
  ).join('');
  renderSnifferPager('device', slice.length, filtered.length, snifferDevicePage, snifferDevicePageSize);
}
function renderSnifferRegisters(regs) {
  const body = $('sn-register-body');
  if (!body) return;
  const filtered = applySnifferFilters(regs, 'registers');
  if (!filtered.length) {
    body.innerHTML = '<tr><td colspan="8" class="sniffer-empty">' + t('sniffer_no_registers') + '</td></tr>';
    renderSnifferPager('register', 0, 0, 1, snifferRegisterPageSize);
    return;
  }
  const pages = Math.max(1, Math.ceil(filtered.length / snifferRegisterPageSize));
  if (snifferRegisterPage > pages) snifferRegisterPage = pages;
  const start = (snifferRegisterPage - 1) * snifferRegisterPageSize;
  const slice = filtered.slice(start, start + snifferRegisterPageSize);
  body.innerHTML = slice.map((r) => {
    const raw = escapeHtml(r.rawValue ?? (r.words || []).join(', '));
    const interp = r.value != null && r.value !== '' ? escapeHtml(String(r.value)) : '<span class="sn-muted">—</span>';
    const conv = r.converter ? escapeHtml(snifferConverterLabel(r.converter)) : '<span class="sn-muted">' + t('sniffer_no_template') + '</span>';
    const uom = r.uom ? escapeHtml(String(r.uom)) : '';
    // Description comes from the template entity, which has per-language
    // translations ("e<id>" textIds in the spec's i18n block). Translate it
    // like the template editor does; fall back to the raw value when no spec
    // or no translation exists.
    const desc = snifferRegisterDescription(r);
    const annotated = r.annotated ? ' <span class="sn-annotated-badge">' + t('sniffer_annotated') + '</span>' : '';
    const editTitle = t('sniffer_annotate');
    return '<tr>' +
      '<td>' + r.slaveId + '</td>' +
      '<td>' + r.address + '</td>' +
      '<td class="sniffer-mono">' + raw + '</td>' +
      '<td>' + conv + '</td>' +
      '<td class="sniff-interp">' + interp + annotated + '</td>' +
      '<td>' + uom + '</td>' +
      '<td>' + desc + '</td>' +
      '<td><button class="icon-btn sn-pencil" data-busid="' + r.busId + '" data-slaveid="' + r.slaveId +
        '" data-address="' + r.address + '" data-converter="' + escapeHtml(r.converter || '') + '" data-uom="' + escapeHtml(r.uom || '') + '" data-description="' + escapeHtml(r.description || '') +
        '" data-cp-multiplier="' + escapeHtml(r.converterParameters && r.converterParameters.multiplier != null ? String(r.converterParameters.multiplier) : '') +
        '" data-cp-offset="' + escapeHtml(r.converterParameters && r.converterParameters.offset != null ? String(r.converterParameters.offset) : '') +
        '" data-cp-decimals="' + escapeHtml(r.converterParameters && r.converterParameters.decimals != null ? String(r.converterParameters.decimals) : '') +
        '" data-speckey="' + escapeHtml(r.specKey || '') + '" data-entityid="' + escapeHtml(r.entityId != null ? String(r.entityId) : '') +
        '" title="' + editTitle + '">⚙</button>' +
      '<button class="icon-btn sn-trend-btn" data-busid="' + r.busId + '" data-slaveid="' + r.slaveId +
        '" data-address="' + r.address + '" data-title="' + escapeHtml(r.description || r.entityName || ('Register ' + r.address)) +
        '" data-uom="' + escapeHtml(r.uom || '') + '" title="' + t('sniffer_trend') + '">📈</button></td>' +
      '</tr>';
  }).join('');
  renderSnifferPager('register', slice.length, filtered.length, snifferRegisterPage, snifferRegisterPageSize);
}

// Resolve the localized register description from the template spec's i18n
// block. The backend ships the raw entity name in `description` plus the spec
// filename (specKey) and entity id (entityId); the UI language picks the
// matching translation ("e<entityId>"), falling back to en, then to the raw
// template name, then to whatever the row carries (manual annotation).
function snifferRegisterDescription(r) {
  if (r.description || r.entityName) {
    if (r.specKey && r.entityId != null) {
      const spec = (state.specs || []).find((s) => s.filename === r.specKey);
      if (spec) {
        const tx = getSpecificationText(spec, 'e' + r.entityId);
        if (tx) return escapeHtml(tx);
      }
    }
  }
  return r.description ? escapeHtml(String(r.description))
    : r.entityName ? escapeHtml(String(r.entityName))
    : '<span class="sn-muted">—</span>';
}

async function snifferStart() {
  if (snifferBusId == null) return;
  try {
    await snifferSaveConfig();
    await api('/api/sniffer/start?busid=' + snifferBusId, { method: 'POST' });
    toast(t('sniffer_started'), 'success');
    await snifferRefresh();
    refreshSnifferEyeStates();
  } catch (e) {
    toast(t('err_sniffer_start') + (e && e.message ? e.message : e), 'error');
  }
}
async function snifferStop() {
  if (snifferBusId == null) return;
  try {
    await api('/api/sniffer/stop?busid=' + snifferBusId, { method: 'POST' });
    toast(t('sniffer_stopped'), 'info');
    await snifferRefresh();
    refreshSnifferEyeStates();
  } catch (e) {
    toast(t('err_sniffer_stop') + (e && e.message ? e.message : e), 'error');
  }
}
async function snifferSaveConfig() {
  if (snifferBusId == null) return;
  // Config is fixed: mode is always 'stack' and the tap device is the bus's
  // own serial connection. Only the auto-start checkbox is user-settable.
  const body = {
    busId: snifferBusId,
    mode: 'stack',
    enabled: !!$('sn-enabled')?.checked
  };
  await api('/api/sniffer/config', { method: 'POST', body: JSON.stringify(body) });
}

/* Wire up sniffer modal controls (idempotent — app.js runs once) */
(function () {
  $('sn-start')?.addEventListener('click', snifferStart);
  $('sn-stop')?.addEventListener('click', snifferStop);
  $('sn-close')?.addEventListener('click', closeSniffer);
  $('sn-clear')?.addEventListener('click', snifferClearDatabase);
  $('sn-annotate-save')?.addEventListener('click', saveSnifferAnnotate);
  $('sn-annotate-cancel')?.addEventListener('click', closeSnifferAnnotate);
  $('sn-annotate-converter-type')?.addEventListener('change', snifferAnnotateConvShown);
  bindSnifferTelegramTimeFilter();
  initSnifferAnnotateTemplateCombo();
  $('sn-filter-apply')?.addEventListener('click', applySnifferCustomFilter);
  $('sn-filter-clear')?.addEventListener('click', clearSnifferFilter);
  $('sn-filter-custom')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') applySnifferCustomFilter(); });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#sn-filter-popup') && !e.target.closest('.sn-filter-ico')) hideSnifferFilterPopup();
  });
  document.querySelectorAll('.sniffer-tab-btn').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.sniffer-tab-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      const tab = b.getAttribute('data-sntab');
      document.querySelectorAll('.sniffer-tab-panel').forEach((p) => { p.hidden = (p.id !== 'sntab-' + tab); });
      if (tab === 'history') snifferLoadHistory();
      if (tab === 'telegrams') snifferRefresh();
    });
  });
  // History view: time filter + page size.
  $('sn-his-apply')?.addEventListener('click', applySnifferHistoryFilter);
  $('sn-his-clear')?.addEventListener('click', clearSnifferHistoryFilter);
  $('sn-his-size')?.addEventListener('change', (e) => {
    snifferHistoryPageSize = Number(e.target.value) || 100;
    snifferHistoryPage = 1;
    snifferLoadHistory();
  });
  // Trend popup.
  $('sn-trend-close')?.addEventListener('click', closeSnifferTrend);
  $('sn-trend-fit')?.addEventListener('click', snifferTrendResize);
  $('sn-trend-1h')?.addEventListener('click', () => snifferTrendPreset(3600));
  $('sn-trend-6h')?.addEventListener('click', () => snifferTrendPreset(6 * 3600));
  $('sn-trend-24h')?.addEventListener('click', () => snifferTrendPreset(24 * 3600));
  document.querySelectorAll('#sn-trend-overlay').forEach((ov) => {
    ov.addEventListener('click', (e) => { if (e.target === ov) closeSnifferTrend(); });
  });
  // Column filters: clicking the icon opens the multi-select dropdown.
  document.querySelectorAll('.sn-filter-ico').forEach((ico) => {
    ico.addEventListener('click', (e) => {
      e.stopPropagation();
      if ($('sn-filter-popup') && !$('sn-filter-popup').hidden && snFilterPopupIcon === ico) {
        hideSnifferFilterPopup();
        return;
      }
      openSnifferFilterPopup(ico);
    });
  });
  // Auto-start checkbox: persist immediately on change.
  $('sn-enabled')?.addEventListener('change', () => {
    snifferSaveConfig();
  });
})();

// Refresh the eye icons in the bus list every load.
startSnifferEyeRefresh();

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
  bindFileBrowser();
  applyTranslations();
  loadAll();
  maybeAutoOpenMqtt();
  // Background safety-net refresh. Live updates (bus/slave/spec/sniffer) are
  // pushed via SSE/CRUD calls; this slow timer only covers external changes
  // (e.g. QoS warnings, auth status) that have no event yet.
  setInterval(loadAll, 30000);
})();