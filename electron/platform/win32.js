'use strict';
// Win32 bindings (koffi) used by Chimpanzé Wallpapers.
// - IDesktopWallpaper (COM) to enumerate monitors with a stable device path and
//   to set the official Windows wallpaper per monitor.
// - Progman/WorkerW technique to place our renderer windows behind the desktop
//   icons, including the Windows 11 24H2+ "raised desktop" layout.

const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const ole32 = koffi.load('ole32.dll');

const RECT = koffi.struct('CW_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const POINT = koffi.struct('CW_POINT', { x: 'int32', y: 'int32' });
const GUID = koffi.struct('CW_GUID', {
  Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: koffi.array('uint8', 8),
});

const EnumWindowsProc = koffi.proto('bool __stdcall CW_EnumWindowsProc(void *hwnd, intptr_t lParam)');

const FindWindowW = user32.func('void * __stdcall FindWindowW(const char16_t *cls, const char16_t *name)');
const FindWindowExW = user32.func('void * __stdcall FindWindowExW(void *parent, void *after, const char16_t *cls, const char16_t *name)');
const SendMessageTimeoutW = user32.func('intptr_t __stdcall SendMessageTimeoutW(void *hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam, uint32_t flags, uint32_t timeout, _Out_ uintptr_t *result)');
const EnumWindows = user32.func('bool __stdcall EnumWindows(CW_EnumWindowsProc *cb, intptr_t lParam)');
const GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(void *hwnd, int index)');
const SetWindowLongPtrW = user32.func('intptr_t __stdcall SetWindowLongPtrW(void *hwnd, int index, intptr_t value)');
const SetParent = user32.func('void * __stdcall SetParent(void *child, void *parent)');
const GetParent = user32.func('void * __stdcall GetParent(void *hwnd)');
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(void *hwnd, void *after, int x, int y, int cx, int cy, uint32_t flags)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *hwnd, _Out_ CW_RECT *rect)');
const MapWindowPoints = user32.func('int __stdcall MapWindowPoints(void *from, void *to, _Inout_ CW_POINT *pts, uint32_t count)');
const IsWindow = user32.func('bool __stdcall IsWindow(void *hwnd)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *hwnd)');
const IsZoomed = user32.func('bool __stdcall IsZoomed(void *hwnd)');
const IsIconic = user32.func('bool __stdcall IsIconic(void *hwnd)');
const ShowWindow = user32.func('bool __stdcall ShowWindow(void *hwnd, int cmd)');
const SetLayeredWindowAttributes = user32.func('bool __stdcall SetLayeredWindowAttributes(void *hwnd, uint32_t key, uint8_t alpha, uint32_t flags)');
const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(void *hwnd, _Out_ uint8_t *buf, int maxCount)');
const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void *hwnd, _Out_ uint8_t *buf, int maxCount)');
const keybd_event = user32.func('void __stdcall keybd_event(uint8_t vk, uint8_t scan, uint32_t flags, uintptr_t extra)');
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(void *hwnd)');

const CoInitializeEx = ole32.func('int32_t __stdcall CoInitializeEx(void *reserved, uint32_t coinit)');
const CoCreateInstance = ole32.func('int32_t __stdcall CoCreateInstance(const CW_GUID *clsid, void *outer, uint32_t ctx, const CW_GUID *iid, _Out_ void **ppv)');
const CoTaskMemFree = ole32.func('void __stdcall CoTaskMemFree(void *ptr)');

// IDesktopWallpaper vtable prototypes (first arg = this)
const P_Release = koffi.proto('uint32_t __stdcall CW_Release(void *self)');
const P_SetWallpaper = koffi.proto('int32_t __stdcall CW_SetWallpaper(void *self, const char16_t *monitorId, const char16_t *path)');
const P_GetWallpaper = koffi.proto('int32_t __stdcall CW_GetWallpaper(void *self, const char16_t *monitorId, _Out_ void **path)');
const P_GetMonitorDevicePathAt = koffi.proto('int32_t __stdcall CW_GetMonitorDevicePathAt(void *self, uint32_t index, _Out_ void **id)');
const P_GetMonitorDevicePathCount = koffi.proto('int32_t __stdcall CW_GetMonitorDevicePathCount(void *self, _Out_ uint32_t *count)');
const P_GetMonitorRECT = koffi.proto('int32_t __stdcall CW_GetMonitorRECT(void *self, const char16_t *monitorId, _Out_ CW_RECT *rect)');
const P_SetPosition = koffi.proto('int32_t __stdcall CW_SetPosition(void *self, int32_t position)');

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const WS_CAPTION = 0x00C00000;
const WS_THICKFRAME = 0x00040000;
const WS_SYSMENU = 0x00080000;
const WS_MINIMIZEBOX = 0x00020000;
const WS_MAXIMIZEBOX = 0x00010000;
const WS_EX_LAYERED = 0x00080000;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_APPWINDOW = 0x00040000;
const WS_EX_NOACTIVATE = 0x08000000;
const WS_EX_NOREDIRECTIONBITMAP = 0x00200000;
const LWA_ALPHA = 0x2;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const SWP_SHOWWINDOW = 0x0040;
const SW_SHOWNOACTIVATE = 4;
const HWND_BOTTOM = 1n;

