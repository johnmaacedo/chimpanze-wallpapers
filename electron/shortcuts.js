'use strict';
// Global keyboard shortcuts (work with the app minimised or only in the tray).
const { globalShortcut } = require('electron');
const log = require('./log');

// Ctrl+Shift by default. Avoided on purpose: Ctrl+N / Ctrl+V / Ctrl+Shift+O / Enter,
// which the app itself types into ChatGPT, and the AltGr combos (Ctrl+Alt+letter) of
// Brazilian keyboards. `perMonitor` actions also get an "+Alt" variant for every monitor.
const ACTIONS = [
  { id: 'next', label: 'Próximo wallpaper', key: 'Ctrl+Shift+N', perMonitor: true },
  { id: 'prev', label: 'Wallpaper anterior', key: 'Ctrl+Shift+B', perMonitor: true },
  { id: 'pin', label: 'Fixar / soltar o wallpaper atual', key: 'Ctrl+Shift+F', perMonitor: true },
  { id: 'pause', label: 'Pausar / retomar as trocas automáticas', key: 'Ctrl+Shift+Space' },
  { id: 'parallax', label: 'Profundidade 3D (liga / desliga)', key: 'Ctrl+Shift+D' },
  { id: 'blink', label: 'Piscar dos olhos (liga / desliga)', key: 'Ctrl+Shift+P' },
  { id: 'depthImage', label: '3D só no wallpaper atual (liga / desliga)', key: 'Ctrl+Shift+3', perMonitor: true },
  { id: 'recut', label: 'Refazer o recorte do wallpaper atual', key: 'Ctrl+Shift+X', perMonitor: true },
  { id: 'window', label: 'Mostrar / esconder o app', key: 'Ctrl+Alt+W' },
];

function defaultShortcuts() {
  const keys = {};
  for (const a of ACTIONS) keys[a.id] = a.key;
  return { enabled: true, notify: true, allWithAlt: true, keys, off: [] };
}

const MODS = ['Ctrl', 'Alt', 'Shift', 'Win'];

/** "shift+ctrl+n" → "Ctrl+Shift+N" (same order everywhere, so duplicates are easy to spot). */
function normalize(key) {
  const parts = String(key || '').split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return '';
  const alias = { control: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', win: 'Win', super: 'Win', meta: 'Win', commandorcontrol: 'Ctrl', cmdorctrl: 'Ctrl' };
  const mods = new Set();
  let main = '';
  for (const p of parts) {
    const m = alias[p.toLowerCase()];
    if (m) mods.add(m);
    else main = p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1);
  }
  if (!main) return '';
  return [...MODS.filter((m) => mods.has(m)), main].join('+');
}

function toAccelerator(key) { return key.replace(/\bWin\b/, 'Super'); }

function withAlt(key) {
  const parts = key.split('+');
  if (parts.includes('Alt')) return '';
  return normalize(['Alt', ...parts].join('+'));
}

class Shortcuts {
  constructor({ config, run }) {
    this.config = config;
    this.run = run;
    this.results = {};
    this.suspended = false;
  }

  get settings() {
    const d = defaultShortcuts();
    const s = this.config.global.shortcuts || {};
    return { ...d, ...s, keys: { ...d.keys, ...(s.keys || {}) }, off: Array.isArray(s.off) ? s.off : [] };
  }

  /** (Re)registers every shortcut from the config; remembers which ones failed. */
  apply() {
    try { globalShortcut.unregisterAll(); } catch (_) { /* ignore */ }
    this.results = {};
    const s = this.settings;
    const used = new Map(); // key -> action label
    const take = (key, fn, label) => {
      if (used.has(key)) return { ok: false, error: `Igual ao atalho de "${used.get(key)}".` };
      used.set(key, label);
      if (this.suspended) return { ok: true };
      try {
        const ok = globalShortcut.register(toAccelerator(key), fn);
        return ok ? { ok: true } : { ok: false, error: 'Outro programa já usa este atalho.' };
      } catch (err) {
        return { ok: false, error: 'Combinação de teclas inválida.' };
      }
    };
    for (const a of ACTIONS) {
      const key = normalize(s.keys[a.id]);
      const r = { key, on: !s.off.includes(a.id), ok: false, error: '', altKey: '', altOk: false, altError: '' };
      this.results[a.id] = r;
      if (!s.enabled || !r.on || !key) continue;
      Object.assign(r, take(key, () => this.fire(a.id, false), a.label));
      if (a.perMonitor && s.allWithAlt) {
        r.altKey = withAlt(key);
        if (r.altKey) {
          const t = take(r.altKey, () => this.fire(a.id, true), a.label + ' (todos)');
          r.altOk = t.ok; r.altError = t.error || '';
        }
      }
    }
    const bad = Object.entries(this.results).filter(([, r]) => s.enabled && r.on && r.key && !r.ok).map(([id, r]) => `${id}=${r.key}: ${r.error}`);
    if (bad.length) log.warn('atalhos: não registrados', bad.join(' | '));
    return this.status();
  }

  fire(id, all) {
    Promise.resolve().then(() => this.run(id, { all })).catch((err) => log.error('atalho ' + id, err));
  }

  /** While a shortcut is being recorded in the UI, ours must not swallow the keys. */
  suspend(on) {
    this.suspended = !!on;
    if (on) { try { globalShortcut.unregisterAll(); } catch (_) { /* ignore */ } } else this.apply();
    return this.status();
  }

  hasFailures() {
    return !this.suspended && Object.values(this.results).some((r) => r.key && r.on && this.settings.enabled && (!r.ok || (r.altKey && !r.altOk)));
  }

  status() {
    const s = this.settings;
    return {
      enabled: s.enabled, notify: s.notify, allWithAlt: s.allWithAlt,
      defaults: defaultShortcuts(),
      actions: ACTIONS.map((a) => ({ id: a.id, label: a.label, perMonitor: !!a.perMonitor, defaultKey: a.key, ...(this.results[a.id] || { key: normalize(s.keys[a.id]), on: !s.off.includes(a.id), ok: false, error: '' }) })),
    };
  }

  dispose() { try { globalShortcut.unregisterAll(); } catch (_) { /* ignore */ } }
}

module.exports = { Shortcuts, ACTIONS, defaultShortcuts, normalize };
