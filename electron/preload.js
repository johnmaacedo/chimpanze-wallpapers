'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Map();

contextBridge.exposeInMainWorld('cw', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  on: (channel, cb) => {
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, fn);
    const key = Symbol('l');
    listeners.set(key, { channel, fn });
    return () => {
      const l = listeners.get(key);
      if (l) { ipcRenderer.removeListener(l.channel, l.fn); listeners.delete(key); }
    };
  },
  platform: process.platform,
});
