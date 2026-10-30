'use strict';
// Locations of the bundled GPU tools (Real-ESRGAN ncnn-Vulkan, RIFE ncnn-Vulkan, FFmpeg).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { spawn } = require('child_process');

function resourcesBin() {
  const base = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, '..', 'resources', 'bin');
  return base;
}

const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

function upscalerExe() { return path.join(resourcesBin(), 'upscaler', exe('realesrgan-ncnn-vulkan')); }
function upscalerModels() { return path.join(resourcesBin(), 'upscaler', 'models'); }
function status() {
  const isWin = process.platform === 'win32';
  return {
    upscaler: isWin && fs.existsSync(upscalerExe()),
    models: fs.existsSync(upscalerModels()) ? fs.readdirSync(upscalerModels()).filter((f) => f.endsWith('.param')).map((f) => f.slice(0, -6)) : [],
  };
}

/**
 * Runs a process, streaming stderr/stdout lines to onLine. Resolves on exit 0.
 * Returns { promise, kill }.
 */
function run(cmd, args, { cwd, onLine, env } = {}) {
  let child;
  const promise = new Promise((resolve, reject) => {
    child = spawn(cmd, args, { cwd, windowsHide: true, env: Object.assign({}, process.env, env || {}) });
    let tail = '';
    const feed = (buf) => {
      const text = buf.toString();
      tail = (tail + text).slice(-4000);
      if (onLine) text.split(/\r?\n|\r/).forEach((l) => { if (l.trim()) onLine(l.trim()); });
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(tail);
      else {
        const err = new Error(`${path.basename(cmd)} terminou com código ${code}: ${tail.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ')}`);
        err.code = code;
        err.output = tail;
        reject(err);
      }
    });
  });
  return { promise, kill: () => { try { child && child.kill(); } catch (_) { /* ignore */ } } };
}

module.exports = { resourcesBin, upscalerExe, upscalerModels, status, run };
