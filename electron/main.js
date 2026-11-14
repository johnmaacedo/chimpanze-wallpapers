'use strict';
// Chimpanzé Wallpapers — main process
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, screen, shell, Notification, globalShortcut, clipboard } = require('electron');

const log = require('./log');
const proto = require('./protocol');

const IS_WIN = process.platform === 'win32';
const STARTUP = process.argv.includes('--startup');
const DEV_VISIBLE = process.argv.includes('--dev-visible');
const SMOKE = process.argv.includes('--smoke-test');

proto.registerSchemes();
// The product name has an accent ("Chimpanzé"); Chromium puts it in the
// User-Agent header and non-Latin1 header values break custom protocol requests.
try { app.userAgentFallback = app.userAgentFallback.replace(/Chimpanz[^\s/]*\s?Wallpapers/gi, 'ChimpanzeWallpapers').replace(/[^\x20-\x7E]/g, ''); } catch (_) { /* ignore */ }
app.setAppUserModelId('com.chimpanze.wallpapers');
// Keep animations smooth even when the window is in the background/tray.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
// Never let a GPU blocklist entry disable WebGL2 (the transitions depend on it).
app.commandLine.appendSwitch('ignore-gpu-blocklist');
// Our renderers live *behind* the desktop icon layer: Chromium's native occlusion
// tracking would think they are hidden and stop painting them.
// Memory: no pre-spawned spare renderer and no back/forward page cache (we never navigate).
app.commandLine.appendSwitch('disable-features', ['CalculateNativeWinOcclusion', 'SpareRendererForSitePerProcess', 'BackForwardCache'].join(','));
// Memory: run Chromium's network service inside the main process instead of a
// separate ~70 MB utility process (the app only talks to its own cwp:// protocol).
app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess2');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());
  app.whenReady().then(boot).catch((err) => {
    try { log.error('boot falhou', err); } catch (_) { /* ignore */ }
    dialog.showErrorBox('Chimpanzé Wallpapers', `Não foi possível iniciar.\n\n${err.stack || err.message}`);
    app.exit(1);
  });
}

let config; let shortcuts; let monitors; let hosts; let scheduler; let jobs; let platform; let library; let upscaler; let tools; let lama; let chatgpt; let localAi; let music; let components;
let mainWin = null;
let tray = null;
let quitting = false;
let compact = false;
let normalBounds = null;
const overlays = new Set();

const DIST = path.join(__dirname, '..', 'dist');
const PRELOAD = path.join(__dirname, 'preload.js');

function resource(...p) {
  return app.isPackaged ? path.join(process.resourcesPath, ...p) : path.join(__dirname, '..', 'resources', ...p);
}

function broadcast(channel, payload) {
  if (mainWin && !mainWin.isDestroyed()) {
    try { mainWin.webContents.send(channel, payload); } catch (_) { /* ignore */ }
  }
}

async function boot() {
  log.init(path.join(app.getPath('userData'), 'logs'));
  log.info('iniciando', app.getVersion(), process.platform, process.versions.electron, STARTUP ? '(login)' : '');

  platform = require('./platform');
  library = require('./library');
  tools = require('./tools');
  upscaler = require('./upscaler');
  lama = require('./ai/lama');
  const { ConfigStore } = require('./config');
  const { MonitorManager } = require('./monitors');
  const { HostManager } = require('./hosts');
  const { Scheduler } = require('./scheduler');
  const { JobQueue } = require('./jobs');

  proto.handle(DIST);

  config = new ConfigStore();
  config.load();
  applyStartup();

  monitors = new MonitorManager();
  hosts = new HostManager({ preload: PRELOAD, devVisible: DEV_VISIBLE });
  scheduler = new Scheduler({ config, monitors, hosts, platform });
  jobs = new JobQueue();

  scheduler.on('state', (s) => broadcast('scheduler', s));
  scheduler.on('tick', (s) => broadcast('scheduler', s));
  scheduler.on('displayed', () => { broadcast('state', publicState()); syncMusic(); });
  music = new (require('./music').Music)({ config });
  music.on('status', (st) => broadcast('music', st));
  setTimeout(() => music.checkAccount(), 3000);
  scheduler.on('error', (e) => broadcast('toast', { kind: 'error', title: monitorName(e.id), message: e.message }));
  jobs.on('job', (j) => broadcast('job', j));
  jobs.on('cleared', () => broadcast('jobs', jobs.list()));

  monitors.on('change', onMonitorsChange);
  cleanupLegacyAi();
  // Windows shutdown/restart/log-off: leave the current images as the official wallpaper.
  hosts.on('session-end', () => {
    try { scheduler.syncAllForExit(); config.saveNow(); } catch (err) { log.error('session-end', err); }
  });
  if (process.env.CW_TEST) global.__cw = { platform, monitors, hosts, scheduler, config };

  registerIpc();
  createTray();
  if (!STARTUP) createMainWindow();

  monitors.start();
  scheduler.start();
  startOcclusionWatch();
  updatePointerTimer();

  const { Shortcuts } = require('./shortcuts');
  shortcuts = new Shortcuts({ config, run: runShortcut });
  shortcuts.apply();

  if (SMOKE) {
    setTimeout(() => {
      log.info('smoke-test: monitores', JSON.stringify(monitors.monitors.map((m) => m.name)));
      quitting = true;
      app.quit();
    }, 6000);
  }
}

// ---------------------------------------------------------------------------
// Parallax: the wallpaper leans toward the mouse (cursor sampled ~30×/s, only
// while the parallax is on, and only sent when it actually moved).

let pointerTimer = null;
let lastPointer = '';
function updatePointerTimer() {
  const g = config.global;
  const want = scheduler.parallaxOn() && g.parallaxMouse !== false;
  if (want && !pointerTimer) pointerTimer = setInterval(pollPointer, 33);
  if (!want && pointerTimer) { clearInterval(pointerTimer); pointerTimer = null; lastPointer = ''; }
}
function pollPointer() {
  let pt;
  try {
    pt = screen.getCursorScreenPoint();
    if (process.platform === 'win32') pt = screen.dipToScreenPoint(pt); // monitor rects are physical pixels
  } catch (_) { return; }
  const key = `${pt.x},${pt.y}`;
  if (key === lastPointer) return;
  lastPointer = key;
  for (const m of monitors.monitors) {
    const host = hosts.get(m.id);
    if (!host || !m.rect) continue;
    const r = m.rect;
    const x = ((pt.x - r.x) / r.width) * 2 - 1;
    const y = ((pt.y - r.y) / r.height) * 2 - 1;
    // Off this monitor: lean gently toward where the cursor is (clamped).
    host.pointer({ x: Math.max(-1.5, Math.min(1.5, x)), y: Math.max(-1.5, Math.min(1.5, y)), inside: Math.abs(x) <= 1 && Math.abs(y) <= 1 });
  }
}

// ---------------------------------------------------------------------------
// Monitors / hosts

function hasContent(id) {
  const c = config.data.monitors[id];
  return !!(c && c.enabled && (c.folder || c.fixed));
}

function syncHosts() {
  const active = monitors.monitors.filter((m) => hasContent(m.id));
  const before = new Set(hosts.hosts.keys());
  hosts.sync(active);
  for (const m of active) if (!before.has(m.id)) scheduler.activate(m).catch((err) => log.error('activate', err));
}

/**
 * Windows sometimes gives the same physical monitor a new device path after it is unplugged
 * (another port, UID or driver), and each path used to be kept as a different monitor. Now:
 * a monitor seen for the first time takes the settings of the last disconnected one of the same
 * model, and remembered entries of a model that is connected (or older copies of the same
 * model) are dropped. Only one entry per model is kept for a disconnected monitor.
 */
