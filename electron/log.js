'use strict';
const fs = require('fs');
const path = require('path');

let file = null;
function init(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'chimpanze-wallpapers.log');
    // Keep the log small: rotate at 2 MB
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) {
      fs.renameSync(file, file + '.old');
    }
  } catch (_) { file = null; }
}

function fmt(args) {
  return args.map((a) => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object') { try { return JSON.stringify(a, (k, v) => (typeof v === 'bigint' ? v.toString() : v)); } catch (_) { return String(a); } }
    return String(a);
  }).join(' ');
}

function write(level, args) {
  const line = `[${new Date().toISOString()}] ${level} ${fmt(args)}`;
  if (level === 'ERROR') console.error(line); else console.log(line);
  if (file) { try { fs.appendFileSync(file, line + '\n'); } catch (_) { /* ignore */ } }
}

module.exports = {
  init,
  get file() { return file; },
  info: (...a) => write('INFO', a),
  warn: (...a) => write('WARN', a),
  error: (...a) => write('ERROR', a),
};
