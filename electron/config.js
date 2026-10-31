'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const log = require('./log');

const CONFIG_VERSION = 1;

function defaultGlobal() {
  return {
    startWithWindows: true,
    pauseOnFullscreen: true,
    pauseOnMaximized: false,
    syncWindows: 'onExit', // 'onExit' | 'always' | 'never'
    uiOpacity: 1,
    reduceMotion: false,
    defaultTransition: 'random',
    transitionMs: 1600,
    transitionIntensity: 1,
    transitionsOff: ['slices'],
    parallax: false, // 2.5D depth parallax on every wallpaper
    parallaxStrength: 1,
    parallaxMouse: true,
    chatgpt: { autoType: true, autoSend: true, newChat: true },
    easing: 'easeInOutCubic',
    preferUpscaled: true,
    upscale: {
      mode: 'auto', // auto | anime | photo | art
      animeModel: 'realesrgan-x4plus-anime',
      photoModel: 'ultrasharp-4x',
      artModel: 'digital-art-4x',
      target: '4k', // 4k | monitor | x2 | x4
      format: 'png', // png | jpg | webp
      gpu: 'auto',
      skipIfLarger: true,
    },
    editPresets: [],
    compactCorner: 'br',
    firstRunDone: false,
  };
}

function defaultMonitor(id) {
  return {
    id,
    name: '',
    alias: '',
    lastSeen: 0,
    lastRect: null,
    folder: '',
    includeSubfolders: false,
    intervalSec: 300,
    auto: true,
    order: 'random', // random | sequential
    transition: 'inherit', // inherit | random | <name>
    transitionMs: 0, // 0 = inherit
    easing: 'inherit',
    fit: 'cover', // cover | contain | stretch | center
    kenBurns: true,
    fixed: '',
    current: '',
    enabled: true,
  };
}

class ConfigStore {
  constructor() {
    this.dir = app.getPath('userData');
    this.file = path.join(this.dir, 'config.json');
    this.data = null;
    this._timer = null;
  }

  load() {
    let data = null;
    try {
      if (fs.existsSync(this.file)) data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      log.error('config: falha ao ler, usando backup', err);
      try { data = JSON.parse(fs.readFileSync(this.file + '.bak', 'utf8')); } catch (_) { data = null; }
    }
    if (!data) {
      data = { version: CONFIG_VERSION, global: defaultGlobal(), monitors: {} };
      this._migrateV5(data);
    }
    data.global = deepMerge(defaultGlobal(), data.global || {});
    // Settings of removed features (video AI) are dropped.
    for (const k of ['animatedFolder', 'comfy', 'ollama']) delete data.global[k];
    data.monitors = data.monitors || {};
    for (const id of Object.keys(data.monitors)) {
      data.monitors[id] = Object.assign(defaultMonitor(id), data.monitors[id]);
    }
    this.data = data;
    return data;
  }

  _migrateV5(data) {
    // Imports the settings of the old "WallpaperPorMonitor" PowerShell app.
    try {
      const appData = app.getPath('appData');
      const candidates = ['config-v5.json', 'config-v4.json', 'config-v3.json']
        .map((f) => path.join(appData, 'WallpaperPorMonitor', f));
      const file = candidates.find((f) => fs.existsSync(f));
      if (!file) return;
      let raw = fs.readFileSync(file, 'utf8');
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const old = JSON.parse(raw);
      const fitMap = { Fill: 'cover', Fit: 'contain', Stretch: 'stretch', Center: 'center', Tile: 'cover', Span: 'cover' };
      const fit = fitMap[old.Position] || 'cover';
      for (const m of [].concat(old.Monitors || [])) {
        if (!m || !m.MonitorId) continue;
        const cfg = defaultMonitor(String(m.MonitorId));
        cfg.folder = m.Folder || '';
        cfg.intervalSec = Math.max(5, Number(m.IntervalSeconds) || 300);
        cfg.auto = m.AutoChange !== false;
        cfg.order = old.Randomize === false ? 'sequential' : 'random';
        cfg.fit = fit;
        cfg.current = m.LastImage || '';
        cfg.lastRect = m.Width ? { x: m.Left || 0, y: m.Top || 0, width: m.Width, height: m.Height } : null;
        data.monitors[cfg.id] = cfg;
      }
      data.migratedFrom = file;
      log.info('config: migrado de', file);
    } catch (err) {
      log.error('config: migração V5 falhou', err);
    }
  }

  monitor(id) {
    if (!this.data.monitors[id]) this.data.monitors[id] = defaultMonitor(id);
    return this.data.monitors[id];
  }

  get global() { return this.data.global; }

  updateGlobal(patch) {
    this.data.global = deepMerge(this.data.global, patch || {});
    this.save();
    return this.data.global;
  }

  updateMonitor(id, patch) {
    const m = this.monitor(id);
    Object.assign(m, patch || {});
    this.save();
    return m;
  }

  forgetMonitor(id) {
    delete this.data.monitors[id];
    this.save();
  }

  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.saveNow(), 400);
  }

  saveNow() {
    clearTimeout(this._timer);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const json = JSON.stringify(this.data, null, 2);
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, json, 'utf8');
      if (fs.existsSync(this.file)) {
        try { fs.copyFileSync(this.file, this.file + '.bak'); } catch (_) { /* ignore */ }
      }
      fs.renameSync(tmp, this.file);
    } catch (err) {
      log.error('config: falha ao salvar', err);
    }
  }
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const [k, v] of Object.entries(patch || {})) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

module.exports = { ConfigStore, defaultMonitor, deepMerge };
