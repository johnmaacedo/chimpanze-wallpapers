'use strict';
// One renderer window per monitor, parented behind the desktop icons.
const path = require('path');
const { BrowserWindow, screen } = require('electron');
const { EventEmitter } = require('events');
const platform = require('./platform');
const log = require('./log');

const IS_WIN = process.platform === 'win32';

class WallpaperHost extends EventEmitter {
  constructor(monitor, opts) {
    super();
    this.monitor = monitor;
    this.opts = opts; // { preload, devVisible }
    this.win = null;
    this.parent = null;
    this.ready = false;
    this.pendingShow = null;
    this.lastShow = null;
    this.paused = false;
    this.destroyed = false;
    this.attachInfo = null;
    this._recreateTimer = null;
    this.create().catch((err) => log.error('host: criar janela', err));
  }

  async create() {
    const disp = screen.getAllDisplays().find((d) => d.id === this.monitor.displayId);
    const dipBounds = disp ? disp.bounds : { x: 0, y: 0, width: 800, height: 600 };
    this.ready = false;
    const options = {
      x: dipBounds.x,
      y: dipBounds.y,
      width: dipBounds.width,
      height: dipBounds.height,
      show: false,
      frame: false,
      thickFrame: false,
      roundedCorners: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      enableLargerThanScreen: true,
      backgroundColor: '#000000',
      title: 'Chimpanzé Wallpapers — renderer',
      webPreferences: {
        preload: this.opts.preload,
        backgroundThrottling: false,
        contextIsolation: true,
        sandbox: false,
        spellcheck: false,
      },
    };
    const url = `cwp://wall/wallpaper.html?monitor=${encodeURIComponent(this.monitor.id)}`;
    // All wallpaper windows are opened by one hidden "hub" page so they live in a
    // single renderer process (~150 MB saved per extra monitor). If that fails for
    // any reason, fall back to a normal, separate window.
    let win = null;
    if (this.opts.hub) {
      try { win = await this.opts.hub.open(url, options); } catch (err) { log.warn('host: hub falhou, usando janela própria', err.message); }
    }
    if (this.destroyed) { if (win && !win.isDestroyed()) win.destroy(); return; }
    let fresh = false;
    if (!win) { win = new BrowserWindow(options); fresh = true; }
    this.win = win;
    win.setMenu(null);
    win.webContents.setAudioMuted(true);
    if (fresh) {
      win.loadURL(url);
      win.once('ready-to-show', () => this.attach());
    } else {
      // Child windows have already started loading: attach once the page is up.
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => this.attach());
      else setImmediate(() => this.attach());
    }
    win.on('session-end', () => this.emit('session-end'));
    win.on('closed', () => {
      if (this.win === win) this.win = null;
      if (!this.destroyed) {
        // Our parent (Explorer) went away, or the renderer crashed: rebuild.
        log.warn('host: janela do wallpaper fechada inesperadamente, recriando', this.monitor.name);
        clearTimeout(this._recreateTimer);
        this._recreateTimer = setTimeout(() => { if (!this.destroyed) this.create().catch((err) => log.error('host: recriar janela', err)); }, 1200);
      }
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      log.error('host: renderer caiu', this.monitor.name, details.reason);
      if (!this.destroyed && this.win === win) {
        setTimeout(() => { try { win.webContents.reload(); } catch (_) { /* ignore */ } }, 800);
      }
    });
    // A reload (crash recovery) starts a fresh page: wait for its wp:ready again.
    win.webContents.on('did-start-loading', () => { this.ready = false; });
  }

  attach() {
    if (!this.win || this.destroyed) return;
    try {
      if (IS_WIN && !this.opts.devVisible) {
        const handle = this.win.getNativeWindowHandle();
        this.attachInfo = platform.attachToDesktop(handle, this.monitor.rect);
        this.parent = this.attachInfo.parent;
        log.info('host: anexado', this.monitor.name, { raised: this.attachInfo.raised, fallback: this.attachInfo.fallback, positioned: this.attachInfo.positioned, actual: this.attachInfo.actual });
      }
      // Reveal after the first frame is drawn (avoids a black flash), with a safety timeout.
      clearTimeout(this._revealTimer);
      this._revealTimer = setTimeout(() => this.reveal(), 5000);
      this.emit('attached', this.attachInfo);
      this._attachTries = 0;
    } catch (err) {
      // Right after login Explorer may not be ready yet: keep retrying quietly.
      this._attachTries = (this._attachTries || 0) + 1;
      log.warn(`host: falha ao anexar à área de trabalho (tentativa ${this._attachTries})`, err.message);
      if (!this.destroyed && this._attachTries < 60) {
        clearTimeout(this._retryTimer);
        this._retryTimer = setTimeout(() => this.attach(), 3000);
      } else {
        this.emit('error', err);
      }
    }
  }

  reveal() {
    clearTimeout(this._revealTimer);
    if (!this.win || this.win.isDestroyed() || this.win.isVisible()) return;
    try { this.win.showInactive(); } catch (_) { /* ignore */ }
  }

  /** Called by the renderer once its GL context and IPC are ready. */
  rendererReady() {
    this.ready = true;
    this.send('wp:paused', this.paused);
    if (this.pendingShow) {
      const msg = this.pendingShow;
      this.pendingShow = null;
      this.send('wp:show', msg);
    } else if (this.lastShow) {
      // Renderer was rebuilt (Explorer restart / crash): restore without animation.
      this.send('wp:show', Object.assign({}, this.lastShow, { instant: true }));
    }
  }

  send(channel, payload) {
    if (this.win && !this.win.isDestroyed()) {
      try { this.win.webContents.send(channel, payload); } catch (_) { /* ignore */ }
    }
  }

  show(msg) {
    this.lastShow = msg;
    if (!this.ready) { this.pendingShow = msg; return; }
    this.send('wp:show', msg);
  }

  setPaused(paused) {
    if (this.paused === paused) return;
    this.paused = paused;
    this.send('wp:paused', paused);
  }

  setSettings(settings) { this.send('wp:settings', settings); }

  /** Late depth map for the picture on screen (2.5D parallax). */
  depth(msg) {
    if (this.lastShow && this.lastShow.url === msg.url) this.lastShow = Object.assign({}, this.lastShow, { depthUrl: msg.depthUrl });
    if (this.pendingShow && this.pendingShow.url === msg.url) { this.pendingShow.depthUrl = msg.depthUrl; return; }
    if (this.ready) this.send('wp:depth', msg);
  }

  /** Cursor position over this monitor, -1..1 on each axis (parallax follows it). */
  pointer(p) { if (this.ready) this.send('wp:pointer', p); }

  updateMonitor(monitor) {
    const moved = JSON.stringify(monitor.rect) !== JSON.stringify(this.monitor.rect);
    this.monitor = monitor;
    if (moved) this.reposition();
  }

  reposition() {
    if (!this.win || this.win.isDestroyed()) return;
    if (IS_WIN && !this.opts.devVisible && this.parent) {
      try {
        if (!platform.isWindow(this.parent)) { this.attach(); return; }
        platform.positionChild(this.win.getNativeWindowHandle(), this.parent, this.monitor.rect);
      } catch (err) { log.error('host: reposicionar', err); }
    }
  }

  /** Watchdog: re-attach if Explorer was restarted / the layer was rebuilt. */
  check() {
    if (!IS_WIN || this.opts.devVisible || !this.win || this.win.isDestroyed() || !this.parent) return;
    try {
      if (!platform.isWindow(this.parent)) {
        log.warn('host: camada da área de trabalho sumiu, reanexando', this.monitor.name);
        this.attach();
        return;
      }
      const r = platform.windowRect(this.win.getNativeWindowHandle());
      const t = this.monitor.rect;
      if (r && (Math.abs(r.x - t.x) > 2 || Math.abs(r.y - t.y) > 2 || Math.abs(r.width - t.width) > 2 || Math.abs(r.height - t.height) > 2)) {
        this.reposition();
      }
    } catch (err) {
      log.error('host: watchdog', err);
    }
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this._recreateTimer);
    clearTimeout(this._revealTimer);
    clearTimeout(this._retryTimer);
    if (this.win && !this.win.isDestroyed()) {
      try { this.win.destroy(); } catch (_) { /* ignore */ }
    }
    this.win = null;
  }
}