function dedupeMonitors(list) {
  const { edidCode } = require('./monitors');
  const model = (id) => { const c = edidCode(id); return c ? c.maker + c.product : null; };
  const online = new Set(list.map((m) => m.id));
  const all = () => Object.values(config.data.monitors);
  let changed = false;
  for (const m of list) {
    const mine = config.data.monitors[m.id];
    if (mine && (mine.folder || mine.fixed)) continue;
    const twin = all().filter((c) => !online.has(c.id) && model(c.id) && model(c.id) === model(m.id) && (c.folder || c.fixed)).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))[0];
    if (!twin) continue;
    const keep = { id: m.id, lastRect: m.rect, lastSeen: Date.now(), name: m.name };
    config.data.monitors[m.id] = Object.assign({}, twin, keep);
    log.info('monitores: mesmo modelo reconectado com outro caminho, configuração aproveitada', twin.id, '->', m.id);
    changed = true;
  }
  const seen = new Set(list.map((m) => model(m.id)).filter(Boolean));
  for (const c of all().filter((x) => !online.has(x.id)).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))) {
    const k = model(c.id);
    if (!k) continue;
    if (seen.has(k)) { delete config.data.monitors[c.id]; changed = true; log.info('monitores: cópia antiga removida', c.name || c.id); } else seen.add(k);
  }
  if (changed) config.save();
}

function onMonitorsChange({ monitors: list, added, removed, forced }) {
  dedupeMonitors(list);
  for (const m of list) {
    const c = config.monitor(m.id);
    c.name = m.name;
    c.lastSeen = Date.now();
    c.lastRect = m.rect;
  }
  config.save();
  syncHosts();
  const initial = !onMonitorsChange.done;
  onMonitorsChange.done = true;
  if (!initial) {
    for (const m of removed) {
      broadcast('toast', { kind: 'warn', title: 'Monitor desconectado', message: `${m.name} foi desligado. As configurações dele ficam guardadas.` });
      notify('Monitor desconectado', `${m.name} foi desligado. As configurações foram guardadas.`);
    }
    for (const m of added) {
      const known = hasContent(m.id);
      if (known) {
        broadcast('toast', { kind: 'ok', title: 'Monitor reconectado', message: `${m.name} voltou e o wallpaper dele foi restaurado.` });
        notify('Monitor reconectado', `${m.name} voltou com o wallpaper dele.`);
      } else {
        broadcast('monitor-new', { id: m.id, name: m.name, rect: m.rect });
        notify('Novo monitor detectado', `${m.name} (${m.rect.width}×${m.rect.height}). Clique para escolher o wallpaper.`, () => {
          showMain();
          setTimeout(() => broadcast('monitor-new', { id: m.id, name: m.name, rect: m.rect }), 600);
        });
      }
    }
  } else if (config.data.migratedFrom && !config.global.firstRunDone) {
    broadcast('toast', { kind: 'ok', title: 'Configurações importadas', message: 'Pastas e timers do Wallpaper por Monitor V5 foram importados.' });
  }
  if (forced) broadcast('toast', { kind: 'ok', title: 'Monitores detectados', message: `${list.length} monitor(es) ativo(s).` });
  broadcast('state', publicState());
  updateTrayMenu();
}

function monitorName(id) {
  const m = monitors.get(id);
  if (m) return m.name;
  const c = config.data.monitors[id];
  return (c && (c.alias || c.name)) || 'Monitor';
}

function notify(title, body, onClick) {
  try {
    if (mainWin && mainWin.isVisible() && mainWin.isFocused()) return;
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, icon: resource('icon.png'), silent: true });
    n.on('click', () => (onClick ? onClick() : showMain()));
    n.show();
  } catch (_) { /* ignore */ }
}

function startOcclusionWatch() {
  if (!IS_WIN) return;
  setInterval(() => {
    const g = config.global;
    let info = null;
    if (g.pauseOnFullscreen || g.pauseOnMaximized) {
      try { info = platform.foregroundInfo(process.pid); } catch (_) { info = null; }
    }
    for (const m of monitors.monitors) {
      let occ = false;
      if (info) {
        const r = info.rect; const t = m.rect;
        const covers = r.x <= t.x && r.y <= t.y && r.x + r.width >= t.x + t.width && r.y + r.height >= t.y + t.height;
        const cx = r.x + r.width / 2; const cy = r.y + r.height / 2;
        const inside = cx >= t.x && cx < t.x + t.width && cy >= t.y && cy < t.y + t.height;
        if (g.pauseOnFullscreen && covers && !info.maximized) occ = true;
        if (g.pauseOnFullscreen && covers && info.maximized) occ = true; // borderless fullscreen games report maximized
        if (g.pauseOnMaximized && info.maximized && inside) occ = true;
      }
      scheduler.setOccluded(m.id, occ);
      // A fullscreen game or film over the main monitor: the wallpaper's music waits.
      if (music && musicMonitor() && musicMonitor().id === m.id) {
        const r = info && info.rect; const t = m.rect;
        music.setPaused(!!(r && g.pauseOnFullscreen && r.x <= t.x && r.y <= t.y && r.x + r.width >= t.x + t.width && r.y + r.height >= t.y + t.height));
      }
    }
  }, 1500);
}

function applyStartup() {
  if (!IS_WIN || !app.isPackaged) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: !!config.global.startWithWindows,
      path: process.execPath,
      args: ['--startup'],
      name: 'Chimpanzé Wallpapers',
    });
  } catch (err) { log.error('login item', err); }
}

// ---------------------------------------------------------------------------
// Windows

function createMainWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const width = Math.min(1320, Math.round(wa.width * 0.86));
  const height = Math.min(860, Math.round(wa.height * 0.88));
  mainWin = new BrowserWindow({
    width, height,
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + (wa.height - height) / 2),
    minWidth: 980,
    minHeight: 640,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    title: 'Chimpanzé Wallpapers',
    icon: themeIcon(256),
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: false, spellcheck: false, backgroundThrottling: false },
  });
  mainWin.setMenu(null);
  mainWin.loadURL('cwp://app/index.html');
  // If the window's page dies (out of memory, GPU reset…) say why in the log and bring it back.
  mainWin.webContents.on('render-process-gone', (_e, d) => {
    log.error('janela: a página caiu', d.reason, 'código', d.exitCode);
    if (d.reason !== 'clean-exit' && mainWin && !mainWin.isDestroyed()) setTimeout(() => { try { mainWin.webContents.reload(); } catch (_) { /* ignore */ } }, 800);
  });
  mainWin.webContents.on('unresponsive', () => log.warn('janela: a página parou de responder'));
  mainWin.webContents.on('responsive', () => log.info('janela: a página voltou a responder'));
  mainWin.once('ready-to-show', () => {
    mainWin.setOpacity(Math.max(0.25, Math.min(1, config.global.uiOpacity || 1)));
    mainWin.show();
  });
  mainWin.on('close', () => {
    if (compact) compact = false;
  });
  mainWin.on('closed', () => { mainWin = null; });
  mainWin.on('maximize', () => broadcast('window', { maximized: true }));
  mainWin.on('unmaximize', () => broadcast('window', { maximized: false }));
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/** 1.2.x downloaded a local FLUX engine (~13 GB). It is no longer used: give the space back. */
function cleanupLegacyAi() {
  const bootAt = Date.now();
  setTimeout(() => {
    const ia = path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'ChimpanzeWallpapers', 'ia');
    if (fs.existsSync(ia)) fs.promises.rm(ia, { recursive: true, force: true }).then(() => log.info('limpeza: removido', ia)).catch((err) => log.warn('limpeza falhou', ia, err.message));
    // Editor scratch files from previous sessions only (never the ones in use now).
    const cache = path.join(app.getPath('userData'), 'cache', 'editor');
    try {
      for (const f of fs.readdirSync(cache)) {
        const full = path.join(cache, f);
        try { if (fs.statSync(full).mtimeMs < bootAt) fs.rmSync(full, { recursive: true, force: true }); } catch (_) { /* ignore */ }
      }
    } catch (_) { /* no cache yet */ }
  }, 8000);
}

function showMain() {
  if (!mainWin) createMainWindow();
  else {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
    broadcast('window', { shown: true });
  }
}

function hideMain() {
  // Destroying the window (instead of hiding it) gives its ~100-150 MB of RAM back;
  // the app keeps running in the tray and reopens it in a moment when needed.
  if (!mainWin) return;
  compact = false;
  mainWin.destroy();
  mainWin = null;
}