function isNull(p) {
  return p === null || p === undefined || p === 0n || p === 0;
}

function toBig(v) {
  if (typeof v === 'bigint') return v;
  if (Buffer.isBuffer(v)) return v.length >= 8 ? v.readBigUInt64LE(0) : BigInt(v.readUInt32LE(0));
  return BigInt(v);
}

function same(a, b) {
  if (isNull(a) || isNull(b)) return false;
  return toBig(a) === toBig(b);
}

function parseGuid(str) {
  const h = str.replace(/[{}-]/g, '');
  const d4 = [];
  for (let i = 16; i < 32; i += 2) d4.push(parseInt(h.substr(i, 2), 16));
  return {
    Data1: parseInt(h.substr(0, 8), 16) >>> 0,
    Data2: parseInt(h.substr(8, 4), 16),
    Data3: parseInt(h.substr(12, 4), 16),
    Data4: d4,
  };
}

const CLSID_DesktopWallpaper = parseGuid('C2CF3110-460E-4FC1-B9D0-8A1C0C9CC4BD');
const IID_IDesktopWallpaper = parseGuid('B92B56A9-8B55-4E14-9A89-0199BBB6F93B');

function hr(code, what) {
  if (code < 0) {
    const err = new Error(`${what} falhou (HRESULT 0x${(code >>> 0).toString(16)})`);
    err.hresult = code >>> 0;
    throw err;
  }
  return code;
}

let comInit = false;
let desktopWallpaper = null; // BigInt pointer to the COM object

function getDesktopWallpaper() {
  if (desktopWallpaper) return desktopWallpaper;
  if (!comInit) {
    // Electron's UI thread already initialises COM (STA). The call then returns
    // S_FALSE or RPC_E_CHANGED_MODE, both fine for us.
    try { CoInitializeEx(null, 0x2); } catch (_) { /* ignore */ }
    comInit = true;
  }
  const out = [null];
  // CLSCTX_ALL = INPROC_SERVER | INPROC_HANDLER | LOCAL_SERVER | REMOTE_SERVER
  hr(CoCreateInstance(CLSID_DesktopWallpaper, null, 0x17, IID_IDesktopWallpaper, out), 'CoCreateInstance(DesktopWallpaper)');
  if (isNull(out[0])) throw new Error('IDesktopWallpaper indisponível');
  desktopWallpaper = toBig(out[0]);
  return desktopWallpaper;
}

function vfn(obj, index) {
  const vtbl = koffi.decode(obj, 'void *');
  return koffi.decode(vtbl, index * 8, 'void *');
}

function withCom(fn) {
  try {
    return fn(getDesktopWallpaper());
  } catch (err) {
    // Explorer restarted or the object became invalid: recreate once.
    resetCom();
    return fn(getDesktopWallpaper());
  }
}

function resetCom() {
  if (desktopWallpaper) {
    try { koffi.call(vfn(desktopWallpaper, 2), P_Release, desktopWallpaper); } catch (_) { /* ignore */ }
  }
  desktopWallpaper = null;
}

function readComString(ptr) {
  if (isNull(ptr)) return '';
  const s = koffi.decode.string16(ptr);
  try { CoTaskMemFree(ptr); } catch (_) { /* ignore */ }
  return s;
}

/**
 * Lists the monitors known to Windows that are currently attached and active.
 * Returns [{ id, rect: {x, y, width, height} }] in physical pixels.
 */
