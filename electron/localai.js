'use strict';
// Local AI expansion ("Expandir" → "IA local"): FLUX.1 Fill [dev] (GGUF Q6_K) through the app's
// own portable ComfyUI, on the user's NVIDIA GPU. Nothing is sent anywhere.
//
//  - install(): one-time download (resumable) of the portable ComfyUI, the ComfyUI-GGUF node and
//    the models, then extraction/setup, under %LOCALAPPDATA%\ChimpanzeWallpapers\localai;
//  - the ComfyUI server only runs while it is needed (closed after a few idle minutes, so its
//    RAM/VRAM goes back to the system);
//  - expand(): the picture is centred on the new canvas, the new areas are masked (with a soft
//    overlap into the picture so the model blends it), FLUX Fill paints them; the app then puts
//    the untouched original back with merge-core.js (same as for ChatGPT).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const log = require('./log');

// Electron is only asked when LOCALAPPDATA is missing (keeps the module usable outside the app, e.g. in tests).
const ROOT = path.join(process.env.LOCALAPPDATA || require('electron').app.getPath('userData'), 'ChimpanzeWallpapers', 'localai');
const DL = path.join(ROOT, 'downloads');
const COMFY = path.join(ROOT, 'ComfyUI_windows_portable');
const PY = path.join(COMFY, 'python_embeded', 'python.exe');
const MAIN = path.join(COMFY, 'ComfyUI', 'main.py');
const MODELS = path.join(COMFY, 'ComfyUI', 'models');
const GGUF_NODE = path.join(COMFY, 'ComfyUI', 'custom_nodes', 'ComfyUI-GGUF');
const READY = path.join(ROOT, 'ready.json');
const PORT = 8193;
const IDLE_MS = 5 * 60 * 1000;
const SETUP_VERSION = 1;