function setCompact(on) {
  if (!mainWin) return;
  if (on === compact) return;
  compact = on;
  const disp = screen.getDisplayMatching(mainWin.getBounds());
  if (on) {
    normalBounds = mainWin.getBounds();
    if (mainWin.isMaximized()) mainWin.unmaximize();
    mainWin.setMinimumSize(340, 120);
    const n = Math.max(1, monitors.monitors.length);
    const w = 400; const h = Math.min(disp.workArea.height - 40, 112 + n * 86);
    const corner = config.global.compactCorner || 'br';
    const x = corner.endsWith('l') ? disp.workArea.x + 20 : disp.workArea.x + disp.workArea.width - w - 20;
    const y = corner.startsWith('t') ? disp.workArea.y + 20 : disp.workArea.y + disp.workArea.height - h - 20;
    mainWin.setAlwaysOnTop(true, 'floating');
    mainWin.setBounds({ x, y, width: w, height: h }, true);
  } else {
    mainWin.setAlwaysOnTop(false);
    mainWin.setMinimumSize(980, 640);
    if (normalBounds) mainWin.setBounds(normalBounds, true);
  }
  broadcast('window', { compact });
}

function identifyMonitors() {
  for (const w of overlays) { try { w.destroy(); } catch (_) { /* ignore */ } }
  overlays.clear();
  const displays = screen.getAllDisplays();
  for (const m of monitors.monitors) {
    const d = displays.find((x) => x.id === m.displayId) || displays[0];
    const w = new BrowserWindow({
      ...d.bounds,
      frame: false, transparent: true, backgroundColor: '#00000000', alwaysOnTop: true, focusable: false,
      skipTaskbar: true, resizable: false, movable: false, hasShadow: false, show: false, roundedCorners: false,
      webPreferences: { contextIsolation: true },
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setIgnoreMouseEvents(true);
    const q = new URLSearchParams({
      n: String(m.index), name: m.name, res: `${m.rect.width}×${m.rect.height}`,
      hz: String(m.refreshRate || ''), primary: m.primary ? '1' : '0',
    });
    w.loadURL(`cwp://app/overlay.html?${q}`);
    w.once('ready-to-show', () => w.showInactive());
    overlays.add(w);
    setTimeout(() => { try { w.destroy(); } catch (_) { /* ignore */ } overlays.delete(w); }, 3600);
  }
}

// ---------------------------------------------------------------------------
// Tray

/** The icon of the current theme (light / dark / brown: John's three versions of the mascot). */
function themeIcon(size) {
  const t = (config && config.global.theme) || 'cocoa';
  const name = t === 'light' ? 'light' : t === 'dark' ? 'dark' : 'cocoa';
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'dist', `logo-${name}.png`));
  if (img.isEmpty()) return nativeImage.createFromPath(resource(size <= 32 ? 'tray.png' : 'icon.png'));
  return size ? img.resize({ width: size, height: size, quality: 'best' }) : img;
}
/** Window, taskbar and tray follow the theme (the .exe / shortcut icon is fixed by Windows: brown). */
function applyThemeIcon() {
  try {
    if (mainWin && !mainWin.isDestroyed()) mainWin.setIcon(themeIcon(256));
    if (tray && !tray.isDestroyed()) tray.setImage(themeIcon(32));
  } catch (err) { log.warn('ícone do tema', err.message); }
}

function createTray() {
  const img = themeIcon(32);
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('Chimpanzé Wallpapers');
  tray.on('click', () => showMain());
  tray.on('double-click', () => showMain());
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const online = monitors ? monitors.monitors : [];
  const nextItems = online.filter((m) => hasContent(m.id)).map((m) => ({
    label: `Próximo — ${m.index}. ${m.name}`,
    click: () => scheduler.next(m.id).catch(() => {}),
  }));
  const menu = Menu.buildFromTemplate([
    { label: 'Abrir Chimpanzé Wallpapers', click: () => showMain() },
    { type: 'separator' },
    {
      label: 'Próximo wallpaper (todos)',
      click: () => online.filter((m) => hasContent(m.id)).forEach((m) => scheduler.next(m.id).catch(() => {})),
    },
    ...(nextItems.length > 1 ? [{ label: 'Próximo em…', submenu: nextItems }] : []),
    {
      label: scheduler && scheduler.globalPaused ? 'Retomar trocas automáticas' : 'Pausar trocas automáticas',
      click: () => setPaused(!scheduler.globalPaused),
    },
    { label: 'Identificar monitores', click: () => identifyMonitors() },
    { type: 'separator' },
    { label: 'Sair', click: () => quit() },
  ]);
  tray.setContextMenu(menu);
}

/** Plays the music of the wallpaper on the main monitor (or stops, if it has none). */
/** The monitor whose wallpaper sets the music: the one chosen (global.music.follow), else the main one. */
function musicMonitor() {
  const f = (config.global.music || {}).follow;
  return (f && monitors.monitors.find((x) => x.id === f)) || monitors.monitors.find((x) => x.primary) || monitors.monitors[0] || null;
}
function syncMusic() {
  if (!music || !monitors) return;
  const m = musicMonitor();
  const cfg = m ? config.monitor(m.id) : null;
  music.sync(cfg ? cfg.fixed || cfg.current : null);
}

function quit() {
  quitting = true;
  app.quit();
}

app.on('child-process-gone', (_e, d) => { if (d.reason !== 'clean-exit' && d.reason !== 'killed') log.error('processo caiu', d.type, d.name || '', d.reason, 'código', d.exitCode); });

app.on('before-quit', () => {
  quitting = true;
  try { if (scheduler) scheduler.syncAllForExit(); } catch (err) { log.error('sync exit', err); }
  try { if (config) config.saveNow(); } catch (_) { /* ignore */ }
  try { if (hosts) hosts.destroyAll(); } catch (_) { /* ignore */ }
  try { if (shortcuts) shortcuts.dispose(); else globalShortcut.unregisterAll(); } catch (_) { /* ignore */ }
  try { if (localAi) localAi.stop(); } catch (_) { /* ignore */ }
  try { if (music) music.destroy(); } catch (_) { /* ignore */ }
});

app.on('window-all-closed', (e) => {
  // Keep running in the tray.
  if (!quitting) e.preventDefault();
});

// ---------------------------------------------------------------------------
// State for the UI

function publicState() {
  const online = monitors.monitors;
  const onlineIds = new Set(online.map((m) => m.id));
  const offline = Object.values(config.data.monitors)
    .filter((c) => !onlineIds.has(c.id))
    .map((c) => ({ id: c.id, name: c.alias || c.name || 'Monitor', rect: c.lastRect, lastSeen: c.lastSeen, offline: true }));
  return {
    version: app.getVersion(),
    platform: process.platform,
    raisedDesktop: IS_WIN ? safe(() => platform.isRaisedDesktop(), false) : false,
    depthModel: require('./ai/depth').exists(),
    monitors: online,
    offline,
    config: config.data,
    scheduler: scheduler.snapshot(),
    compact,
    tools: tools.status(),
    logFile: log.file,
    migratedFrom: config.data.migratedFrom || null,
  };
}

function safe(fn, fallback) { try { return fn(); } catch (_) { return fallback; } }

/** The picture is in a folder of the app's gallery (a monitor's folder, or below it with subfolders on). */
function inGallery(file) {
  const f = path.resolve(file).toLowerCase();
  return Object.values(config.data.monitors).some((c) => {
    if (!c.folder) return false;
    const dir = path.resolve(c.folder).toLowerCase() + path.sep;
    if (!f.startsWith(dir)) return false;
    const rest = f.slice(dir.length);
    return !rest.includes(path.sep) || (c.includeSubfolders && !/(^|[\\/])_(4k|editado|backup)([\\/]|$)/i.test(rest));
  });
}

function imageDepthInfo(file) {
  const cuts = require('./ai/depth').CUTS;
  const o = config.image(file);
  const cut = Math.min(cuts.length - 1, o.cut || 0);
  return { off: o.depth === false, cut, label: cuts[cut], count: cuts.length, fix: !!o.fix };
}

