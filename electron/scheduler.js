'use strict';
// Per-monitor rotation: one 1 s ticker drives every monitor independently.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const library = require('./library');
const { mediaUrl } = require('./protocol');
const log = require('./log');
const depth = require('./ai/depth');

const CATALOG = require('./transitions.json');
const TRANSITIONS = CATALOG.list.map((t) => t.id);
const SOFT = CATALOG.list.filter((t) => t.cat === 'soft' || t.cat === 'motion').map((t) => t.id);
const EASINGS = ['easeInOutCubic', 'easeInOutQuint', 'easeOutExpo', 'easeInOutSine', 'easeOutBack', 'linear', 'easeOutQuart', 'easeInOutExpo', 'spring', 'springBounce', 'apple'];

/** Random pick that honours the user's "use in random" switches and avoids repeating the last one. */
function pickRandom(pool, off, last) {
  let list = pool.filter((t) => !(off || []).includes(t));
  if (!list.length) list = pool;
  if (list.length > 1 && last) list = list.filter((t) => t !== last);
  return list[Math.floor(Math.random() * list.length)];
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class Scheduler extends EventEmitter {
  constructor({ config, monitors, hosts, platform }) {
    super();
    this.config = config;
    this.monitors = monitors;
    this.hosts = hosts;
    this.platform = platform;
    this.state = new Map(); // id -> { nextAt, bag, history, busy, occluded }
    this.globalPaused = false;
    this._timer = null;
  }

  st(id) {
    if (!this.state.has(id)) this.state.set(id, { nextAt: 0, bag: [], bagFolder: '', history: [], busy: false, occluded: false, error: '' });
    return this.state.get(id);
  }

  start() {
    this._timer = setInterval(() => this.tick(), 1000);
  }

  stop() { clearInterval(this._timer); }

  /** Called when a monitor becomes online (startup, hot-plug). */
  async activate(mon) {
    const cfg = this.config.monitor(mon.id);
    cfg.name = mon.name;
    cfg.lastSeen = Date.now();
    cfg.lastRect = mon.rect;
    const s = this.st(mon.id);
    const host = this.hosts.get(mon.id);
    if (host) host.setSettings(this.rendererSettings(cfg));
    // Restore what was on screen, else start from the current Windows wallpaper.
    let item = cfg.fixed || cfg.current;
    if (item && !fs.existsSync(item)) item = '';
    if (!item && cfg.folder) {
      await this.next(mon.id, { instant: true });
    } else if (item) {
      this.display(mon.id, item, { instant: true });
    } else {
      let winWp = '';
      try { winWp = this.platform.getWindowsWallpaper(mon.id); } catch (_) { /* ignore */ }
      if (winWp && fs.existsSync(winWp)) this.display(mon.id, winWp, { instant: true, keepCurrent: true });
    }
    this.reschedule(mon.id);
    this.emitState();
  }

  rendererSettings(cfg) {
    const g = this.config.global;
    return {
      fit: cfg.fit || 'cover',
      kenBurns: !!cfg.kenBurns && !g.reduceMotion,
      intensity: Number(g.transitionIntensity) || 1,
      parallax: this.parallaxOn(),
      parallaxStrength: Math.max(0.3, Math.min(2, Number(g.parallaxStrength) || 1)),
      parallaxMouse: g.parallaxMouse !== false,
    };
  }

  /** 2.5D depth parallax: one global switch for every monitor (needs the depth model). */
  parallaxOn() {
    const g = this.config.global;
    return !!g.parallax && !g.reduceMotion && depth.exists();
  }

  /** Sends a depth map to a monitor once it is ready (if the picture is still the one shown). */
  lateDepth(id, file, tok, url) {
    depth.get(file).then((d) => {
      const s = this.st(id);
      const host = this.hosts.get(id);
      if (tok !== s.showToken || !host || !this.parallaxOn()) return;
      host.depth({ url, depthUrl: mediaUrl(d) });
    }).catch((err) => {
      if (!this._depthWarned) { this._depthWarned = true; log.warn('depth: não consegui gerar o mapa', err.message); }
    });
  }

  /** Parallax switched on: give every monitor showing a picture its depth map. */
  refreshDepth() {
    if (!this.parallaxOn()) return;
    for (const mon of this.monitors.monitors) {
      const host = this.hosts.get(mon.id);
      const last = host && host.lastShow;
      if (!last || last.type !== 'image' || last.depthUrl || !last.path) continue;
      this.lateDepth(mon.id, last.path, this.st(mon.id).showToken, last.url);
    }
  }

  /** Prepares the depth map of the picture that comes next, so it arrives with parallax. */
  async prefetchDepth(id) {
    if (!this.parallaxOn()) return;
    try {
      const cfg = this.config.monitor(id);
      const s = this.st(id);
      if (!cfg.folder || cfg.fixed) return;
      let nextFile = null;
      if (cfg.order === 'sequential') {
        const items = await library.listMedia(cfg.folder, { includeSubfolders: cfg.includeSubfolders });
        const paths = items.map((i) => i.path);
        const idx = paths.indexOf(cfg.current);
        nextFile = paths[(idx + 1) % paths.length];
      } else {
        nextFile = s.bag[0];
      }
      if (!nextFile || library.mediaType(nextFile) !== 'image') return;
      const shown = this.config.global.preferUpscaled ? library.bestVersion(nextFile) : (library.editedPathFor(nextFile) || nextFile);
      await depth.get(shown);
    } catch (_) { /* best effort */ }
  }

  reschedule(id) {
    const cfg = this.config.monitor(id);
    const s = this.st(id);
    s.nextAt = cfg.auto && !cfg.fixed && cfg.folder ? Date.now() + Math.max(5, cfg.intervalSec) * 1000 : 0;
  }

  tick() {
    const now = Date.now();
    for (const mon of this.monitors.monitors) {
      const cfg = this.config.monitor(mon.id);
      const s = this.st(mon.id);
      if (this.globalPaused || !cfg.enabled || !cfg.auto || cfg.fixed || !cfg.folder) continue;
      if (!s.nextAt) { this.reschedule(mon.id); continue; }
      if (now >= s.nextAt && !s.busy) {
        // Don't animate behind a fullscreen game; try again a bit later.
        if (s.occluded) { s.nextAt = now + 5000; continue; }
        this.next(mon.id).catch((err) => log.error('scheduler: troca automática', err));
      }
    }
    this.emit('tick', this.snapshot());
  }

  async pickNext(id, dir = 1) {
    const cfg = this.config.monitor(id);
    const s = this.st(id);
    const items = await library.listMedia(cfg.folder, { includeSubfolders: cfg.includeSubfolders });
    if (!items.length) throw new Error('A pasta deste monitor não tem imagens ou vídeos suportados.');
    const paths = items.map((i) => i.path);
    if (cfg.order === 'sequential') {
      let idx = paths.indexOf(cfg.current);
      idx = idx < 0 ? (dir > 0 ? 0 : paths.length - 1) : (idx + dir + paths.length) % paths.length;
      return paths[idx];
    }
    // Random without repeats until every item has been shown ("shuffle bag").
    const setNow = new Set(paths);
    s.bag = s.bag.filter((p) => setNow.has(p));
    if (s.bagFolder !== cfg.folder || !s.bag.length) {
      s.bagFolder = cfg.folder;
      s.bag = shuffle(paths.slice());
      if (s.bag.length > 1 && s.bag[0] === cfg.current) s.bag.push(s.bag.shift());
    }
    return s.bag.shift();
  }

  async next(id, opts = {}) {
    const s = this.st(id);
    if (s.busy) return null;
    s.busy = true;
    try {
      const item = await this.pickNext(id, 1);
      this.display(id, item, opts);
      s.error = '';
      return item;
    } catch (err) {
      s.error = err.message;
      this.emit('error', { id, message: err.message });
      throw err;
    } finally {
      s.busy = false;
      this.reschedule(id);
      this.emitState();
    }
  }

  async prev(id) {
    const s = this.st(id);
    const cfg = this.config.monitor(id);
    // history holds previously displayed items (most recent last, excluding current)
    let item = null;
    while (s.history.length) {
      const cand = s.history.pop();
      if (cand !== cfg.current && fs.existsSync(cand)) { item = cand; break; }
    }
    if (!item) {
      if (cfg.order === 'sequential' && cfg.folder) item = await this.pickNext(id, -1);
      else return null;
    }
    this.display(id, item, { noHistory: true });
    this.reschedule(id);
    this.emitState();
    return item;
  }

  /** Puts a specific file on a monitor (used by gallery "Aplicar"). */
  apply(id, file, { fix = false } = {}) {
    const cfg = this.config.monitor(id);
    if (fix) cfg.fixed = file;
    else if (cfg.fixed) cfg.fixed = '';
    this.display(id, file, {});
    this.reschedule(id);
    this.config.save();
    this.emitState();
  }

  display(id, file, opts = {}) {
    const cfg = this.config.monitor(id);
    const g = this.config.global;
    const s = this.st(id);
    let shown = file;
    const type = library.mediaType(file);
    if (type === 'image') shown = g.preferUpscaled ? library.bestVersion(file) : (library.editedPathFor(file) || file);
    if (!opts.keepCurrent) {
      if (cfg.current && cfg.current !== file && !opts.noHistory) {
        s.history.push(cfg.current);
        if (s.history.length > 50) s.history.shift();
      }
      cfg.current = file;
      this.config.save();
    }
    let transition = cfg.transition === 'inherit' ? g.defaultTransition : cfg.transition;
    if (!transition || transition === 'random' || transition === 'randomSoft' || !TRANSITIONS.includes(transition)) {
      transition = pickRandom(transition === 'randomSoft' ? SOFT : TRANSITIONS, g.transitionsOff, s.lastTransition);
    }
    s.lastTransition = transition;
    let easing = cfg.easing === 'inherit' ? g.easing : cfg.easing;
    if (!EASINGS.includes(easing)) easing = 'easeInOutCubic';
    const duration = g.reduceMotion ? 450 : (cfg.transitionMs || g.transitionMs || 1600);
    const msg = {
      url: mediaUrl(shown),
      path: shown,
      type,
      transition: g.reduceMotion ? 'fade' : transition,
      duration,
      easing,
      instant: !!opts.instant,
    };
    const tok = s.showToken = (s.showToken || 0) + 1;
    const send = (depthFile) => {
      const host = this.hosts.get(id);
      if (tok !== s.showToken || !host) return;
      host.setSettings(this.rendererSettings(cfg));
      host.show(depthFile ? Object.assign({ depthUrl: mediaUrl(depthFile) }, msg) : msg);
    };
    if (type === 'image' && this.parallaxOn()) {
      const ready = depth.cached(shown);
      if (ready) send(ready);
      else if (opts.instant) { send(null); this.lateDepth(id, shown, tok, msg.url); }
      else {
        // A new picture waits a moment for its depth so it arrives already in 3D;
        // if that takes too long it shows flat and the depth fades in later.
        let timer;
        Promise.race([depth.get(shown), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), 4500); })])
          .then((d) => { clearTimeout(timer); send(d); }, () => { clearTimeout(timer); send(null); this.lateDepth(id, shown, tok, msg.url); });
      }
      setTimeout(() => this.prefetchDepth(id), duration + 2500);
    } else {
      send(null);
    }
    if (g.syncWindows === 'always' && type === 'image') {
      setTimeout(() => this.syncWindowsWallpaper(id, shown), duration + 400);
    }
    this.emit('displayed', { id, file, shown, transition });
  }

  syncWindowsWallpaper(id, file) {
    try {
      this.platform.setWindowsWallpaper(id, path.resolve(file));
    } catch (err) {
      log.warn('scheduler: não consegui sincronizar o wallpaper do Windows', err.message);
    }
  }

  /** On exit: leave the last static image as the official Windows wallpaper. */
  syncAllForExit() {
    if (this.config.global.syncWindows === 'never') return;
    for (const mon of this.monitors.monitors) {
      const cfg = this.config.monitor(mon.id);
      const file = cfg.current;
      if (!file || library.mediaType(file) !== 'image' || !fs.existsSync(file)) continue;
      const shown = this.config.global.preferUpscaled ? library.bestVersion(file) : (library.editedPathFor(file) || file);
      this.syncWindowsWallpaper(mon.id, shown);
    }
  }

  setOccluded(id, occluded) {
    const s = this.st(id);
    if (s.occluded === occluded) return;
    s.occluded = occluded;
    const host = this.hosts.get(id);
    if (host) host.setPaused(occluded || this.globalPaused);
    this.emitState();
  }

  setGlobalPaused(p) {
    this.globalPaused = !!p;
    for (const mon of this.monitors.monitors) {
      const host = this.hosts.get(mon.id);
      if (host) host.setPaused(this.globalPaused || this.st(mon.id).occluded);
      if (!p) this.reschedule(mon.id);
    }
    this.emitState();
  }

  snapshot() {
    const out = {};
    for (const [id, s] of this.state) {
      out[id] = { nextAt: s.nextAt, occluded: s.occluded, error: s.error, busy: s.busy, historySize: s.history.length };
    }
    return { monitors: out, globalPaused: this.globalPaused, now: Date.now() };
  }

  emitState() { this.emit('state', this.snapshot()); }
}

module.exports = { Scheduler, TRANSITIONS, EASINGS };
