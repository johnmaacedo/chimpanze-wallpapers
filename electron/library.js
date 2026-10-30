'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { app, nativeImage } = require('electron');
const log = require('./log');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.jfif', '.png', '.bmp', '.webp', '.avif']);
const ANIMATED_EXT = new Set(['.gif']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.m4v', '.mov']);
const UPSCALE_DIR = '_4K';
const EDIT_DIR = '_Editado';

function mediaType(file) {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ANIMATED_EXT.has(ext)) return 'gif';
  if (VIDEO_EXT.has(ext)) return 'video';
  return null;
}

function isMedia(file) { return mediaType(file) !== null; }

async function listMedia(folder, { includeSubfolders = false, maxDepth = 4 } = {}) {
  const out = [];
  if (!folder) return out;
  async function walk(dir, depth) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (includeSubfolders && depth < maxDepth && e.name !== UPSCALE_DIR && e.name !== EDIT_DIR) await walk(full, depth + 1);
        continue;
      }
      const type = mediaType(e.name);
      if (!type) continue;
      out.push({ path: full, name: e.name, type });
    }
  }
  await walk(folder, 0);
  out.sort((a, b) => a.path.localeCompare(b.path, 'pt-BR', { numeric: true, sensitivity: 'base' }));
  return out;
}

/** Same as listMedia, plus stat info and the upscaled version (if any). */
async function listMediaDetailed(folder, opts) {
  const items = await listMedia(folder, opts);
  const upscaledIndex = await indexUpscaled(folder);
  const editedIndex = await indexUpscaled(folder, EDIT_DIR);
  await Promise.all(items.map(async (it) => {
    try {
      const st = await fsp.stat(it.path);
      it.size = st.size;
      it.mtime = st.mtimeMs;
    } catch (_) { it.size = 0; it.mtime = 0; }
    const base = path.parse(it.name).name.toLowerCase();
    if (path.dirname(it.path) === path.resolve(folder) && upscaledIndex.has(base)) it.upscaled = upscaledIndex.get(base);
    if (path.dirname(it.path) === path.resolve(folder) && editedIndex.has(base)) it.edited = editedIndex.get(base);
  }));
  return items;
}

async function indexUpscaled(folder, sub = UPSCALE_DIR) {
  const map = new Map();
  try {
    const dir = path.join(folder, sub);
    for (const name of await fsp.readdir(dir)) {
      if (mediaType(name) !== 'image') continue;
      map.set(path.parse(name).name.toLowerCase(), path.join(dir, name));
    }
  } catch (_) { /* no upscaled folder */ }
  return map;
}

function editedPathFor(file) { return upscaledPathFor(file, EDIT_DIR); }

/** What the monitors should show: edited > 4K > original. */
function bestVersion(file) {
  return editedPathFor(file) || upscaledPathFor(file) || file;
}

function upscaledPathFor(file, sub = UPSCALE_DIR) {
  const dir = path.join(path.dirname(file), sub);
  const base = path.parse(file).name;
  for (const ext of ['.png', '.jpg', '.webp', '.jpeg']) {
    const p = path.join(dir, base + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Thumbnails (Windows shell thumbnails when available, sharp otherwise)

const thumbDir = () => path.join(app.getPath('userData'), 'cache', 'thumbs');
const pending = new Map();
let active = 0;
const queue = [];

function runLimited(fn) {
  return new Promise((resolve, reject) => {
    const exec = () => {
      active++;
      fn().then(resolve, reject).finally(() => {
        active--;
        const nxt = queue.shift();
        if (nxt) nxt();
      });
    };
    if (active < 4) exec(); else queue.push(exec);
  });
}

async function thumbnail(file, size = 480) {
  let st;
  try { st = await fsp.stat(file); } catch (_) { return null; }
  const key = crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}|${size}`).digest('hex');
  const out = path.join(thumbDir(), key.slice(0, 2), key + '.jpg');
  if (fs.existsSync(out)) return out;
  if (pending.has(out)) return pending.get(out);
  const p = runLimited(async () => {
    await fsp.mkdir(path.dirname(out), { recursive: true });
    const type = mediaType(file);
    // 1) Windows shell thumbnail (fast, uses the system cache, also works for videos)
    if (process.platform === 'win32') {
      try {
        const img = await nativeImage.createThumbnailFromPath(file, { width: size, height: size });
        if (img && !img.isEmpty()) {
          await fsp.writeFile(out, img.toJPEG(84));
          return out;
        }
      } catch (_) { /* fall back */ }
    }
    // 2) sharp for images/GIFs
    if (type === 'image' || type === 'gif') {
      try {
        const sharp = require('./img');
        await sharp(file, { animated: false, limitInputPixels: false })
          .rotate()
          .resize(size, size, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 82, mozjpeg: true })
          .toFile(out);
        return out;
      } catch (err) {
        log.warn('thumb: sharp falhou', file, err.message);
      }
    }
    return null;
  }).finally(() => pending.delete(out));
  pending.set(out, p);
  return p;
}

async function imageSize(file) {
  try {
    const sharp = require('./img');
    const meta = await sharp(file, { limitInputPixels: false }).metadata();
    const rotated = meta.orientation && meta.orientation >= 5;
    return { width: rotated ? meta.height : meta.width, height: rotated ? meta.width : meta.height };
  } catch (_) {
    return null;
  }
}

module.exports = {
  IMAGE_EXT, VIDEO_EXT, ANIMATED_EXT, UPSCALE_DIR, EDIT_DIR, editedPathFor, bestVersion,
  mediaType, isMedia, listMedia, listMediaDetailed, upscaledPathFor, thumbnail, imageSize,
};