// ---------------------------------------------------------------------------
// Settings changes (from the UI and from the global shortcuts)

function setGlobal(patch) {
  const g = config.updateGlobal(patch);
  if (patch && 'startWithWindows' in patch) applyStartup();
  if (patch && 'uiOpacity' in patch && mainWin) mainWin.setOpacity(Math.max(0.25, Math.min(1, g.uiOpacity)));
  if (patch && 'theme' in patch) applyThemeIcon();
  for (const m of monitors.monitors) {
    const host = hosts.get(m.id);
    if (host) host.setSettings(scheduler.rendererSettings(config.monitor(m.id)));
  }
  if (patch && ('parallax' in patch || 'parallaxBlink' in patch || 'reduceMotion' in patch)) scheduler.refreshDepth();
  if (patch && 'shortcuts' in patch && shortcuts) broadcast('shortcuts', shortcuts.apply());
  if (patch && 'music' in patch) syncMusic();
  updatePointerTimer();
  broadcast('state', publicState());
  return g;
}

function setMonitor(id, patch) {
  const prev = Object.assign({}, config.monitor(id));
  const m = config.updateMonitor(id, patch);
  const host = hosts.get(id);
  if (host) host.setSettings(scheduler.rendererSettings(m));
  const contentChanged = patch && ('folder' in patch || 'fixed' in patch || 'enabled' in patch || 'includeSubfolders' in patch);
  if (contentChanged) {
    const wasActive = hosts.get(id);
    syncHosts();
    if (wasActive && hasContent(id) && ('folder' in patch || 'includeSubfolders' in patch) && patch.folder !== prev.folder) {
      scheduler.st(id).bag = [];
      scheduler.next(id).catch(() => {});
    }
  }
  if (patch && ('intervalSec' in patch || 'auto' in patch || 'fixed' in patch)) scheduler.reschedule(id);
  scheduler.emitState();
  broadcast('state', publicState());
  updateTrayMenu();
  return m;
}

function setPaused(p) {
  scheduler.setGlobalPaused(p);
  updateTrayMenu();
  broadcast('state', publicState());
  return scheduler.globalPaused;
}

// ---------------------------------------------------------------------------
// Global shortcuts: they act on the monitor under the mouse (+Alt: every monitor)

/** Short on-screen confirmation: an in-app toast when the window is in front, else a Windows notification. */
let lastNote = null;
function feedback(title, message, kind = 'info') {
  if (mainWin && !mainWin.isDestroyed() && mainWin.isVisible() && mainWin.isFocused()) {
    broadcast('toast', { kind, title, message });
    return;
  }
  const sc = config.global.shortcuts || {};
  if (sc.notify === false) return;
  try {
    if (!Notification.isSupported()) return;
    if (lastNote) { try { lastNote.close(); } catch (_) { /* ignore */ } }
    const n = new Notification({ title, body: message || '', icon: resource('icon.png'), silent: true });
    n.on('click', () => showMain());
    n.show();
    lastNote = n;
  } catch (_) { /* ignore */ }
}

function cursorMonitor() {
  const online = monitors.monitors;
  if (!online.length) return null;
  const pt = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(pt);
  return online.find((m) => m.displayId === d.id)
    || online.find((m) => m.rect && pt.x >= m.rect.x && pt.y >= m.rect.y && pt.x < m.rect.x + m.rect.width && pt.y < m.rect.y + m.rect.height)
    || online.find((m) => m.primary) || online[0];
}

async function runShortcut(id, { all }) {
  const label = (m) => `${m.index}. ${monitorName(m.id)}`;
  const targets = () => {
    if (all) return monitors.monitors.filter((m) => hasContent(m.id));
    const m = cursorMonitor();
    return m ? [m] : [];
  };
  switch (id) {
    case 'window':
      if (mainWin && mainWin.isVisible() && mainWin.isFocused()) hideMain(); else showMain();
      return;
    case 'pause': {
      const p = setPaused(!scheduler.globalPaused);
      feedback(p ? 'Trocas pausadas' : 'Trocas retomadas', p ? 'Os wallpapers ficam parados até você retomar.' : 'Os wallpapers voltam a trocar sozinhos.', p ? 'warn' : 'ok');
      return;
    }
    case 'parallax': {
      if (!require('./ai/depth').exists()) { feedback('Profundidade 3D indisponível', 'Baixe em Ajustes → Recursos de IA.', 'warn'); return; }
      const on = !config.global.parallax;
      setGlobal({ parallax: on });
      feedback(on ? 'Profundidade 3D ligada' : 'Profundidade 3D desligada', on ? 'Os wallpapers ganham movimento em camadas.' : 'Os wallpapers ficam parados (sem parallax).', on ? 'ok' : 'info');
      return;
    }
    case 'blink': {
      const on = config.global.parallaxBlink === false;
      setGlobal({ parallaxBlink: on });
      feedback(on ? 'Piscar dos olhos ligado' : 'Piscar dos olhos desligado', on ? 'Personagens de anime piscam de vez em quando.' : 'Os olhos ficam abertos.', on ? 'ok' : 'info');
      return;
    }
    case 'next':
    case 'prev': {
      const list = targets();
      if (!list.length) { feedback('Nenhum monitor com wallpaper', 'Escolha uma pasta na página Monitores.', 'warn'); return; }
      for (const m of list) {
        const c = config.monitor(m.id);
        if (!c.enabled || !c.folder) {
          if (!all) feedback(label(m), c.fixed ? 'Este monitor tem um wallpaper fixo e nenhuma pasta para trocar.' : 'Este monitor não tem pasta de wallpapers.', 'warn');
          continue;
        }
        // "Next" on a pinned monitor means you want something else: unpin it first.
        if (c.fixed) { setMonitor(m.id, { fixed: '' }); if (!all) feedback(label(m), 'Wallpaper solto: voltou a trocar sozinho.', 'info'); }
        const job = id === 'next' ? scheduler.next(m.id) : scheduler.prev(m.id);
        job.then((item) => { if (id === 'prev' && !item && !all) feedback(label(m), 'Não há wallpaper anterior.', 'info'); })
          .catch((err) => feedback(label(m), err.message, 'error'));
      }
      return;
    }
    case 'depthImage':
    case 'recut': {
      const list = targets().filter((m) => hasContent(m.id) && /.(jpe?g|png|webp|bmp|avif)$/i.test(config.monitor(m.id).current || ''));
      if (!list.length) { feedback('Nenhuma imagem no ar', 'Este monitor não está mostrando uma imagem do app.', 'warn'); return; }
      const files = [...new Set(list.map((m) => config.monitor(m.id).current))];
      if (id === 'depthImage') {
        const on = files.some((f) => config.image(f).depth === false);
        for (const f of files) { config.setImage(f, { depth: on ? undefined : false }); scheduler.redisplayFile(f); }
        broadcast('state', publicState());
        feedback(on ? '3D ligado neste wallpaper' : '3D desligado neste wallpaper', on ? 'Esta imagem volta a se mover em camadas.' : 'Esta imagem fica parada; as outras continuam em 3D.', on ? 'ok' : 'info');
        return;
      }
      const depth = require('./ai/depth');
      if (!depth.exists()) { feedback('Profundidade 3D indisponível', 'Baixe em Ajustes → Recursos de IA.', 'warn'); return; }
      feedback('Refazendo o recorte…', 'A IA está recortando os personagens de outro jeito.', 'info');
      for (const f of files) {
        const v = ((config.image(f).cut || 0) + 1) % depth.CUTS.length;
        try {
          await scheduler.recut(f, v);
          feedback(v ? `Recorte: tentativa ${v} de ${depth.CUTS.length - 1}` : 'Recorte automático de volta', depth.CUTS[v], 'ok');
        } catch (err) { feedback('Não deu para refazer o recorte', err.message, 'error'); }
      }
      broadcast('state', publicState());
      return;
    }
    case 'pin': {
      const list = targets().filter((m) => hasContent(m.id));
      if (!list.length) { feedback('Nada para fixar', 'Este monitor não está mostrando um wallpaper do app.', 'warn'); return; }
      // With Alt: if any monitor is loose, pin them all; otherwise unpin them all.
      const pin = list.some((m) => !config.monitor(m.id).fixed);
      for (const m of list) {
        const c = config.monitor(m.id);
        if (pin && !c.fixed && c.current) setMonitor(m.id, { fixed: c.current });
        else if (!pin && c.fixed) setMonitor(m.id, { fixed: '' });
      }
      const who = all ? 'Todos os monitores' : label(list[0]);
      feedback(pin ? 'Wallpaper fixado' : 'Wallpaper solto', pin ? `${who}: fica neste wallpaper até você soltar.` : `${who}: volta a trocar sozinho.`, 'ok');
      return;
    }
    default:
  }
}

