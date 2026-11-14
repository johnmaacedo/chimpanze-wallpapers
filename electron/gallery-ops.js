'use strict';
// File work of the Galeria: bring pictures into a folder, move them, send them to the
// Recycle Bin, make folders. A picture travels with its own versions (_4K, _Editado,
// _Backup), its per-picture settings (3D, cut, music…) and the monitors showing it.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { shell } = require('electron');
const library = require('./library');

const SUBS = () => [library.UPSCALE_DIR, library.EDIT_DIR, library.BACKUP_DIR];
const key = (f) => path.resolve(f).toLowerCase();

/** A free name in `dir` for `base` (adds " (2)", " (3)"… when taken). */
function freeName(dir, base) {
  const p = path.parse(base);
  let name = base; let n = 2;
  while (fs.existsSync(path.join(dir, name))) name = `${p.name} (${n++})${p.ext}`;
  return path.join(dir, name);
}

/** The versions of a picture kept in its folder's sub-folders (same name, any image extension). */
function versionsOf(file) {
  const out = [];
  const dir = path.dirname(file); const base = path.parse(file).name;
  for (const sub of SUBS()) {
    for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
      const v = path.join(dir, sub, base + ext);
      if (fs.existsSync(v)) out.push({ sub, file: v });
    }
  }
  return out;
}

async function moveFile(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try { await fsp.rename(from, to); } catch (err) {
    if (err.code !== 'EXDEV') throw err; // another drive: copy then delete
    await fsp.copyFile(from, to); await fsp.unlink(from);
  }
}

function create({ config, scheduler, broadcast }) {
  /** Per-picture settings and monitors follow a picture that moved (or forget it when deleted). */
  const retarget = (from, to) => {
    const k = key(from);
    const imgs = config.data.images || {};
    if (imgs[k]) { if (to) imgs[key(to)] = imgs[k]; delete imgs[k]; }
    for (const [id, c] of Object.entries(config.data.monitors)) {
      if (c.current && key(c.current) === k) c.current = to || '';
      if (c.fixed && key(c.fixed) === k) { c.fixed = to || ''; if (!to && scheduler) setTimeout(() => scheduler.next(id).catch(() => {}), 300); }
    }
    config.save();
  };

  return {
    /** Copies pictures into `folder` (never overwrites). → number copied. */
    async add(folder, files) {
      folder = path.resolve(folder);
      let n = 0;
      for (const f0 of files || []) {
        const f = path.resolve(f0);
        if (!library.isMedia(f) || !fs.existsSync(f)) continue;
        if (path.dirname(path.resolve(f)).toLowerCase() === path.resolve(folder).toLowerCase()) continue;
        await fsp.copyFile(f, freeName(folder, path.basename(f)));
        n++;
      }
      broadcast('media-changed', { folder });
      return n;
    },

    /** Moves pictures (with their versions and settings) to `dest`. → number moved. */
    async move(files, dest) {
      dest = path.resolve(dest);
      let n = 0;
      for (const f0 of files || []) {
        const f = path.resolve(f0);
        if (!fs.existsSync(f)) continue;
        if (path.dirname(path.resolve(f)).toLowerCase() === path.resolve(dest).toLowerCase()) continue;
        const to = freeName(dest, path.basename(f));
        const vers = versionsOf(f);
        await moveFile(f, to);
        const newBase = path.parse(to).name;
        for (const v of vers) await moveFile(v.file, path.join(dest, v.sub, newBase + path.extname(v.file))).catch(() => {});
        retarget(f, to);
        n++;
      }
      broadcast('media-changed', { folder: dest });
      for (const f of files || []) broadcast('media-changed', { folder: path.dirname(f) });
      return n;
    },

    /** Sends pictures and their versions to the Recycle Bin (they can be restored from there). */
    async trash(files) {
      let n = 0;
      for (const f0 of files || []) {
        const f = path.resolve(f0); // the Recycle Bin refuses paths written with '/'
        if (!fs.existsSync(f)) continue;
        for (const v of versionsOf(f)) await shell.trashItem(v.file).catch(() => {});
        await shell.trashItem(f);
        retarget(f, null);
        n++;
      }
      for (const f of files || []) broadcast('media-changed', { folder: path.dirname(f) });
      return n;
    },

    /** New folder inside `parent`. → its path. */
    async mkdir(parent, name) {
      const clean = String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 80);
      if (!clean) throw new Error('Dê um nome para a pasta.');
      const dir = path.join(path.resolve(parent), clean);
      if (fs.existsSync(dir)) throw new Error('Já existe uma pasta com esse nome aqui.');
      await fsp.mkdir(dir);
      return dir;
    },

    /** Sub-folders of a folder (not the app's own _4K/_Editado/_Backup). */
    async subfolders(folder) {
      try {
        const out = [];
        for (const e of await fsp.readdir(folder, { withFileTypes: true })) {
          if (e.isDirectory() && !SUBS().includes(e.name) && !e.name.startsWith('.')) out.push(path.join(folder, e.name));
        }
        return out.sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }));
      } catch (_) { return []; }
    },
  };
}

module.exports = { create, versionsOf, freeName };
