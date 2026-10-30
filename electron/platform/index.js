'use strict';
// Chooses the native Windows implementation or a development stub (Linux/macOS)
// so the whole app can be exercised outside Windows.

let impl;
if (process.platform === 'win32') {
  impl = require('./win32');
} else {
  const { screen } = require('electron');
  impl = {
    platform: process.platform,
    listMonitors() {
      if (process.env.CW_FAKE_MONITORS === '2') { // dev/test only: split the screen in two "monitors"
        const d = screen.getPrimaryDisplay().bounds; const w = Math.floor(d.width / 2);
        return [0, 1].map((i) => ({ id: `\\\\?\\DISPLAY#FAKE${i}#stub#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}`, rect: { x: d.x + i * w, y: d.y, width: w, height: d.height } }));
      }
      return screen.getAllDisplays().map((d) => ({
        id: `\\\\?\\DISPLAY#DEV${d.id}#stub#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}`,
        rect: {
          x: Math.round(d.bounds.x * d.scaleFactor),
          y: Math.round(d.bounds.y * d.scaleFactor),
          width: Math.round(d.bounds.width * d.scaleFactor),
          height: Math.round(d.bounds.height * d.scaleFactor),
        },
      }));
    },
    setWindowsWallpaper() { return true; },
    getWindowsWallpaper() { return ''; },
    attachToDesktop() { return { parent: 1n, raised: false, fallback: true, positioned: true, stub: true }; },
    positionChild() { return { ok: true }; },
    isWindow() { return true; },
    windowRect() { return null; },
    isRaisedDesktop() { return false; },
    foregroundInfo() { return null; },
    foregroundWindow() { return null; },
    sendKeys() {},
    resetCom() {},
  };
}

module.exports = impl;
