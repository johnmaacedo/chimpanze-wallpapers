'use strict';
const { EventEmitter } = require('events');
const { screen, powerMonitor } = require('electron');
const platform = require('./platform');
const log = require('./log');

// EDID manufacturer codes -> brand, used to build friendly names.
const BRANDS = {
  GSM: 'LG', SAM: 'Samsung', SEC: 'Samsung', DEL: 'Dell', ACI: 'ASUS', AUS: 'ASUS', AOC: 'AOC', BNQ: 'BenQ',
  ACR: 'Acer', HWP: 'HP', HPN: 'HP', LEN: 'Lenovo', MSI: 'MSI', PHL: 'Philips', GBT: 'Gigabyte', VSC: 'ViewSonic',
  XMI: 'Xiaomi', SNY: 'Sony', AOR: 'AORUS', HKC: 'HKC', PNP: 'Genérico', IVM: 'iiyama', NEC: 'NEC', EIZ: 'EIZO',
  BOE: 'BOE', AUO: 'AUO', CMN: 'Chimei', LGD: 'LG Display', SHP: 'Sharp', TCL: 'TCL', HSD: 'Hannspree', MSG: 'Mancer',
  PCK: 'Pichau', NVT: 'Novatek', KTC: 'KTC', TTE: 'TTE', RTK: 'Realtek', CTX: 'CTX', AMH: 'AOC',
};

function edidCode(id) {
  const m = /DISPLAY#([A-Z]{3})([0-9A-F]{4})/i.exec(id || '');
  return m ? { maker: m[1].toUpperCase(), product: m[2].toUpperCase() } : null;
}

function rectKey(r) { return r ? `${r.x},${r.y},${r.width},${r.height}` : ''; }

class MonitorManager extends EventEmitter {
  constructor() {
    super();
    this.monitors = []; // online monitors
    this._debounce = null;
    this._poll = null;
    this._scanning = false;
  }

  start() {
    const soon = (ms) => () => this.scheduleScan(ms);
    screen.on('display-added', soon(900));
    screen.on('display-removed', soon(900));
    screen.on('display-metrics-changed', soon(900));
    try {
      powerMonitor.on('resume', soon(2500));
      powerMonitor.on('unlock-screen', soon(1500));
    } catch (_) { /* ignore */ }
    // Polling as a safety net: some docks/KVMs do not raise display events.
    this._poll = setInterval(() => this.scan(), 3000);
    this.scan(true);
  }

  stop() {
    clearInterval(this._poll);
    clearTimeout(this._debounce);
  }

  scheduleScan(ms = 800) {
    clearTimeout(this._debounce);
    this._debounce = setTimeout(() => this.scan(), ms);
  }

  /** Full detection. `force` emits even without changes (manual "Detectar"). */
  scan(force = false) {
    if (this._scanning) return this.monitors;
    this._scanning = true;
    try {
      const raw = platform.listMonitors();
      const displays = screen.getAllDisplays();
      const primary = screen.getPrimaryDisplay();
      const list = raw.map((m) => {
        const disp = matchDisplay(m.rect, displays);
        const code = edidCode(m.id);
        const brand = code ? (BRANDS[code.maker] || code.maker) : '';
        return {
          id: m.id,
          rect: m.rect,
          displayId: disp ? disp.id : null,
          scaleFactor: disp ? disp.scaleFactor : 1,
          refreshRate: disp ? Math.round(disp.displayFrequency || 0) : 0,
          primary: disp ? disp.id === primary.id : (m.rect.x === 0 && m.rect.y === 0),
          internal: disp ? !!disp.internal : false,
          label: (disp && disp.label) || '',
          brand,
          model: code ? code.product : '',
        };
      });
      list.sort((a, b) => (a.rect.x - b.rect.x) || (a.rect.y - b.rect.y));
      list.forEach((m, i) => {
        m.index = i + 1;
        m.name = m.label || (m.brand ? `${m.brand} ${m.model}`.trim() : `Monitor ${m.index}`);
      });

      const prev = new Map(this.monitors.map((m) => [m.id, m]));
      const next = new Map(list.map((m) => [m.id, m]));
      const added = list.filter((m) => !prev.has(m.id));
      const removed = this.monitors.filter((m) => !next.has(m.id));
      const changed = list.filter((m) => prev.has(m.id) && rectKey(prev.get(m.id).rect) !== rectKey(m.rect));
      const indexChanged = list.some((m) => prev.has(m.id) && prev.get(m.id).index !== m.index);
      this.monitors = list;
      if (force || added.length || removed.length || changed.length || indexChanged) {
        log.info('monitores:', list.map((m) => `${m.index}:${m.name}@${rectKey(m.rect)}`).join(' | '),
          added.length ? `+${added.length}` : '', removed.length ? `-${removed.length}` : '');
        this.emit('change', { monitors: list, added, removed, changed, forced: force });
      }
    } catch (err) {
      log.error('monitores: falha na detecção', err);
      try { platform.resetCom(); } catch (_) { /* ignore */ }
    } finally {
      this._scanning = false;
    }
    return this.monitors;
  }

  get(id) { return this.monitors.find((m) => m.id === id) || null; }
}

function matchDisplay(rect, displays) {
  let best = null;
  let bestScore = Infinity;
  for (const d of displays) {
    let phys;
    try {
      phys = process.platform === 'win32' ? screen.dipToScreenRect(null, d.bounds) : {
        x: Math.round(d.bounds.x * d.scaleFactor), y: Math.round(d.bounds.y * d.scaleFactor),
        width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor),
      };
    } catch (_) {
      phys = d.bounds;
    }
    const score = Math.abs(phys.x - rect.x) + Math.abs(phys.y - rect.y) +
      Math.abs(phys.width - rect.width) + Math.abs(phys.height - rect.height);
    if (score < bestScore) { bestScore = score; best = d; }
  }
  return bestScore < 64 ? best : null;
}

module.exports = { MonitorManager, matchDisplay };