/**
 * Hidden page that opens every wallpaper window with window.open(), so Chromium
 * keeps them all in the same renderer process (one Blink/V8 instance instead of
 * one per monitor).
 */
class Hub {
  constructor() {
    this.win = null;
    this.waiting = new Map(); // frameName -> { resolve, reject, options, timer }
    this.seq = 0;
  }

  async ensure() {
    if (this.win && !this.win.isDestroyed()) return this.ready;
    const win = new BrowserWindow({ show: false, width: 1, height: 1, frame: false, skipTaskbar: true, focusable: false, webPreferences: { contextIsolation: true, sandbox: false, backgroundThrottling: false, spellcheck: false } });
    this.win = win;
    win.webContents.setWindowOpenHandler(({ frameName }) => {
      const w = this.waiting.get(frameName);
      if (!w) return { action: 'deny' };
      return { action: 'allow', outlivesOpener: true, overrideBrowserWindowOptions: w.options };
    });
    win.webContents.on('did-create-window', (child, { frameName }) => {
      const w = this.waiting.get(frameName);
      if (!w) return;
      this.waiting.delete(frameName);
      clearTimeout(w.timer);
      w.resolve(child);
    });
    win.webContents.on('render-process-gone', (_e, d) => {
      log.error('hub: processo dos wallpapers caiu', d.reason);
      try { win.destroy(); } catch (_) { /* ignore */ }
      if (this.win === win) this.win = null;
    });
    this.ready = win.loadURL('cwp://wall/hub.html');
    return this.ready;
  }

