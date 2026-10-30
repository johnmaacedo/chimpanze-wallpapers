'use strict';
// "cwp://" scheme:
//   cwp://app/<file>         -> built UI (dist/)
//   cwp://media/<encoded>    -> any local media file (with HTTP Range support for video)
const fs = require('fs');
const path = require('path');
const { protocol } = require('electron');
const { Readable } = require('stream');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jfif': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.bmp': 'image/bmp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.wasm': 'application/wasm',
};

function registerSchemes() {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'cwp',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: false, codeCache: true },
  }]);
}

function mediaUrl(file) {
  return 'cwp://media/' + encodeURIComponent(file);
}

function fileResponse(file, request, extraHeaders = {}) {
  let st;
  try { st = fs.statSync(file); } catch (_) { return new Response('Not found', { status: 404 }); }
  if (!st.isFile()) return new Response('Not found', { status: 404 });
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = Object.assign({
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  }, extraHeaders);
  const range = request.headers.get('range');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (!m[1] && m[2]) { start = Math.max(0, st.size - parseInt(m[2], 10)); end = st.size - 1; }
      if (start >= st.size) {
        return new Response(null, { status: 416, headers: Object.assign(headers, { 'Content-Range': `bytes */${st.size}` }) });
      }
      end = Math.min(end, st.size - 1);
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      const stream = Readable.toWeb(fs.createReadStream(file, { start, end }));
      return new Response(stream, { status: 206, headers });
    }
  }
  // Small files: send the whole buffer (simplest, most robust path).
  if (st.size < 32 * 1024 * 1024) {
    return new Response(fs.readFileSync(file), { status: 200, headers });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers });
}

function handle(distDir) {
  protocol.handle('cwp', (request) => { try { return route(request); } catch (e) { console.error('PROTO ERR', e); return new Response('err', { status: 500 }); } });
  function route(request) {
    const url = new URL(request.url);
    if (url.host === 'media') {
      const file = decodeURIComponent(url.pathname.slice(1));
      return fileResponse(file, request);
    }
    // 'wall' serves the same files as 'app'; being another site lets every wallpaper
    // window share one renderer process while the UI keeps its own (see main.js).
    if (url.host === 'app' || url.host === 'wall') {
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/' || rel === '') rel = '/index.html';
      const file = path.normalize(path.join(distDir, rel));
      if (!file.startsWith(path.normalize(distDir))) return new Response('Forbidden', { status: 403 });
      return fileResponse(file, request, { 'Cache-Control': 'no-cache' });
    }
    return new Response('Not found', { status: 404 });
  }
}

module.exports = { registerSchemes, handle, mediaUrl };
