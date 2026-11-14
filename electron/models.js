'use strict';
// Where the AI model files live. Since 1.7 the installer can leave them out (lighter
// download): they are then fetched by the app into %LOCALAPPDATA%\ChimpanzeWallpapers,
// which also survives app updates. A file is looked for there and in the installation.
const fs = require('fs');
const path = require('path');

function bundled(...p) {
  let packaged = false;
  try { packaged = require('electron').app.isPackaged; } catch (_) { /* utility process: no app */ }
  return packaged ? path.join(process.resourcesPath, ...p) : path.join(__dirname, '..', 'resources', ...p);
}
/** The app's own download area (writable, kept across updates). */
function userRoot() { return path.join(process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local'), 'ChimpanzeWallpapers'); }

/** Full path of a model file: the downloaded copy first, then the installed one (may not exist). */
function modelPath(name) {
  const user = path.join(userRoot(), 'models', name);
  if (fs.existsSync(user)) return user;
  const inst = bundled('models', name);
  return fs.existsSync(inst) && !process.env.CW_ONLY_DOWNLOADED ? inst : user; // CW_ONLY_DOWNLOADED: tests of the downloader
}

/** Folder of a bundled tool in resources/bin (e.g. 'upscaler'), downloaded or installed. */
function binDir(name) {
  const user = path.join(userRoot(), 'bin', name);
  if (fs.existsSync(user)) return user;
  const inst = bundled('bin', name);
  return fs.existsSync(inst) && !process.env.CW_ONLY_DOWNLOADED ? inst : user;
}

module.exports = { modelPath, binDir, userRoot, bundled };
