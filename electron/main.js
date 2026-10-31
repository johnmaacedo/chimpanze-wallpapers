'use strict';
// Chimpanzé Wallpapers — main process
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, screen, shell, Notification, globalShortcut } = require('electron');

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

let config; let shortcuts; let monitors; let hosts; let scheduler; let jobs; let platform; let library; let upscaler; let tools; let lama; let chatgpt;
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
  scheduler.on('displayed', () => broadcast('state', publicState()));
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

function onMonitorsChange({ monitors: list, added, removed, forced }) {
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
    icon: resource('icon.png'),
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: false, spellcheck: false, backgroundThrottling: false },
  });
  mainWin.setMenu(null);
  mainWin.loadURL('cwp://app/index.html');
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

function createTray() {
  const img = nativeImage.createFromPath(resource('tray.png'));
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

function quit() {
  quitting = true;
  app.quit();
}

app.on('before-quit', () => {
  quitting = true;
  try { if (scheduler) scheduler.syncAllForExit(); } catch (err) { log.error('sync exit', err); }
  try { if (config) config.saveNow(); } catch (_) { /* ignore */ }
  try { if (hosts) hosts.destroyAll(); } catch (_) { /* ignore */ }
  try { if (shortcuts) shortcuts.dispose(); else globalShortcut.unregisterAll(); } catch (_) { /* ignore */ }
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

// ---------------------------------------------------------------------------
// Settings changes (from the UI and from the global shortcuts)

function setGlobal(patch) {
  const g = config.updateGlobal(patch);
  if (patch && 'startWithWindows' in patch) applyStartup();
  if (patch && 'uiOpacity' in patch && mainWin) mainWin.setOpacity(Math.max(0.25, Math.min(1, g.uiOpacity)));
  for (const m of monitors.monitors) {
    const host = hosts.get(m.id);
    if (host) host.setSettings(scheduler.rendererSettings(config.monitor(m.id)));
  }
  if (patch && ('parallax' in patch || 'parallaxBlink' in patch || 'reduceMotion' in patch)) scheduler.refreshDepth();
  if (patch && 'shortcuts' in patch && shortcuts) broadcast('shortcuts', shortcuts.apply());
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
      if (!require('./ai/depth').exists()) { feedback('Profundidade 3D indisponível', 'O modelo de profundidade não está instalado.', 'warn'); return; }
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

  h('media:list', async (folder, opts) => library.listMediaDetailed(folder, opts || {}));
  h('media:thumb', async (file) => {
    const t = await library.thumbnail(file);
    return t ? proto.mediaUrl(t) : null;
  });
  h('media:url', (file) => proto.mediaUrl(file));
  h('media:size', (file) => library.imageSize(file));
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
  h('editor:writeTemp', (bytes) => { const f = workFile(); fs.writeFileSync(f, Buffer.from(bytes)); return f; });

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
  h('chatgpt:save', (opts) => jobs.add('upscale', (opts.upscale ? 'ChatGPT + 4K: ' : 'ChatGPT: ') + path.basename(opts.source), async (ctx) => {
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
    const out = await require('./chatgpt').saveResult({ file, source: opts.source }, { EDIT_DIR: library.EDIT_DIR });
    broadcast('media-changed', { folder: path.dirname(opts.source) });
    for (const m of monitors.monitors) {
      const c = config.data.monitors[m.id];
      if (opts.monitorId === m.id) scheduler.display(m.id, opts.source, {});
      else if (c && (c.current === opts.source || c.fixed === opts.source)) scheduler.display(m.id, opts.source, { noHistory: true });
    }
    return { output: out, width: 0, height: 0, model: '', kind: 'chatgpt', skipped: false };
  }, { file: opts.source, chatgpt: true }));
  h('editor:upscale', async (base) => {
    const settings = Object.assign({}, config.global.upscale, { target: config.global.upscale.target || '4k', skipIfLarger: true });
    const ctx = { progress: () => {}, stage: () => {}, onCancel: () => {}, checkCanceled: () => {} };
    const res = await upscaler.upscaleImage(base, settings, ctx, { monitors: monitors.monitors, outputDir: workDir() });
    if (res.skipped) throw new Error(res.reason);
    return res.output;
  });
  h('editor:save', async ({ source, bytes, format }) => {
    const sharp = require('./img');
    const dir = path.join(path.dirname(source), library.EDIT_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const name = path.parse(source).name;
    for (const ext of ['.png', '.jpg']) fs.rmSync(path.join(dir, name + ext), { force: true });
    const out = path.join(dir, name + (format === 'jpg' ? '.jpg' : '.png'));
    let img = sharp(Buffer.from(bytes), { limitInputPixels: false });
    img = format === 'jpg' ? img.jpeg({ quality: 95, chromaSubsampling: '4:4:4', mozjpeg: true }) : img.png({ compressionLevel: 6 });
    await img.toFile(out);
    broadcast('media-changed', { folder: path.dirname(source) });
    // Refresh any monitor currently showing this image.
    for (const m of monitors.monitors) {
      const c = config.data.monitors[m.id];
      if (c && (c.current === source || c.fixed === source)) scheduler.display(m.id, source, { noHistory: true });
    }
    return out;
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