  async open(url, options) {
    await this.ensure();
    const name = `wp${Date.now().toString(36)}${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(name); reject(new Error('timeout')); }, 8000);
      this.waiting.set(name, { resolve, reject, options, timer });
      this.win.webContents.executeJavaScript(`void window.open(${JSON.stringify(url)}, ${JSON.stringify(name)})`).catch((err) => {
        clearTimeout(timer); this.waiting.delete(name); reject(err);
      });
    });
  }

  destroy() { if (this.win && !this.win.isDestroyed()) this.win.destroy(); this.win = null; }
}

class HostManager extends EventEmitter {
  constructor({ preload, devVisible = false }) {
    super();
    this.preload = preload;
    this.devVisible = devVisible;
    this.hub = process.env.CW_NO_HUB ? null : new Hub();
    this.hosts = new Map();
    this._watch = setInterval(() => this.hosts.forEach((h) => h.check()), 2500);
  }

  sync(monitors) {
    const ids = new Set(monitors.map((m) => m.id));
    for (const [id, host] of this.hosts) {
      if (!ids.has(id)) { host.destroy(); this.hosts.delete(id); }
    }
    for (const m of monitors) {
      const h = this.hosts.get(m.id);
      if (h) h.updateMonitor(m);
      else {
        const host = new WallpaperHost(m, { preload: this.preload, devVisible: this.devVisible, hub: this.hub });
        host.on('error', (err) => this.emit('error', { id: m.id, error: err }));
        host.on('session-end', () => this.emit('session-end'));
        this.hosts.set(m.id, host);
      }
    }
  }

  get(id) { return this.hosts.get(id) || null; }

  byWebContents(wc) {
    for (const h of this.hosts.values()) if (h.win && !h.win.isDestroyed() && h.win.webContents === wc) return h;
    return null;
  }

  isOwnWindow(bw) {
    for (const h of this.hosts.values()) if (h.win === bw) return true;
    return false;
  }

  destroyAll() {
    clearInterval(this._watch);
    this.hosts.forEach((h) => h.destroy());
    this.hosts.clear();
    if (this.hub) this.hub.destroy();
  }
}

module.exports = { HostManager };