// ---------------------------------------------------------------------------
// IPC

function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, async (e, ...args) => fn(...args, e));

  h('state', () => publicState());

  h('config:global', (patch) => setGlobal(patch));
  h('config:monitor', (id, patch) => setMonitor(id, patch));
  // A shortcut that failed may be free now (the other program closed): try again.
  h('shortcuts:status', () => (shortcuts.hasFailures() ? shortcuts.apply() : shortcuts.status()));
  h('shortcuts:suspend', (on) => shortcuts.suspend(on));

  h('monitor:forget', (id) => { config.forgetMonitor(id); broadcast('state', publicState()); return true; });
  h('monitor:next', async (id) => { await scheduler.next(id); return true; });
  h('monitor:prev', async (id) => scheduler.prev(id));
  h('monitor:apply', (id, file, opts) => {
    const c = config.monitor(id);
    if (!c.folder && !c.fixed) { c.fixed = file; config.save(); syncHosts(); }
    scheduler.apply(id, file, opts || {});
    broadcast('state', publicState());
    return true;
  });
  h('monitors:rescan', () => { monitors.scan(true); return publicState(); });
  h('monitors:identify', () => { identifyMonitors(); return true; });
  h('scheduler:pause', (p) => setPaused(p));

  h('dialog:folder', async (title) => {
    const r = await dialog.showOpenDialog(mainWin, { title: title || 'Escolha uma pasta', properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  h('dialog:files', async (opts) => {
    const r = await dialog.showOpenDialog(mainWin, {
      title: (opts && opts.title) || 'Escolha arquivos',
      properties: ['openFile'].concat(opts && opts.multi ? ['multiSelections'] : []),
      filters: (opts && opts.filters) || [{ name: 'Imagens', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'avif', 'jfif'] }],
    });
    return r.canceled ? [] : r.filePaths;
  });

  // Optional AI packages (downloaded by the app; the installer only notes what was ticked).
  components = new (require('./components').Components)();
  components.on('status', (list) => broadcast('components', list));
  components.on('installed', (id) => {
    if (id === 'depth') scheduler.refreshDepth();
    broadcast('state', publicState());
    broadcast('toast', { kind: 'ok', title: 'Recurso de IA instalado', message: require('./components').LIST[id].label });
  });
  h('components:list', () => components.list());
  h('components:install', (id) => components.install(id));
  h('components:remove', (id) => components.remove(id));
  setTimeout(() => {
    components.fromInstaller().then((ids) => { if (ids.length) log.info('recursos: baixados a pedido do instalador', ids.join(', ')); }).catch(() => {});
  }, 4000);
  h('media:list', async (folder, opts) => library.listMediaDetailed(folder, opts || {}));
  // Galeria: organize the wallpaper folders from the app (copy in, move, Recycle Bin, new folder).
  const gallery = require('./gallery-ops').create({ config, scheduler, broadcast });
  h('gallery:add', (folder, files) => gallery.add(folder, files));
  h('gallery:move', (files, dest) => gallery.move(files, dest));
  h('gallery:trash', (files) => gallery.trash(files));
  h('gallery:mkdir', (parent, name) => gallery.mkdir(parent, name));
  h('gallery:subfolders', (folder) => gallery.subfolders(folder));
  h('media:thumb', async (file) => {
    const t = await library.thumbnail(file);
    return t ? proto.mediaUrl(t) : null;
  });
  h('media:url', (file) => proto.mediaUrl(file));
  h('media:size', (file) => library.imageSize(file));
  // Per-picture depth: switch the 3D off/on for one wallpaper, and redo its cut.
  // Music of a wallpaper (YouTube): search, listen, keep.
  h('music:status', () => music.status());
  h('music:search', (q) => require('./music').search(String(q || '')));
  h('music:preview', (t) => { if (t && t.id) music.play(t.id, t.title, null, true); return music.status(); });
  h('music:stopPreview', () => { music.endPreview(); syncMusic(); return music.status(); });
  h('music:show', () => { music.show(); return true; });
  h('music:toggle', () => music.toggle());
  h('music:seek', (t) => music.seek(t));
  h('music:login', () => { music.login(); return true; });
  h('music:account', () => music.checkAccount());
  h('music:setCat', (files, catId) => {
    for (const f of [].concat(files || [])) config.setImage(f, { musicCat: catId || undefined });
    syncMusic();
    broadcast('state', publicState());
    return true;
  });
  h('music:next', () => { if (music.current && music.current.cat) { const c = music.categories().find((x) => x.id === music.current.cat); const t = c && music.draw(c, music.current.id); if (t) { const { file, cat } = music.current; music.current = null; music.play(t.id, t.title, file, false, cat); } } return music.status(); });
  h('music:set', (file, t) => {
    config.setImage(file, { music: t && t.id ? t : undefined });
    music.endPreview();
    syncMusic();
    broadcast('state', publicState());
    return config.image(file).music || null;
  });
  h('image:depth', (file) => imageDepthInfo(file));
  // Own look of one wallpaper (movement preset/strength/speed) and whether its eyes blink.
  const imageLook = (file) => { const o = config.image(file); return { look: o.look || null, blink: o.blink !== false }; };
  h('image:look', (file) => imageLook(file));
  h('image:look:set', (file, patch) => {
    const p = {};
    if (patch && 'look' in patch) p.look = patch.look || undefined;
    if (patch && 'blink' in patch) p.blink = patch.blink ? undefined : false;
    config.setImage(file, p);
    // Monitors showing this picture take the new look at once.
    const key = String(file).toLowerCase();
    for (const m of monitors.monitors) {
      const cfg = config.monitor(m.id);
      const host = hosts.get(m.id);
      if (host && String(cfg.fixed || cfg.current || '').toLowerCase() === key) host.setSettings(scheduler.rendererSettings(cfg));
    }
    if (patch && 'blink' in patch) scheduler.redisplayFile(file);
    broadcast('state', publicState());
    return imageLook(file);
  });
  h('image:depth:set', (file, on) => {
    config.setImage(file, { depth: on ? undefined : false });
    scheduler.redisplayFile(file);
    broadcast('state', publicState());
    return imageDepthInfo(file);
  });
  h('image:recut', async (file, mode) => {
    const n = require('./ai/depth').CUTS.length;
    const cur = config.image(file).cut || 0;
    const v = mode === 'auto' ? 0 : mode === 'prev' ? (cur + n - 1) % n : typeof mode === 'number' ? Math.max(0, Math.min(n - 1, mode | 0)) : (cur + 1) % n;
    await scheduler.recut(file, v);
    broadcast('state', publicState());
    return imageDepthInfo(file);
  });
  // "Corrigir recorte à mão": the current cut + the user's corrections, and saving them.
  h('image:cut:get', async (file) => {
    const depth = require('./ai/depth');
    if (!depth.exists()) return null;
    const shown = scheduler.shownFor(file);
    const d = await depth.get(shown, config.image(file).cut || 0);
    const fix = depth.fixFor(shown);
    return { image: proto.mediaUrl(shown), matte: proto.mediaUrl(d.depth) + '?t=' + Date.now(), fix: fix ? proto.mediaUrl(fix) + '?t=' + Date.now() : null };
  });
  // "Clique mágico": the whole object under a click (Segment Anything), as a grey mask.
  h('image:cut:magic', async (file, points) => {
    const sam = require('./ai/sam');
    if (!sam.exists()) throw new Error('O clique mágico não está instalado. Baixe em Ajustes → Recursos de IA.');
    const r = await sam.segment(scheduler.shownFor(file), points);
    return { png: new Uint8Array(r.png), share: r.share, score: r.score };
  });
  h('image:cut:save', async (file, bytes) => {
    const depth = require('./ai/depth');
    depth.saveFix(scheduler.shownFor(file), bytes || null);
    config.setImage(file, { fix: bytes ? Date.now() : undefined });
    await scheduler.recut(file, config.image(file).cut || 0);
    broadcast('state', publicState());
    return imageDepthInfo(file);
  });
  h('image:cutPreview', async (file) => {
    const depth = require('./ai/depth');
    if (!depth.exists()) return null;
    const d = await depth.get(scheduler.shownFor(file), config.image(file).cut || 0);
    return proto.mediaUrl(d.depth);
  });
  h('shell:open', (p) => shell.openPath(p));
  h('shell:reveal', (p) => { shell.showItemInFolder(p); return true; });
  h('shell:external', (url) => { if (/^https?:/.test(url)) shell.openExternal(url); return true; });

  // Window controls
  h('win:minimize', () => mainWin && mainWin.minimize());
  h('win:maximize', () => { if (!mainWin) return; if (mainWin.isMaximized()) mainWin.unmaximize(); else mainWin.maximize(); });
  h('win:hide', () => hideMain());
  h('win:quit', () => quit());
  h('win:compact', (on) => { setCompact(!!on); return compact; });
  h('win:opacity', (v) => { if (mainWin) mainWin.setOpacity(Math.max(0.02, Math.min(1, Number(v) || 1))); return true; });

  // Upscale
  h('upscale:classify', async (file) => upscaler.classify(file));
  h('upscale:models', () => upscaler.MODELS);
  h('upscale:plan', () => ({ kinds: upscaler.KINDS, levels: upscaler.LEVELS, plan: upscaler.PLAN, models: upscaler.MODELS }));
  const upWork = () => { const d = path.join(app.getPath('userData'), 'cache', 'upscale'); fs.mkdirSync(d, { recursive: true }); return d; };
  const quietCtx = (tag) => ({ progress: (p, s) => broadcast('upscale:test', { tag, progress: p, stage: s || '' }), stage: (s) => broadcast('upscale:test', { tag, stage: s }), onCancel: () => {}, checkCanceled: () => {} });
  /** "Testar num pedaço": a piece of the picture, upscaled at the size the whole one will have. */
  h('upscale:test', async (file, overrides) => {
    const sharp = require('./img');
    const settings = Object.assign({}, config.global.upscale, overrides || {}, { skipIfLarger: false, format: 'png' });
    const m = await sharp(file, { limitInputPixels: false }).rotate().metadata();
    const full = upscaler.computeTarget({ width: m.width, height: m.height }, settings.target || '4k', monitors.monitors);
    const cw = Math.min(m.width, Math.max(160, Math.round(m.width * 0.36))), ch = Math.min(m.height, Math.max(160, Math.round(m.height * 0.36)));
    const left = Math.round((m.width - cw) / 2), top = Math.max(0, Math.round(m.height * 0.38 - ch / 2));
    const dir = upWork();
    const piece = path.join(dir, `piece-${Date.now().toString(36)}.png`);
    await sharp(file, { limitInputPixels: false }).rotate().extract({ left, top, width: cw, height: ch }).png({ compressionLevel: 1 }).toFile(piece);
    const res = await upscaler.upscaleImage(piece, Object.assign(settings, { factor: Math.max(1.01, full.factor) }), quietCtx('test'), { monitors: monitors.monitors, outputDir: path.join(dir, 'out') });
    return { before: piece, after: res.output, width: res.width, height: res.height, model: res.model, kind: res.kind, level: res.level, strength: res.strength, factor: full.factor };
  });
  /** Whole picture into a temporary file: the Upscale page shows it for "Manter" / "Refazer" first. */
  h('upscale:studio', (file, overrides) => {
    const settings = Object.assign({}, config.global.upscale, overrides || {}, { skipIfLarger: false });
    return jobs.add('upscale', path.basename(file), (ctx) => upscaler.upscaleImage(file, settings, ctx, { monitors: monitors.monitors, outputDir: path.join(upWork(), 'studio') }), { file, studio: true });
  });
  h('upscale:keep', async (tmp, source) => {
    const dir = path.join(path.dirname(source), library.UPSCALE_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const name = path.parse(source).name;
    for (const ext of ['.png', '.jpg', '.webp']) fs.rmSync(path.join(dir, name + ext), { force: true });
    const out = path.join(dir, name + path.extname(tmp));
    fs.copyFileSync(tmp, out);
    fs.rmSync(tmp, { force: true });
    broadcast('media-changed', { folder: path.dirname(source) });
    return out;
  });
  h('upscale:discard', (tmp) => { if (tmp && path.resolve(tmp).startsWith(path.resolve(upWork()))) fs.rmSync(tmp, { force: true }); return true; });
  h('upscale:start', (files, overrides) => {
    const ids = [];
    for (const file of files) {
      const settings = Object.assign({}, config.global.upscale, overrides || {});
      ids.push(jobs.add('upscale', path.basename(file), async (ctx) => {
        const res = await upscaler.upscaleImage(file, settings, ctx, { monitors: monitors.monitors, outputDir: overrides && overrides.outputDir });
        if (!res.skipped) broadcast('media-changed', { folder: path.dirname(file) });
        return res;
      }, { file }));
    }
    return ids;
  });

  // Jobs
  h('jobs:list', () => jobs.list());
  h('jobs:cancel', (id) => jobs.cancel(id));
  h('jobs:clear', () => { jobs.clearFinished(); return jobs.list(); });

  // Editor
  const workDir = () => { const d = path.join(app.getPath('userData'), 'cache', 'editor'); fs.mkdirSync(d, { recursive: true }); return d; };
  const workFile = (ext = '.png') => path.join(workDir(), `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}${ext}`);
  h('editor:bestBase', (file) => library.upscaledPathFor(file) || null);
  h('editor:erase', async (base, maskBytes) => {
    const maskFile = workFile('.mask.png');
    fs.writeFileSync(maskFile, Buffer.from(maskBytes));
    const out = workFile();
    try { await lama.erase(base, maskFile, out); } finally { fs.rmSync(maskFile, { force: true }); }
    return out;
  });
  // "Proteger personagem" (Expandir): the character matte of the picture being edited,
  // as the packed depth PNG (blue channel = how much of each pixel is character).
  h('editor:characterMask', async (file) => {
    const depth = require('./ai/depth');
    if (!depth.exists()) return null;
    const d = await depth.get(file, 0);
    return d && d.depth ? proto.mediaUrl(d.depth) : null;
  });
  h('editor:writeTemp', (bytes) => { const f = workFile(); fs.writeFileSync(f, Buffer.from(bytes)); return f; });
  // "Encaixe automático": where the pasted picture sits in the edited one (worker thread).
  h('editor:autoAlign', (basePath, layerPath) => new Promise((resolve, reject) => {
    const { Worker } = require('worker_threads');
    const w = new Worker(path.join(__dirname, 'align-worker.js'), { workerData: { base: basePath, layer: layerPath } });
    const t0 = Date.now();
    w.once('message', (m) => {
      w.terminate();
      if (m.ok) { log.info('editor: encaixe automático', JSON.stringify(m.r.px), 'confiança', m.r.score.toFixed(3), `${Date.now() - t0} ms`); resolve(m.r); } else reject(new Error(m.error));
    });
    w.once('error', (err) => reject(err));
  }));
  // Picture copied to the clipboard (e.g. "Copiar imagem" in ChatGPT), saved as a work file.
  h('editor:clipboardImage', () => {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    const f = workFile();
    fs.writeFileSync(f, img.toPNG());
    return f;
  });

  // ChatGPT desktop app bridge (expand / remove / enhance through the user's own ChatGPT).
  chatgpt = new (require('./chatgpt').ChatGptBridge)({ platform, workDir });
  chatgpt.on('status', (st) => broadcast('chatgpt:status', st));
  let pendingResult = null;
  chatgpt.on('result', (r) => {
    pendingResult = r;
    showMain();
    setTimeout(() => broadcast('chatgpt:result', r), 600);
    try { new Notification({ title: 'Chimpanzé Wallpapers', body: 'Imagem do ChatGPT recebida. Escolha o que fazer com ela.' }).show(); } catch (_) { /* ignore */ }
  });
  h('chatgpt:status', async () => ({ ...chatgpt.status(), installed: !!(await require('./chatgpt').findApp()) }));
  h('chatgpt:send', async (opts) => {
    const g = config.global.chatgpt || {};
    try {
      return await chatgpt.send({ autoType: g.autoType !== false, autoSend: g.autoSend !== false, newChat: g.newChat !== false, ...opts });
    } catch (err) {
      // The page shows its own "install ChatGPT" notice (with a Store button).
      if (err.notInstalled) return { auto: false, notInstalled: true };
      throw err;
    }
  });
  h('chatgpt:pending', () => { const r = pendingResult; pendingResult = null; return r; });
  h('chatgpt:ack', () => { pendingResult = null; return true; });
  h('chatgpt:store', () => shell.openExternal(require('./chatgpt').STORE_URL));
  h('chatgpt:cancel', () => { chatgpt.cancel(); return chatgpt.status(); });
  h('chatgpt:copyImage', (file) => chatgpt.copyImage(file));
  h('chatgpt:copyText', (text) => chatgpt.copyText(text));
  h('chatgpt:pickFile', async () => {
    const r = await dialog.showOpenDialog(mainWin, { title: 'Imagem que veio do ChatGPT', defaultPath: app.getPath('downloads'), filters: [{ name: 'Imagens', extensions: ['png', 'jpg', 'jpeg', 'webp'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const meta = await require('./img')(r.filePaths[0]).metadata();
    return { file: r.filePaths[0], via: 'manual', width: meta.width, height: meta.height };
  });
  h('chatgpt:save', async (opts) => {
    // "Salvar como…": the user picks the folder and the name first (nothing starts if canceled).
    let saveTo = null;
    if (opts.saveAs) {
      const p = path.parse(opts.source);
      const r = await dialog.showSaveDialog(mainWin, {
        title: 'Salvar a imagem expandida',
        defaultPath: path.join(p.dir, `${p.name} (expandido).png`),
        filters: [{ name: 'PNG (sem perdas)', extensions: ['png'] }, { name: 'JPG', extensions: ['jpg', 'jpeg'] }, { name: 'WebP', extensions: ['webp'] }],
      });
      if (r.canceled || !r.filePath) return null;
      saveTo = r.filePath;
    }
    return saveExpansion(opts, saveTo);
  });
  const saveExpansion = (opts, saveTo) => jobs.add('upscale', (opts.upscale ? 'ChatGPT + 4K: ' : 'ChatGPT: ') + path.basename(saveTo || opts.source), async (ctx) => {
    let file = opts.file;
    if (opts.crop) {
      ctx.stage('Ajustando a proporção…');
      const tmp = workFile();
      const sharp = require('./img');
      const m = await sharp(file).metadata();
      let w = m.width; let hgt = m.height;
      if (Math.abs(w / hgt - opts.crop) > 0.02) {
        if (w / hgt > opts.crop) w = Math.round(hgt * opts.crop); else hgt = Math.round(w / opts.crop);
        await sharp(file).extract({ left: Math.round((m.width - w) / 2), top: Math.round((m.height - hgt) / 2), width: w, height: hgt }).png().toFile(tmp);
        file = tmp;
      }
    }
    if (opts.upscale) {
      const settings = Object.assign({}, config.global.upscale, { skipIfLarger: true });
      try {
        const res = await upscaler.upscaleImage(file, settings, ctx, { monitors: monitors.monitors, outputDir: workDir() });
        if (!res.skipped && res.output) file = res.output;
      } catch (err) {
        if (ctx.canceled) throw err;
        log.warn('chatgpt: upscale falhou, salvando sem upscale', err.message);
        broadcast('toast', { kind: 'warn', title: 'Upscale falhou', message: 'Salvei a imagem do ChatGPT sem o upscale: ' + err.message });
      }
    }
    ctx.stage('Salvando…');
    let out;
    if (saveTo) {
      const sharp = require('./img');
      const ext = path.extname(saveTo).toLowerCase();
      let img = sharp(file, { limitInputPixels: false });
      img = ext === '.jpg' || ext === '.jpeg' ? img.jpeg({ quality: 95, chromaSubsampling: '4:4:4', mozjpeg: true }) : ext === '.webp' ? img.webp({ quality: 95 }) : img.png({ compressionLevel: 6 });
      await img.toFile(saveTo);
      out = saveTo;
      broadcast('media-changed', { folder: path.dirname(saveTo) });
      broadcast('toast', { kind: 'ok', title: 'Imagem salva', message: saveTo });
      // Put on a monitor: the new file itself.
      if (opts.monitorId) scheduler.display(opts.monitorId, saveTo, {});
      return { output: out, width: 0, height: 0, model: '', kind: 'chatgpt', skipped: false };
    }
    out = await require('./chatgpt').saveResult({ file, source: opts.source }, { EDIT_DIR: library.EDIT_DIR });
    broadcast('media-changed', { folder: path.dirname(opts.source) });
    for (const m of monitors.monitors) {
      const c = config.data.monitors[m.id];
      if (opts.monitorId === m.id) scheduler.display(m.id, opts.source, {});
      else if (c && (c.current === opts.source || c.fixed === opts.source)) scheduler.display(m.id, opts.source, { noHistory: true });
    }
    return { output: out, width: 0, height: 0, model: '', kind: 'chatgpt', skipped: false };
  }, { file: opts.source, chatgpt: true });
  // "Juntar com o original": the untouched original goes back into an expansion (worker
  // thread, merge-core.js); paint that ChatGPT carried into the new areas is then filled by LaMa.
  /** Best unpainted version of the original: the 4K one, the picture itself, or its _Backup copy. */
  const pickOriginal = async (source) => {
    const sharp = require('./img');
    const { _test: { paintShare } } = require('./merge-core');
    const backup = path.join(path.dirname(source), library.BACKUP_DIR, path.basename(source));
    const list = [library.upscaledPathFor(source), source, fs.existsSync(backup) ? backup : null].filter(Boolean);
    for (const f of list) {
      try {
        const raw = await sharp(f, { limitInputPixels: false }).resize(320, 320, { fit: 'inside' }).removeAlpha().raw().toBuffer();
        if (paintShare(raw) < 0.002) return f;
      } catch (_) { /* unreadable: try the next */ }
    }
    return source;
  };
  h('expand:merge', async ({ source, expansion, aspect, place, original: sent, painted }) => {
    // `sent`: the exact picture the local AI expanded (with the Editor's crop/adjustments);
    // otherwise (ChatGPT got a painted copy) the best unpainted version of the original.
    const original = sent && fs.existsSync(sent) ? sent : await pickOriginal(source);
    const out = workFile(); const maskOut = workFile('.mask.png'); const overlayOut = workFile('.over.png');
    const t0 = Date.now();
    // "Proteger personagem": the expansion comes back with the character as a blue shape. The
    // merge then needs the character's cut-out (same one the 3D effect uses) to put it back.
    let matte = null;
    if (!place) {
      try {
        const { paintMaskAt } = require('./merge-core');
        if ((await paintMaskAt(expansion, 160)).share > 0.03) {
          const depth = require('./ai/depth');
          if (depth.exists()) { broadcast('expand:stage', 'Recortando a personagem do original…'); matte = (await depth.get(original, 0)).depth; }
        }
      } catch (err) { log.warn('juntar: sem recorte da personagem', err.message); }
    }
    const paintedOk = painted && fs.existsSync(painted) ? painted : null;
    const r = await new Promise((resolve, reject) => {
      const { Worker } = require('worker_threads');
      const w = new Worker(path.join(__dirname, 'merge-worker.js'), { workerData: { original, expansion, aspect: Number(aspect) || 0, place: place || null, out, maskOut, matte, painted: paintedOk, overlayOut } });
      w.on('message', (m) => {
        if (m.stage) { broadcast('expand:stage', m.stage); return; }
        w.terminate();
        if (m.ok) resolve(m.r); else reject(Object.assign(new Error(m.error), { code: m.code }));
      });
      w.once('error', reject);
    });
    if (r.mode === 'character') {
      // Fill what is left of the blue shape with scenery, then lay the original character on top.
      broadcast('expand:stage', 'Preenchendo atrás da personagem…');
      let bg = r.out;
      try { const fixed = workFile(); await lama.erase(r.out, r.paintMask, fixed); bg = fixed; } catch (err) {
        log.warn('juntar: LaMa falhou atrás da personagem', err.message);
        r.warnings.push('Não consegui preencher o azul em volta da personagem. Apague o que sobrar com a Borracha no Editor.');
      }
      broadcast('expand:stage', 'Colocando a personagem original…');
      const done = workFile();
      await require('./img')(bg, { limitInputPixels: false }).composite([{ input: r.overlay }]).png({ compressionLevel: 6 }).toFile(done);
      for (const f of [r.overlay, r.paintMask, r.out, bg]) if (f !== done) fs.rmSync(f, { force: true });
      r.out = done; r.paintMask = null;
      r.warnings.unshift('O cenário veio redesenhado pelo ChatGPT, então só a personagem original foi mantida, por cima do cenário novo.');
    }
    fs.rmSync(overlayOut, { force: true });
    if (r.paintMask) {
      broadcast('expand:stage', 'Apagando restos de tinta azul…');
      const fixed = workFile();
      try {
        await lama.erase(r.out, r.paintMask, fixed);
        r.out = fixed;
        r.warnings.push('O ChatGPT levou um pouco da tinta azul para as partes novas; apaguei com IA. Confira esse trecho no zoom.');
      } catch (err) {
        log.warn('juntar: LaMa falhou na tinta que sobrou', err.message);
        r.warnings.push('Sobrou um pouco de tinta azul nas partes novas. Apague com a Borracha no Editor.');
      } finally { fs.rmSync(r.paintMask, { force: true }); }
    }
    fs.rmSync(maskOut, { force: true });
    log.info('juntar: pronto', path.basename(original), `${r.width}x${r.height}`, 'encaixe', r.score, JSON.stringify(r.seams), `${Date.now() - t0} ms`);
    return { file: r.out, width: r.width, height: r.height, score: r.score, warnings: r.warnings, original };
  });
  // Local AI expansion (FLUX.3 klein through the app's own ComfyUI, started only while needed).
  localAi = new (require('./localai').LocalAi)({ resource, workFile });
  localAi.on('status', (st) => broadcast('localai:status', st));
  setTimeout(() => { try { localAi.dropObsolete(); } catch (_) { /* ignore */ } }, 20000);
  h('localai:status', () => localAi.status());
  h('localai:install', () => localAi.install());
  h('localai:expand', (opts) => localAi.expand(opts));
  h('localai:cancel', () => localAi.cancel());
  h('editor:upscale', async (base) => {
    const settings = Object.assign({}, config.global.upscale, { target: config.global.upscale.target || '4k', skipIfLarger: true });
    const ctx = { progress: () => {}, stage: () => {}, onCancel: () => {}, checkCanceled: () => {} };
    const res = await upscaler.upscaleImage(base, settings, ctx, { monitors: monitors.monitors, outputDir: workDir() });
    if (res.skipped) throw new Error(res.reason);
    return res.output;
  });
  // Save: a picture of the app's gallery is updated in place (the first original is kept in
  // _Backup); any other picture asks where to save. `mode: 'edited'` (batch) keeps the _Editado copy.
  h('editor:save', async ({ source, bytes, format, mode }) => {
    const sharp = require('./img');
    const write = async (file, fmt) => {
      let img = sharp(Buffer.from(bytes), { limitInputPixels: false });
      img = fmt === 'jpg' ? img.jpeg({ quality: 95, chromaSubsampling: '4:4:4', mozjpeg: true }) : fmt === 'webp' ? img.webp({ quality: 95 }) : img.png({ compressionLevel: 6 });
      const tmp = file + '.tmp-' + Date.now();
      await img.toFile(tmp);
      fs.renameSync(tmp, file);
    };
    const fmtOf = (file) => { const e = path.extname(file).toLowerCase(); return e === '.jpg' || e === '.jpeg' ? 'jpg' : e === '.webp' ? 'webp' : 'png'; };
    const name = path.parse(source).name;
    let out; let updated = false;
    if (mode === 'edited') {
      const dir = path.join(path.dirname(source), library.EDIT_DIR);
      fs.mkdirSync(dir, { recursive: true });
      for (const ext of ['.png', '.jpg']) fs.rmSync(path.join(dir, name + ext), { force: true });
      out = path.join(dir, name + (format === 'jpg' ? '.jpg' : '.png'));
      await write(out, format === 'jpg' ? 'jpg' : 'png');
    } else if (inGallery(source)) {
      const backupDir = path.join(path.dirname(source), library.BACKUP_DIR);
      const backup = path.join(backupDir, path.basename(source));
      if (!fs.existsSync(backup)) { fs.mkdirSync(backupDir, { recursive: true }); fs.copyFileSync(source, backup); }
      await write(source, fmtOf(source));
      // The 4K version would still be shown instead: it gets the new picture too. An old _Editado copy goes.
      const up = library.upscaledPathFor(source);
      if (up) await write(up, fmtOf(up));
      const ed = path.join(path.dirname(source), library.EDIT_DIR);
      for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) fs.rmSync(path.join(ed, name + ext), { force: true });
      out = source; updated = true;
    } else {
      const ext = format === 'jpg' ? 'jpg' : 'png';
      const r = await dialog.showSaveDialog(mainWin, {
        title: 'Salvar imagem editada',
        defaultPath: path.join(path.dirname(source), `${name} (editada).${ext}`),
        filters: [{ name: 'PNG', extensions: ['png'] }, { name: 'JPG', extensions: ['jpg', 'jpeg'] }, { name: 'WebP', extensions: ['webp'] }],
      });
      if (r.canceled || !r.filePath) return { canceled: true };
      out = r.filePath;
      await write(out, fmtOf(out));
    }
    broadcast('media-changed', { folder: path.dirname(source) });
    if (!updated && mode !== 'edited') return { out, updated };
    // Refresh any monitor currently showing this image.
    for (const m of monitors.monitors) {
      const c = config.data.monitors[m.id];
      if (c && (c.current === source || c.fixed === source)) scheduler.display(m.id, source, { noHistory: true });
    }
    return { out, updated };
  });

  // Legacy app (Wallpaper por Monitor V5) — disable its auto-start so both don't fight.
  h('legacy:status', () => legacyStatus());
  h('legacy:disable', () => disableLegacy());

  // Renderer (wallpaper windows)
  ipcMain.on('wp:ready', (e) => { const host = hosts.byWebContents(e.sender); if (host) host.rendererReady(); });
  ipcMain.on('wp:frame', (e) => { const host = hosts.byWebContents(e.sender); if (host) host.reveal(); });
  ipcMain.on('wp:error', (e, msg) => { const host = hosts.byWebContents(e.sender); log.warn('renderer', host ? host.monitor.name : '?', msg); });
}

function legacyStatus() {
  if (!IS_WIN) return { present: false };
  const startupCmd = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'WallpaperPorMonitor.cmd');
  const installed = path.join(process.env.LOCALAPPDATA || '', 'WallpaperPorMonitor', 'App', 'WallpaperPorMonitor.ps1');
  return { present: fs.existsSync(startupCmd), startupCmd, installed };
}

async function disableLegacy() {
  const st = legacyStatus();
  const { execFile } = require('child_process');
  const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { windowsHide: true }, () => res()));
  await run('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'WallpaperPorMonitor', '/f']);
  try { if (st.startupCmd && fs.existsSync(st.startupCmd)) fs.unlinkSync(st.startupCmd); } catch (err) { log.warn('legacy cmd', err.message); }
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*WallpaperPorMonitor*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"]);
  return legacyStatus();
}
