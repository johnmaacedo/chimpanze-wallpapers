'use strict';
// Optional AI packages. The installer only notes which ones were ticked
// (%LOCALAPPDATA%\ChimpanzeWallpapers\install-components.txt); the app downloads them
// on first start (or later, from Ajustes), resuming if the connection drops.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
let net; try { ({ net } = require('electron')); } catch (_) { /* build script */ }
const models = require('./models');
const log = require('./log');

const BASE = 'https://github.com/johnmaacedo/chimpanze-wallpapers/releases/download/modelos-ia-1/';
const LIST = {
  depth: {
    label: 'Profundidade 3D e piscar dos olhos',
    desc: 'Efeito 3D dos wallpapers, recorte de personagens, rostos, piscar e a Borracha com IA.',
    asset: 'cw-ia-profundidade.zip',
    models: ['depth-anything-v2-small.onnx', 'anime-seg-isnetis.onnx', 'anime-face-v1.4n.onnx', 'anime-eye-v1.0n.onnx', 'lama.onnx'],
    bins: [],
  },
  upscale: {
    label: 'Upscale 4K',
    desc: 'Modelos de upscale (Real-ESRGAN, AnimeSharp V4, UltraSharp V2).',
    asset: 'cw-ia-upscale.zip',
    models: ['up-2x-AnimeSharpV4_Fast_RCAN_PU_fp16_opset17.onnx', 'up-2x-AnimeSharpV4_RCAN_fp16_op17.onnx', 'up-4x-UltraSharpV2_Lite_fp16_op17.onnx', 'up-4x-UltraSharpV2_fp32_op17.onnx'],
    bins: ['upscaler'],
  },
  sam: {
    label: 'Clique mágico no recorte',
    desc: 'Clique num objeto e ele é selecionado inteiro (Segment Anything 2.1).',
    asset: 'cw-ia-clique-magico.zip',
    models: ['sam2.1-tiny-encoder.onnx', 'sam2.1-tiny-decoder.onnx'],
    bins: [],
  },
};
/** Download sizes (bytes), filled in when the packages are built (build/make-ai-packages.js). */
let SIZES = {};
try { SIZES = require('./components-sizes.json'); } catch (_) { /* not built yet */ }

class Components extends EventEmitter {
  constructor() { super(); this.jobs = {}; }

  installed(id) {
    const c = LIST[id];
    return c.models.every((m) => fs.existsSync(models.modelPath(m))) && c.bins.every((b) => fs.existsSync(models.binDir(b)));
  }
  /** Bundled with the installation (cannot be removed from the app). */
  bundled(id) {
    const c = LIST[id];
    return c.models.every((m) => fs.existsSync(models.bundled('models', m))) && c.bins.every((b) => fs.existsSync(models.bundled('bin', b)));
  }
  list() {
    return Object.entries(LIST).map(([id, c]) => ({
      id, label: c.label, desc: c.desc, size: SIZES[c.asset] || 0, installed: this.installed(id), bundled: this.bundled(id),
      job: this.jobs[id] ? { progress: this.jobs[id].progress, stage: this.jobs[id].stage, error: this.jobs[id].error } : null,
    }));
  }
  set(id, patch) { this.jobs[id] = Object.assign(this.jobs[id] || {}, patch); this.emit('status', this.list()); }

  async install(id) {
    const c = LIST[id];
    if (!c) throw new Error('Recurso desconhecido.');
    if (this.installed(id)) return true;
    if (this.jobs[id] && this.jobs[id].running) return false;
    const root = models.userRoot();
    const dl = path.join(root, 'downloads'); await fsp.mkdir(dl, { recursive: true });
    const zip = path.join(dl, c.asset);
    this.set(id, { running: true, progress: 0, stage: 'Baixando…', error: '' });
    try {
      // Resumable download (a cut connection continues where it stopped).
      for (let attempt = 0; attempt < 6; attempt++) {
        const have = fs.existsSync(zip) ? fs.statSync(zip).size : 0;
        const res = await net.fetch(BASE + c.asset, { headers: have ? { Range: `bytes=${have}-` } : {} });
        if (res.status === 416) break; // already complete
        if (!res.ok) throw new Error(`O download respondeu ${res.status}.`);
        const total = Number(res.headers.get('content-range')?.split('/')[1] || res.headers.get('content-length') || 0) + (res.status === 206 ? 0 : 0);
        const full = res.status === 206 ? total : Number(res.headers.get('content-length') || 0);
        const out = fs.createWriteStream(zip, { flags: res.status === 206 ? 'a' : 'w' });
        let got = res.status === 206 ? have : 0;
        try {
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
            got += value.length;
            if (full) this.set(id, { progress: Math.min(0.97, (got / full) * 0.97), stage: `Baixando… ${Math.round(got / 1048576)} de ${Math.round(full / 1048576)} MB` });
          }
          await new Promise((r) => out.end(r));
          if (!full || got >= full) break;
        } catch (err) {
          await new Promise((r) => out.end(r));
          log.warn('recursos: download interrompido, continuando', c.asset, err.message);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      this.set(id, { progress: 0.98, stage: 'Instalando…' });
      // The package holds models/… and bin/… : unpack straight into the app's folder.
      await new Promise((resolve, reject) => {
        // Windows' own tar (bsdtar, reads zip), not another one that may be first on the PATH.
        const tar = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe');
        const p = spawn(fs.existsSync(tar) ? tar : 'tar', ['-xf', zip, '-C', root], { windowsHide: true });
        let err = '';
        p.stderr.on('data', (d) => { err += d; });
        p.on('error', reject);
        p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('Não consegui descompactar: ' + err.slice(0, 200)))));
      });
      await fsp.rm(zip, { force: true });
      if (!this.installed(id)) throw new Error('O pacote baixado está incompleto.');
      log.info('recursos: instalado', id);
      this.set(id, { running: false, progress: 1, stage: 'Pronto', error: '' });
      delete this.jobs[id];
      this.emit('installed', id);
      this.emit('status', this.list());
      return true;
    } catch (err) {
      log.error('recursos: falhou', id, err.message);
      this.set(id, { running: false, error: err.message, stage: '' });
      throw err;
    }
  }

  /** Removes a downloaded package (bundled files stay). */
  async remove(id) {
    const c = LIST[id];
    const root = models.userRoot();
    for (const m of c.models) await fsp.rm(path.join(root, 'models', m), { force: true });
    for (const b of c.bins) await fsp.rm(path.join(root, 'bin', b), { recursive: true, force: true });
    this.emit('status', this.list());
    return this.list();
  }

  /** What the installer was told to fetch (once): download what is missing. */
  async fromInstaller() {
    const f = path.join(models.userRoot(), 'install-components.txt');
    if (!fs.existsSync(f)) return [];
    const ids = fs.readFileSync(f, 'utf8').split(/\r?\n/).map((x) => x.trim()).filter((x) => LIST[x]);
    fs.rmSync(f, { force: true });
    const todo = ids.filter((id) => !this.installed(id));
    for (const id of todo) await this.install(id).catch(() => {});
    return todo;
  }
}

module.exports = { Components, LIST };