/** What gets downloaded. `to` = final place (relative to ComfyUI/models), null = handled by setup. */
const FILES = [
  { name: 'ComfyUI_windows_portable_nvidia.7z', size: 2054382457, url: 'https://github.com/Comfy-Org/ComfyUI/releases/download/v0.44.0/ComfyUI_windows_portable_nvidia.7z', to: null },
  { name: 'ComfyUI-GGUF.zip', size: 0, url: 'https://github.com/city96/ComfyUI-GGUF/archive/6ea2651e7df66d7585f6ffee804b20e92fb38b8a.zip', to: null },
  { name: 'flux1-fill-dev-Q6_K.gguf', size: 9860932896, url: 'https://huggingface.co/YarvixPA/FLUX.1-Fill-dev-GGUF/resolve/main/flux1-fill-dev-Q6_K.gguf', to: 'unet' },
  { name: 't5xxl_fp8_e4m3fn_scaled.safetensors', size: 5157348688, url: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn_scaled.safetensors', to: 'text_encoders' },
  { name: 'clip_l.safetensors', size: 246144152, url: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors', to: 'text_encoders' },
  { name: 'ae.safetensors', size: 335304388, url: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors', to: 'vae' },
];
const TOTAL_GB = Math.round(FILES.reduce((s, f) => s + f.size, 0) / 1e9);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => { try { fs.accessSync(p); return true; } catch (_) { return false; } };
const modelPath = (f) => path.join(MODELS, f.to, f.name);

class LocalAi extends EventEmitter {
  constructor({ resource, workFile }) {
    super();
    this.resource = resource; // (…p) → path inside the app's resources folder
    this.workFile = workFile;
    this.proc = null;
    this.ready = null; // promise of a running server
    this.idleTimer = null;
    this.state = { installing: false, busy: false, stage: '', progress: undefined, error: '' };
    this.job = null;
  }

  // --- status -------------------------------------------------------------------------
  missing() {
    const m = [];
    if (!exists(PY) || !exists(MAIN)) m.push('ComfyUI');
    if (!exists(path.join(GGUF_NODE, '__init__.py'))) m.push('ComfyUI-GGUF');
    for (const f of FILES) if (f.to && !exists(modelPath(f))) m.push(f.name);
    if (!exists(READY)) m.push('preparação');
    return m;
  }
  installed() { return process.platform === 'win32' && this.missing().length === 0; }
  status() {
    return {
      installed: this.installed(), installing: this.state.installing, running: !!this.proc, busy: this.state.busy,
      stage: this.state.stage, progress: this.state.progress, error: this.state.error, sizeGb: TOTAL_GB, missing: this.missing(),
    };
  }
  set(patch) { Object.assign(this.state, patch); this.emit('status', this.status()); }

  // --- install --------------------------------------------------------------------------
  async install() {
    if (process.platform !== 'win32') throw new Error('A IA local só funciona no Windows com placa NVIDIA.');
    if (this.state.installing) return this.status();
    this.set({ installing: true, error: '', stage: 'Preparando…', progress: 0 });
    try {
      await fsp.mkdir(DL, { recursive: true });
      // 1) downloads (only what is still needed), with overall progress by bytes
      const need = FILES.filter((f) => (f.to ? !exists(modelPath(f)) : (f.name.endsWith('.7z') ? !exists(PY) : !exists(path.join(GGUF_NODE, '__init__.py')))));
      const total = need.reduce((s, f) => s + (f.size || 1e6), 0) || 1;
      let doneBytes = 0;
      for (const f of need) {
        await this.download(f, (got) => this.set({ stage: `Baixando ${f.name}…`, progress: Math.min(0.95, ((doneBytes + got) / total) * 0.95) }));
        doneBytes += f.size || 1e6;
      }
      // 2) ComfyUI itself
      if (!exists(PY)) {
        this.set({ stage: 'Extraindo o ComfyUI (pode levar alguns minutos)…', progress: 0.95 });
        await this.run(this.resource('bin', '7zr.exe'), ['x', '-y', `-o${ROOT}`, path.join(DL, 'ComfyUI_windows_portable_nvidia.7z')], 20 * 60 * 1000);
        if (!exists(PY)) throw new Error('A extração do ComfyUI não terminou direito.');
        await fsp.rm(path.join(DL, 'ComfyUI_windows_portable_nvidia.7z'), { force: true });
      }
      // 3) the GGUF loader node + its Python package
      if (!exists(path.join(GGUF_NODE, '__init__.py'))) {
        this.set({ stage: 'Instalando o leitor de modelos GGUF…', progress: 0.97 });
        const tmp = path.join(ROOT, 'gguf-tmp');
        await fsp.rm(tmp, { recursive: true, force: true });
        await fsp.mkdir(tmp, { recursive: true });
        await this.unzip(path.join(DL, 'ComfyUI-GGUF.zip'), tmp);
        const inner = (await fsp.readdir(tmp)).find((d) => /^ComfyUI-GGUF/i.test(d));
        if (!inner) throw new Error('O pacote do leitor GGUF veio vazio.');
        await fsp.rm(GGUF_NODE, { recursive: true, force: true });
        await fsp.rename(path.join(tmp, inner), GGUF_NODE);
        await fsp.rm(tmp, { recursive: true, force: true });
        await fsp.rm(path.join(DL, 'ComfyUI-GGUF.zip'), { force: true });
      }
      this.set({ stage: 'Instalando componentes do Python…', progress: 0.98 });
      await this.run(PY, ['-s', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-warn-script-location', 'gguf>=0.13'], 10 * 60 * 1000, COMFY);
      // 4) models to their folders (same disk: instant)
      for (const f of FILES) {
        if (!f.to || exists(modelPath(f))) continue;
        await fsp.mkdir(path.dirname(modelPath(f)), { recursive: true });
        await fsp.rename(path.join(DL, f.name), modelPath(f));
      }
      // The ComfyUI package is not needed once extracted (2 GB).
      await fsp.rm(path.join(DL, 'ComfyUI_windows_portable_nvidia.7z'), { force: true });
      await fsp.writeFile(READY, JSON.stringify({ version: SETUP_VERSION, at: new Date().toISOString() }));
      log.info('ia local: instalada em', ROOT);
      this.set({ installing: false, stage: '', progress: undefined });
      return this.status();
    } catch (err) {
      log.error('ia local: instalação falhou', err);
      this.set({ installing: false, stage: '', progress: undefined, error: err.message });
      throw err;
    }
  }

  /** Resumable download into DL/<name> (a ".part" file until complete). */
  async download(f, onBytes) {
    const final = path.join(DL, f.name);
    if (exists(final) && (!f.size || fs.statSync(final).size === f.size)) { onBytes(f.size || 1e6); return; }
    const part = final + '.part';
    for (let attempt = 1; attempt <= 6; attempt++) {
      let have = exists(part) ? fs.statSync(part).size : 0;
      try {
        const res = await fetch(f.url, { headers: have ? { Range: `bytes=${have}-` } : {}, redirect: 'follow' });
        if (res.status === 416) break; // already complete
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (have && res.status !== 206) have = 0; // server ignored the range: start over
        const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
        let got = have;
        const reader = res.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
            got += value.length;
            onBytes(got);
          }
        } finally { await new Promise((r) => out.end(r)); }
        break;
      } catch (err) {
        log.warn('ia local: download falhou', f.name, `tentativa ${attempt}`, err.message);
        if (attempt === 6) throw new Error(`Não consegui baixar ${f.name}: ${err.message}. Verifique a internet e tente de novo (o download continua de onde parou).`);
        await sleep(3000 * attempt);
      }
    }
    if (f.size && fs.statSync(part).size !== f.size) throw new Error(`O download de ${f.name} veio incompleto. Tente de novo (continua de onde parou).`);
    await fsp.rename(part, final);
  }

  /**
   * Extracts a .zip with Windows' own tar (by full path: a "tar" from Git found first on the PATH
   * reads "C:" as a remote host), falling back to PowerShell.
   */
  async unzip(zip, dir) {
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (exists(tar)) {
      try { await this.run(tar, ['-xf', zip, '-C', dir], 120000); return; } catch (err) { log.warn('ia local: tar falhou, usando o PowerShell', err.message); }
    }
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    await this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${q(zip)} -DestinationPath ${q(dir)} -Force`], 120000);
  }

  run(cmd, args, timeout, cwd) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { windowsHide: true, timeout, cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) { log.warn('ia local:', path.basename(cmd), String(stderr || stdout).slice(-800)); reject(new Error(`${path.basename(cmd)} falhou: ${err.message}`)); } else resolve(stdout);
      });
    });
  }

  // --- server -----------------------------------------------------------------------------
  url(p) { return `http://127.0.0.1:${PORT}${p}`; }
  async alive() { try { const r = await fetch(this.url('/system_stats'), { signal: AbortSignal.timeout(1500) }); return r.ok; } catch (_) { return false; } }

  start() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      if (await this.alive()) return; // left running by an earlier session of the app
      // ComfyUI refuses folders that do not exist yet.
      for (const d of ['out', 'in', 'user']) await fsp.mkdir(path.join(ROOT, d), { recursive: true });
      const args = ['-s', MAIN, '--listen', '127.0.0.1', '--port', String(PORT), '--disable-auto-launch', '--preview-method', 'none',
        '--output-directory', path.join(ROOT, 'out'), '--input-directory', path.join(ROOT, 'in'), '--user-directory', path.join(ROOT, 'user')];
      this.proc = spawn(PY, args, { cwd: COMFY, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const p = this.proc;
      let tail = '';
      const keep = (b) => { tail = (tail + b).slice(-4000); };
      p.stdout.on('data', keep); p.stderr.on('data', keep);
      p.on('exit', (code) => {
        if (this.proc === p) { this.proc = null; this.ready = null; }
        log.info('ia local: ComfyUI encerrado', code);
        this.emit('status', this.status());
      });
      const t0 = Date.now();
      while (Date.now() - t0 < 4 * 60 * 1000) {
        if (!this.proc) throw new Error('O motor da IA local fechou ao iniciar: ' + tail.trim().split('\n').slice(-3).join(' '));
        if (await this.alive()) { log.info('ia local: ComfyUI pronto', `${Date.now() - t0} ms`); this.emit('status', this.status()); return; }
        await sleep(700);
      }
      throw new Error('O motor da IA local demorou demais para iniciar.');
    })().catch((err) => { this.stop(); throw err; });
    return this.ready;
  }

  armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.state.busy) this.stop(); }, IDLE_MS);
  }

  stop() {
    clearTimeout(this.idleTimer);
    const p = this.proc;
    this.proc = null; this.ready = null;
    if (p && p.exitCode === null) {
      // The embedded Python spawns no children we need to keep; kill the whole tree.
      try { execFile('taskkill', ['/pid', String(p.pid), '/t', '/f'], { windowsHide: true }, () => {}); } catch (_) { try { p.kill(); } catch (__) { /* ignore */ } }
      log.info('ia local: motor desligado (memória devolvida)');
    }
    this.emit('status', this.status());
  }

  // --- expansion ------------------------------------------------------------------------
  /**
   * Picture + mask for FLUX Fill: the picture centred on the wider (or taller) canvas, the new
   * areas pre-filled with its stretched, blurred edges (helps colours); mask = new areas plus a
   * soft overlap into the picture. Sizes are multiples of 16 around `pixels` total.
   */
  async prepare(image, aspect, pixels, holeFile = null) {
    const sharp = require('./img');
    const m = await sharp(image).metadata();
    const iw = m.width, ih = m.height;
    const wide = aspect >= iw / ih;
    const cw0 = wide ? ih * aspect : iw, ch0 = wide ? ih : iw / aspect;
    const s = Math.sqrt(pixels / (cw0 * ch0));
    const W = Math.max(512, Math.round((cw0 * s) / 16) * 16), H = Math.max(512, Math.round((ch0 * s) / 16) * 16);
    // Picture fitted to the canvas' full height (or width), centred.
    const pw = wide ? Math.round((iw / ih) * H) : W, ph = wide ? H : Math.round((ih / iw) * W);
    const px = Math.round((W - pw) / 2), py = Math.round((H - ph) / 2);
    const pic = await sharp(image).resize(pw, ph, { fit: 'fill', kernel: 'lanczos3' }).removeAlpha().raw().toBuffer();
    const canvas = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y++) {
      const sy = Math.min(ph - 1, Math.max(0, y - py));
      for (let x = 0; x < W; x++) {
        const sx = Math.min(pw - 1, Math.max(0, x - px)); // edge stretch outside the picture
        const s3 = (sy * pw + sx) * 3, d = (y * W + x) * 3;
        canvas[d] = pic[s3]; canvas[d + 1] = pic[s3 + 1]; canvas[d + 2] = pic[s3 + 2];
      }
    }
    // Blur only the new areas (the stretched streaks), keep the picture sharp.
    const blurred = await sharp(canvas, { raw: { width: W, height: H, channels: 3 } }).blur(Math.max(8, W / 60)).raw().toBuffer();
    const ov = Math.max(16, Math.round((wide ? W : H) * 0.02)); // soft overlap into the picture
    // Where people were taken out (empty scene): near the expanded edges that part is repainted
    // too, so the smooth fill there is not continued outwards as a smudge.
    const hole = holeFile ? await sharp(holeFile).resize(pw, ph, { fit: 'fill' }).extractChannel(0).raw().toBuffer() : null;
    const near = Math.round((wide ? pw : ph) * 0.15);
    const mask = Buffer.alloc(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const inside = Math.min(x - px, px + pw - 1 - x, y - py, py + ph - 1 - y); // < 0 = new area
      const edge = wide ? Math.min(x - px, px + pw - 1 - x) : Math.min(y - py, py + ph - 1 - y); // to an expanded edge
      const k = y * W + x;
      if (inside < 0) {
        mask[k] = 255;
        for (let c = 0; c < 3; c++) canvas[k * 3 + c] = blurred[k * 3 + c];
        continue;
      }
      let v = inside < ov && edge < ov ? Math.round(255 * (1 - edge / ov) * 0.85) : 0;
      if (hole && edge < near && hole[(y - py) * pw + (x - px)] > 127) v = Math.max(v, edge < near * 0.7 ? 255 : Math.round(255 * (1 - (edge - near * 0.7) / (near * 0.3))));
      mask[k] = v;
    }
    const tag = crypto.randomBytes(4).toString('hex');
    const imgFile = path.join(ROOT, 'in', `cw-${tag}.png`), maskFile = path.join(ROOT, 'in', `cw-${tag}-mask.png`);
    await fsp.mkdir(path.dirname(imgFile), { recursive: true });
    await sharp(canvas, { raw: { width: W, height: H, channels: 3 } }).png().toFile(imgFile);
    await sharp(mask, { raw: { width: W, height: H, channels: 1 } }).png().toFile(maskFile);
    return { W, H, wide, ov, rect: { x: px, y: py, w: pw, h: ph }, imgName: path.basename(imgFile), maskName: path.basename(maskFile), files: [imgFile, maskFile] };
  }

  /**
   * 0..1: how much the generated picture looks like a collage of panels instead of one scene.
   * FLUX Fill sometimes treats the original as one panel and draws other "photos" beside it,
   * split by a straight line or a white/black band right at the original's edge. Measured as the
   * share of rows with a strong jump across a column, for the columns around each expanded edge
   * (a real scene rarely has one straight cut along almost the whole height exactly there).
   */
  async panelScore(png, prep) {
    const sharp = require('./img');
    // Work "vertical seams" oriented: a tall expansion is rotated first.
    let img = sharp(png).removeAlpha().greyscale();
    if (!prep.wide) img = img.rotate(90);
    const { data: g, info } = await img.raw().toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height;
    const r = prep.wide ? prep.rect : { x: prep.H - prep.rect.y - prep.rect.h, y: prep.rect.x, w: prep.rect.h, h: prep.rect.w };
    let worst = 0;
    const scan = (x0, x1) => {
      for (let x = Math.max(2, x0); x < Math.min(W - 2, x1); x++) {
        let jumps = 0;
        for (let y = 0; y < H; y++) { const i = y * W + x; if (Math.abs(g[i + 2] - g[i - 2]) > 30) jumps++; }
        worst = Math.max(worst, jumps / H);
      }
    };
    const reach = Math.max(8, Math.round(Math.min(r.x, W - r.x - r.w) * 0.25));
    if (r.x > 4) scan(r.x - reach, r.x + prep.ov);
    if (r.x + r.w < W - 4) scan(r.x + r.w - prep.ov, r.x + r.w + reach);
    return worst;
  }

  workflow({ imgName, maskName, prompt, steps, seed }) {
    return {
      1: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'flux1-fill-dev-Q6_K.gguf' } },
      2: { class_type: 'DualCLIPLoader', inputs: { clip_name1: 'clip_l.safetensors', clip_name2: 't5xxl_fp8_e4m3fn_scaled.safetensors', type: 'flux' } },
      3: { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
      4: { class_type: 'LoadImage', inputs: { image: imgName } },
      5: { class_type: 'LoadImageMask', inputs: { image: maskName, channel: 'red' } },
      6: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 0] } },
      7: { class_type: 'FluxGuidance', inputs: { guidance: 30, conditioning: ['6', 0] } },
      8: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['6', 0] } },
      9: { class_type: 'InpaintModelConditioning', inputs: { positive: ['7', 0], negative: ['8', 0], vae: ['3', 0], pixels: ['4', 0], mask: ['5', 0], noise_mask: true } },
      10: { class_type: 'DifferentialDiffusion', inputs: { model: ['1', 0] } },
      11: { class_type: 'KSampler', inputs: { model: ['10', 0], positive: ['9', 0], negative: ['9', 1], latent_image: ['9', 2], seed, steps, cfg: 1, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
      12: { class_type: 'VAEDecode', inputs: { samples: ['11', 0], vae: ['3', 0] } },
      13: { class_type: 'SaveImage', inputs: { images: ['12', 0], filename_prefix: 'cw_expand' } },
    };
  }

  /** The picture without its people (plate-worker.js) → { file, people, hole, by }. */
  makePlate(image) {
    return new Promise((resolve, reject) => {
      const { Worker } = require('worker_threads');
      const out = path.join(ROOT, 'in', `cw-plate-${crypto.randomBytes(4).toString('hex')}.png`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const w = new Worker(path.join(__dirname, 'plate-worker.js'), {
        workerData: { image, out },
        env: { ...process.env, CW_SEG_MODEL: this.resource('models', 'anime-seg-isnetis.onnx'), CW_LAMA_MODEL: this.resource('models', 'lama.onnx') },
      });
      w.once('message', (m) => { w.terminate(); if (m.ok) resolve(m.r); else reject(new Error(m.error)); });
      w.once('error', reject);
    });
  }

  /** One FLUX Fill run on the ComfyUI server; returns the PNG bytes. */
  async generate(job, prep, prompt, steps, seed) {
    const clientId = crypto.randomUUID();
    // Progress over the websocket (sampling steps); the model load before it has no percentage.
    let ws = null;
    const finished = new Promise((resolve, reject) => {
      try {
        ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?clientId=${clientId}`);
        ws.onmessage = (ev) => {
          if (typeof ev.data !== 'string') return;
          let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
          if (m.type === 'progress' && m.data && m.data.max) this.set({ stage: 'Criando o cenário novo…', progress: m.data.value / m.data.max });
          if (m.type === 'executing' && m.data && m.data.node == null && m.data.prompt_id === job.promptId) resolve();
          if (m.type === 'execution_error' && m.data && m.data.prompt_id === job.promptId) reject(new Error(m.data.exception_message || 'erro no ComfyUI'));
          if (m.type === 'execution_interrupted') reject(new Error('cancelado'));
        };
        ws.onerror = () => {}; // the history poll below still finishes the job
      } catch (_) { /* no websocket: poll only */ }
    });
    finished.catch(() => {}); // a late rejection after the poll finished must not go unhandled
    if (!this.state.progress) this.set({ stage: 'Carregando o modelo FLUX Fill (na primeira vez demora mais)…' });
    try {
      const res = await fetch(this.url('/prompt'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: this.workflow({ ...prep, prompt, steps, seed }), client_id: clientId }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.prompt_id) throw new Error('O ComfyUI recusou o pedido: ' + JSON.stringify(body.node_errors || body.error || body).slice(0, 300));
      job.promptId = body.prompt_id;
      // Wait: websocket "done", or the history having the output (polled as a safety net).
      const t0 = Date.now();
      let out = null;
      const poll = (async () => {
        while (!out && !job.canceled) {
          await sleep(1500);
          if (Date.now() - t0 > 15 * 60 * 1000) throw new Error('A IA local demorou demais (mais de 15 minutos).');
          const h = await fetch(this.url(`/history/${job.promptId}`)).then((r) => r.json()).catch(() => null);
          const entry = h && h[job.promptId];
          if (entry && entry.status && entry.status.status_str === 'error') throw new Error('Erro no ComfyUI: ' + JSON.stringify(entry.status.messages || '').slice(-300));
          const imgs = entry && entry.outputs && entry.outputs['13'] && entry.outputs['13'].images;
          if (imgs && imgs.length) { out = imgs[0]; return; }
        }
        if (job.canceled) throw new Error('cancelado');
      })();
      await Promise.race([finished.then(() => poll), poll]);
      await poll;
      if (!out) throw new Error('A IA local não devolveu imagem.');
      this.set({ stage: 'Conferindo o resultado…', progress: 1 });
      const q = new URLSearchParams({ filename: out.filename, subfolder: out.subfolder || '', type: out.type || 'output' });
      const img = Buffer.from(await (await fetch(this.url(`/view?${q}`))).arrayBuffer());
      try { await fsp.rm(path.join(ROOT, 'out', out.subfolder || '', out.filename), { force: true }); } catch (_) { /* ignore */ }
      return img;
    } finally {
      try { ws && ws.close(); } catch (_) { /* ignore */ }
    }
  }

  /** opts: { image, aspect, quality: 'best' | 'fast', hint } → { file, width, height } */
  async expand(opts) {
    if (!this.installed()) throw new Error('A IA local ainda não está instalada.');
    if (this.state.busy) throw new Error('A IA local já está expandindo uma imagem.');
    const best = opts.quality !== 'fast';
    const job = { canceled: false };
    this.job = job;
    clearTimeout(this.idleTimer);
    this.set({ busy: true, error: '', stage: 'Ligando o motor da IA local…', progress: undefined });
    let prep = null;
    let plate = null;
    try {
      // The empty scene is made while the engine starts (both take ~20 s).
      const plating = this.makePlate(opts.image).catch((err) => { log.warn('ia local: cenário vazio falhou, usando a imagem', err.message); return null; });
      await this.start();
      if (job.canceled) throw new Error('cancelado');
      this.set({ stage: 'Tirando as pessoas da cena (para a IA não copiar ninguém)…' });
      plate = await plating;
      if (job.canceled) throw new Error('cancelado');
      const empty = !!(plate && plate.file !== opts.image);
      log.info('ia local: cenário vazio', plate ? JSON.stringify({ pessoas: plate.people, buraco: plate.hole, por: plate.by }) : 'falhou');
      this.set({ stage: 'Preparando a imagem…' });
      prep = await this.prepare(empty ? plate.file : opts.image, Number(opts.aspect) || 16 / 9, best ? 2.0e6 : 1.3e6, empty ? plate.holeFile : null);
      const hint = String(opts.hint || '').trim().slice(0, 400);
      // FLUX Fill ignores negative prompts, so everything is said as what the picture IS: one single
      // continuous shot (large outpaint areas otherwise tend to become a collage of panels).
      const prompt = [
        'One single continuous wide-angle photograph of one scene, seamlessly extended beyond the original frame.',
        'The same place continues naturally: the same walls, floor, furniture style, lighting, shadows, haze and colour grading, the same camera perspective and lens, the same depth of field and the same rendering style.',
        hint ? `The scene: ${hint}.` : '',
        empty
          ? 'An empty place with nobody in it: only the surroundings, furniture and background objects.'
          : 'The only people in the picture are the ones already in the middle; the extended areas show only the empty surroundings and background objects.',
        'A single image, not a collage: no panels, no split screen, no frames, no borders, no text, no logos, no signatures and no watermarks.',
        'Highly detailed, coherent, realistic textures.',
      ].filter(Boolean).join(' ');
      const steps = best ? 28 : 20;
      const t0 = Date.now();
      // Up to 3 tries: a picture that came out as a collage of panels is drawn again with another seed.
      let pick = null;
      for (let attempt = 1; attempt <= 3 && !job.canceled; attempt++) {
        const img = await this.generate(job, prep, prompt, steps, Math.floor(Math.random() * 2 ** 31));
        const score = await this.panelScore(img, prep);
        log.info('ia local: tentativa', attempt, 'colagem', score.toFixed(3));
        if (!pick || score < pick.score) pick = { img, score };
        if (score < 0.5) break;
        if (attempt < 3) this.set({ stage: `A IA desenhou uma moldura/colagem em vez do cenário; tentando de novo (${attempt + 1}/3)…`, progress: undefined });
      }
      if (job.canceled || !pick) throw new Error('cancelado');
      const file = this.workFile();
      await fsp.writeFile(file, pick.img);
      log.info('ia local: expansão pronta', `${prep.W}x${prep.H}`, `${steps} passos`, `${Date.now() - t0} ms`, 'colagem', pick.score.toFixed(3));
      this.set({ busy: false, stage: '', progress: undefined });
      // `place`: where the picture sits in the result (the merge skips the search: with the
      // empty scene in the middle, the people would not match anything there).
      return {
        file, width: prep.W, height: prep.H, place: prep.rect, panel: +pick.score.toFixed(3),
        warning: pick.score >= 0.5 ? 'A IA insistiu em desenhar uma moldura nas laterais. Confira o resultado ou tente de novo.' : '',
      };
    } catch (err) {
      const canceled = job.canceled || /cancelad/i.test(err.message);
      if (!canceled) log.error('ia local: expansão falhou', err);
      this.set({ busy: false, stage: '', progress: undefined, error: canceled ? '' : err.message });
      throw canceled ? new Error('cancelado') : err;
    } finally {
      if (prep) for (const f of prep.files) fsp.rm(f, { force: true }).catch(() => {});
      if (plate && plate.file !== opts.image) for (const f of [plate.file, plate.holeFile]) if (f) fsp.rm(f, { force: true }).catch(() => {});
      if (this.job === job) this.job = null;
      this.armIdle();
    }
  }

  async cancel() {
    if (!this.job) return;
    this.job.canceled = true;
    try { await fetch(this.url('/interrupt'), { method: 'POST' }); } catch (_) { /* server gone */ }
  }
}

module.exports = { LocalAi, ROOT, FILES };