function listMonitors() {
  return withCom((dw) => {
    const countOut = [0];
    hr(koffi.call(vfn(dw, 6), P_GetMonitorDevicePathCount, dw, countOut), 'GetMonitorDevicePathCount');
    const count = Number(countOut[0]) || 0;
    const result = [];
    for (let i = 0; i < count; i++) {
      const idOut = [null];
      const code = koffi.call(vfn(dw, 5), P_GetMonitorDevicePathAt, dw, i, idOut);
      if (code < 0) continue;
      const id = readComString(idOut[0]);
      if (!id) continue;
      const r = {};
      const rc = koffi.call(vfn(dw, 7), P_GetMonitorRECT, dw, id, r);
      // Disconnected monitors stay in the list but GetMonitorRECT fails (or S_FALSE)
      if (rc !== 0) continue;
      const width = r.right - r.left;
      const height = r.bottom - r.top;
      if (width <= 0 || height <= 0) continue;
      result.push({ id, rect: { x: r.left, y: r.top, width, height } });
    }
    return result;
  });
}

function setWindowsWallpaper(monitorId, filePath) {
  return withCom((dw) => {
    hr(koffi.call(vfn(dw, 10), P_SetPosition, dw, 4 /* DWPOS_FILL */), 'SetPosition');
    hr(koffi.call(vfn(dw, 3), P_SetWallpaper, dw, monitorId, filePath), 'SetWallpaper');
    return true;
  });
}

function getWindowsWallpaper(monitorId) {
  return withCom((dw) => {
    const out = [null];
    const code = koffi.call(vfn(dw, 4), P_GetWallpaper, dw, monitorId, out);
    if (code < 0) return '';
    return readComString(out[0]);
  });
}

// ---------------------------------------------------------------------------
// Desktop layer (behind the icons)

function className(hwnd) {
  const buf = Buffer.alloc(512);
  const n = GetClassNameW(hwnd, buf, 256);
  return n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
}

function isRaisedDesktop() {
  const progman = FindWindowW('Progman', null);
  if (isNull(progman)) return false;
  const ex = Number(GetWindowLongPtrW(progman, GWL_EXSTYLE));
  return (ex & WS_EX_NOREDIRECTIONBITMAP) !== 0;
}

function findWallpaperLayer(progman, raised) {
  if (raised) {
    // Win11 24H2+: the wallpaper WorkerW is a child of Progman, z-ordered under the icons.
    const w = FindWindowExW(progman, null, 'WorkerW', null);
    return isNull(w) ? null : w;
  }
  // Classic layout: the WorkerW that follows the top-level window hosting SHELLDLL_DefView.
  let found = null;
  EnumWindows((top) => {
    const defView = FindWindowExW(top, null, 'SHELLDLL_DefView', null);
    if (!isNull(defView)) {
      const sibling = FindWindowExW(null, top, 'WorkerW', null);
      if (!isNull(sibling)) found = sibling;
    }
    return true;
  }, 0);
  return found;
}

/** Returns { parent, raised } — the window our renderers must be parented to. */
function getDesktopLayer() {
  const progman = FindWindowW('Progman', null);
  if (isNull(progman)) throw new Error('Progman não encontrado (Explorer não está em execução?)');
  const raised = isRaisedDesktop();
  let layer = findWallpaperLayer(progman, raised);
  if (!layer) {
    const res = [0];
    SendMessageTimeoutW(progman, 0x052C, 0xD, 0x1, 0x0002 /* SMTO_ABORTIFHUNG */, 1000, res);
    layer = findWallpaperLayer(progman, raised);
  }
  if (!layer) {
    const res = [0];
    SendMessageTimeoutW(progman, 0x052C, 0, 0, 0x0002, 1000, res);
    layer = findWallpaperLayer(progman, isRaisedDesktop());
  }
  return { parent: layer || progman, raised, progman, fallback: !layer };
}

function getRect(hwnd) {
  const r = {};
  if (!GetWindowRect(hwnd, r)) return null;
  return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
}

function rectEquals(a, b, tol = 2) {
  return a && b && Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol &&
    Math.abs(a.width - b.width) <= tol && Math.abs(a.height - b.height) <= tol;
}

/** Positions an attached child so that it covers `screenRect` (physical px). */
function positionChild(hwnd, parent, screenRect) {
  const pt = { x: screenRect.x, y: screenRect.y };
  MapWindowPoints(null, parent, pt, 1);
  SetWindowPos(hwnd, null, pt.x, pt.y, screenRect.width, screenRect.height, SWP_NOZORDER | SWP_NOACTIVATE);
  let actual = getRect(hwnd);
  if (!rectEquals(actual, screenRect)) {
    // Some layouts keep screen coordinates for the child; try them.
    SetWindowPos(hwnd, null, screenRect.x, screenRect.y, screenRect.width, screenRect.height, SWP_NOZORDER | SWP_NOACTIVATE);
    actual = getRect(hwnd);
  }
  if (!rectEquals(actual, screenRect)) {
    // Last resort: offset from the parent's own origin (bbabcock approach).
    const pr = getRect(parent);
    if (pr) {
      SetWindowPos(hwnd, null, screenRect.x - pr.x, screenRect.y - pr.y, screenRect.width, screenRect.height, SWP_NOZORDER | SWP_NOACTIVATE);
      actual = getRect(hwnd);
    }
  }
  return { ok: rectEquals(actual, screenRect), actual };
}

/**
 * Re-parents an Electron window (native handle) into the desktop wallpaper layer
 * and makes it cover `screenRect` (physical pixels).
 */
function attachToDesktop(handle, screenRect) {
  const hwnd = toBig(handle);
  const layer = getDesktopLayer();

  // Layered + fully opaque: required for DWM to composite a window hosted under
  // the raised desktop (otherwise it renders black). Harmless on classic layout.
  let ex = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  ex = (ex | WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) & ~WS_EX_APPWINDOW;
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex);
  SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);

  // Child style before SetParent (MSDN): avoids the half-attached state.
  let st = Number(GetWindowLongPtrW(hwnd, GWL_STYLE));
  st = (st | WS_CHILD) & ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
  SetWindowLongPtrW(hwnd, GWL_STYLE, st >> 0);

  SetParent(hwnd, layer.parent);
  SetWindowPos(hwnd, null, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  const pos = positionChild(hwnd, layer.parent, screenRect);
  return { parent: layer.parent, raised: layer.raised, fallback: layer.fallback, positioned: pos.ok, actual: pos.actual };
}

function isWindow(h) {
  if (isNull(h)) return false;
  try { return !!IsWindow(toBig(h)); } catch (_) { return false; }
}

function windowRect(h) {
  if (isNull(h)) return null;
  return getRect(toBig(h));
}

/**
 * Describes the foreground window so the host can pause rendering on monitors
 * covered by a fullscreen (game/video) or maximized window.
 */
function foregroundInfo(ownPid) {
  const fg = GetForegroundWindow();
  if (isNull(fg)) return null;
  const cls = className(fg);
  if (['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'NotifyIconOverflowWindow'].includes(cls)) return null;
  const pidOut = [0];
  GetWindowThreadProcessId(fg, pidOut);
  if (ownPid && Number(pidOut[0]) === ownPid) return null;
  if (!IsWindowVisible(fg) || IsIconic(fg)) return null;
  const rect = getRect(fg);
  if (!rect) return null;
  return { rect, maximized: !!IsZoomed(fg), cls };
}

function windowTitle(h) {
  const buf = Buffer.alloc(1024);
  const n = GetWindowTextW(h, buf, 511);
  return n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
}

/** Title/pid of the window that currently has keyboard focus. */
function foregroundWindow() {
  const fg = GetForegroundWindow();
  if (isNull(fg)) return null;
  const pidOut = [0];
  GetWindowThreadProcessId(fg, pidOut);
  return { title: windowTitle(fg), cls: className(fg), pid: Number(pidOut[0]), minimized: !!IsIconic(fg) };
}

const VK = { CTRL: 0x11, SHIFT: 0x10, ALT: 0x12, ENTER: 0x0d, V: 0x56, O: 0x4f, N: 0x4e, ESC: 0x1b };
/** Presses a key combination, e.g. ['CTRL', 'V']. */
function sendKeys(combo) {
  const codes = combo.map((k) => VK[k] || k.toUpperCase().charCodeAt(0));
  for (const c of codes) keybd_event(c, 0, 0, 0);
  for (const c of codes.slice().reverse()) keybd_event(c, 0, 2, 0);
}

module.exports = {
  platform: 'win32',
  foregroundWindow,
  sendKeys,
  listMonitors,
  setWindowsWallpaper,
  getWindowsWallpaper,
  attachToDesktop,
  positionChild: (h, parent, rect) => positionChild(toBig(h), toBig(parent), rect),
  isWindow,
  windowRect,
  isRaisedDesktop,
  foregroundInfo,
  resetCom,
  _same: same,
};
