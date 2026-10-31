'use strict';
// Bridge to the installed ChatGPT desktop app (never the browser):
//  1. puts the picture on the clipboard and opens ChatGPT,
//  2. optionally types it in for the user (new chat → paste image → paste request → Enter),
//  3. watches Downloads and the clipboard for the edited picture coming back.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { app, clipboard, ClipboardItem } = require('electron');
const { EventEmitter } = require('events');
const log = require('./log');

const IMG_RE = /\.(png|jpe?g|webp)$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cachedAppId = null;

/**
 * AppUserModelID of the ChatGPT desktop app (Microsoft Store / MSIX). Since
 * late 2026 it ships as the "OpenAI.Codex" package, still named "ChatGPT" in
 * the Start menu. Only a hit is cached, so installing it later is noticed.
 */
function findApp() {
  if (cachedAppId) return Promise.resolve(cachedAppId);
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    const ps = "$a = Get-StartApps | Where-Object { $_.AppID -notmatch '^https?:' -and $_.AppID -match '!' }; "
      + "$hit = $a | Where-Object { $_.Name -eq 'ChatGPT' } | Select-Object -First 1; "
      + "if (-not $hit) { $hit = $a | Where-Object { $_.Name -match '^ChatGPT' -or $_.AppID -match '^OpenAI\\.' } | Select-Object -First 1 }; "
      + "if ($hit) { $hit.AppID }";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 }, (err, out) => {
      const id = String(out || '').trim().split(/\r?\n/)[0];
      if (id) cachedAppId = id;
      if (err) log.warn('chatgpt: Get-StartApps falhou', err.message);
      resolve(id || null);
    });
  });
}

function launch(appId) {
  // Shell activation of the packaged app: opens (or focuses) the desktop ChatGPT.
  spawn('explorer.exe', [`shell:AppsFolder\\${appId}`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// The desktop app's executable (never a browser tab that happens to say "ChatGPT").
const EXE_RE = /[\\/]ChatGPT\.exe$/i;
const isChatGpt = (fg) => !!fg && (fg.exe ? EXE_RE.test(fg.exe) : fg.title === 'ChatGPT');

/** Waits for the ChatGPT window to exist, then pulls it to the front. */
async function bringToFront(platform, timeoutMs, alive) {
  const t0 = Date.now();
  let lastFocus = 0;
  while (Date.now() - t0 < timeoutMs && alive()) {
    if (isChatGpt(platform.foregroundWindow())) return true;
    const w = platform.findAppWindow(EXE_RE);
    if (w && w.visible && Date.now() - lastFocus > 700) {
      lastFocus = Date.now();
      platform.focusWindow(w.hwnd);
    }
    await sleep(200);
  }
  return isChatGpt(platform.foregroundWindow());
}

/** Content fingerprint that survives the clipboard re-encoding the PNG. */
async function fingerprint(buf) {
  const sharp = require('./img');
  const raw = await sharp(buf).resize(24, 24, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const q = Buffer.from(raw.map((v) => v >> 4)); // tolerate tiny colour differences
  return crypto.createHash('md5').update(q).digest('hex');
}

/** Image → PNG on the clipboard, at most 2048 px on the long side (faster upload, same result). */
async function imageToClipboard(file) {
  const sharp = require('./img');
  const buf = await sharp(file, { limitInputPixels: false }).rotate().resize(2048, 2048, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([buf], { type: 'image/png' }) })]);
  return fingerprint(buf);
}

/** PNG bytes currently on the clipboard, or null. */
async function clipboardPng() {
  const items = await clipboard.read();
  for (const it of items) {
    if (!(it.types || []).includes('image/png')) continue;
    const blob = await it.getType('image/png');
    return Buffer.from(await blob.arrayBuffer());
  }
  return null;
}

class ChatGptBridge extends EventEmitter {
  constructor({ platform, workDir }) {
    super();
    this.platform = platform;
    this.workDir = workDir;
    this.session = null;
  }

  status() {
    return this.session ? { waiting: true, source: this.session.source, label: this.session.label, startedAt: this.session.startedAt, stage: this.session.stage } : { waiting: false };
  }

  setStage(stage) {
    if (this.session) { this.session.stage = stage; this.emit('status', this.status()); }
  }

  /**
   * opts: { image (file to send), source (original on disk), prompt, autoSend, newChat }
   */
  async send(opts) {
    this.cancel();
    const appId = await findApp();
    if (!appId) {
      const e = new Error('Não encontrei o aplicativo do ChatGPT instalado. Instale pela Microsoft Store (o app abre a página para você).');
      e.notInstalled = true;
      throw e;
    }
    const s = { source: opts.source, aspect: opts.aspect || 0, label: opts.label || '', startedAt: Date.now(), stage: 'Abrindo o ChatGPT…', known: new Set(), sentHash: '', id: Date.now() };
    this.session = s;
    this.emit('status', this.status());
    // Remember what is already in Downloads so only new files count.
    const dl = app.getPath('downloads');
    try { for (const f of fs.readdirSync(dl)) s.known.add(f); } catch (_) { /* ignore */ }

    s.sentHash = await imageToClipboard(opts.image);
    // A cold start (app closed or only in the tray) needs time to load the chat UI
    // after the window appears; an open window is ready almost at once.
    const before = this.platform.findAppWindow(EXE_RE);
    const warm = !!(before && before.visible);
    launch(appId);
    this.watch(s);

    const alive = () => this.session === s;
    const focused = await bringToFront(this.platform, warm ? 12000 : 45000, alive);
    if (!alive()) return { auto: false };
    if (!focused) {
      this.setStage('ChatGPT aberto. Cole a imagem (Ctrl+V) e o pedido, que já está copiado.');
      return { auto: false, reason: 'focus' };
    }
    if (!opts.autoType) {
      this.setStage('Imagem copiada. No ChatGPT: Ctrl+V, depois cole o pedido (botão "Copiar pedido").');
      return { auto: false };
    }
    // Macro: each step re-checks that the ChatGPT desktop window still has the
    // keyboard (pulling it back once if something stole the focus).
    const step = async (keys, wait, label) => {
      if (!alive()) throw new Error('cancelado');
      if (!isChatGpt(this.platform.foregroundWindow()) && !(await bringToFront(this.platform, 3000, alive))) throw new Error('foco');
      if (label) this.setStage(label);
      this.platform.sendKeys(keys);
      await sleep(wait);
    };
    try {
      this.setStage(warm ? 'Preparando o ChatGPT…' : 'Esperando o ChatGPT carregar…');
      await sleep(warm ? 900 : 6000);
      // Ctrl+N = "Novo chat" in the current app (the old one used Ctrl+Shift+O);
      // a new chat also puts the cursor in the message box.
      if (opts.newChat) await step(['CTRL', 'N'], 1800, 'Abrindo conversa nova…');
      // Clear any draft left in the message box from an earlier attempt.
      await step(['CTRL', 'A'], 150);
      await step(['DELETE'], 300);
      await step(['CTRL', 'V'], 3500, 'Colando a imagem…');
      await clipboard.writeText(opts.prompt);
      await step(['CTRL', 'V'], 800, 'Escrevendo o pedido…');
      if (opts.autoSend) {
        // Enter is ignored while the picture is still uploading, so press it a few
        // times; once sent, Enter on the empty box does nothing.
        await step(['ENTER'], 2500, 'Enviando…');
        await step(['ENTER'], 2500);
        await step(['ENTER'], 200);
      }
      this.setStage(opts.autoSend
        ? 'Enviado. Quando a imagem ficar pronta, baixe ou copie ela no ChatGPT, e o app pega sozinho.'
        : 'Tudo colado. Confira e aperte Enter no ChatGPT.');
      return { auto: true };
    } catch (err) {
      if (err.message === 'cancelado') return { auto: false };
      // Focus moved away: leave the request on the clipboard for a manual paste.
      await clipboard.writeText(opts.prompt);
      this.setStage('Você mudou de janela no meio. O pedido está copiado: cole no ChatGPT (Ctrl+V).');
      return { auto: false, reason: 'focus' };
    }
  }

  /** Copies the image or the request again (manual fallback). */
  async copyImage(file) { await imageToClipboard(file); }
  async copyText(text) { await clipboard.writeText(text); }

  watch(s) {
    const dl = app.getPath('downloads');
    const seen = new Map();
    const check = async (name) => {
      if (this.session !== s || !IMG_RE.test(name) || s.known.has(name)) return;
      const full = path.join(dl, name);
      let st;
      try { st = fs.statSync(full); } catch (_) { return; }
      if (Math.max(st.mtimeMs, st.birthtimeMs || 0) < s.startedAt - 2000 || st.size < 10000) return;
      // ChatGPT saves PNG/WebP ("ChatGPT Image …"); a JPG named otherwise is some
      // other download (e.g. from the browser) and must not be taken as the answer.
      if (!/chatgpt|image|imagem/i.test(name) && !/\.(png|webp)$/i.test(name)) return;
      // Wait until the size stops changing (download finished).
      const prev = seen.get(name);
      seen.set(name, st.size);
      if (prev !== st.size) { setTimeout(() => check(name), 900); return; }
      s.known.add(name);
      this.deliver(s, full, 'download');
    };
    try {
      s.watcher = fs.watch(dl, (ev, name) => { if (name) setTimeout(() => check(String(name)), 600); });
    } catch (err) { log.warn('chatgpt: não consegui vigiar Downloads', err.message); }
    // Clipboard: an image different from the one we sent = the answer (user clicked "Copiar").
    let polling = false;
    s.clipTimer = setInterval(async () => {
      if (this.session !== s || polling) return;
      polling = true;
      try {
        const png = await clipboardPng();
        if (!png) return;
        const h = await fingerprint(png);
        if (h === s.sentHash || h === s.lastClip) return;
        s.lastClip = h;
        if (Date.now() - s.startedAt < 8000) return; // still our own paste sequence
        const out = path.join(this.workDir(), `chatgpt-${Date.now().toString(36)}.png`);
        fs.writeFileSync(out, png);
        this.deliver(s, out, 'clipboard');
      } catch (_) { /* clipboard busy */ } finally { polling = false; }
    }, 1500);
    // Give up after 30 minutes.
    s.timeout = setTimeout(() => { if (this.session === s) this.cancel(); }, 30 * 60 * 1000);
  }

  async deliver(s, file, via) {
    if (this.session !== s) return;
    try {
      const sharp = require('./img');
      const meta = await sharp(file).metadata();
      if (!meta.width || meta.width < 256) return;
      log.info('chatgpt: imagem recebida', via, file, `${meta.width}x${meta.height}`);
      this.emit('result', { file, via, width: meta.width, height: meta.height, source: s.source, aspect: s.aspect, label: s.label });
      this.setStage('Imagem recebida!');
      this.cancel();
    } catch (err) { log.warn('chatgpt: arquivo inválido', file, err.message); }
  }

  cancel() {
    const s = this.session;
    if (!s) return;
    this.session = null;
    try { s.watcher && s.watcher.close(); } catch (_) { /* ignore */ }
    clearInterval(s.clipTimer);
    clearTimeout(s.timeout);
    this.emit('status', this.status());
  }
}

/** Saves a result as the edited version of `source` (optionally upscaled / cropped to an aspect). */
async function saveResult({ file, source, crop }, { EDIT_DIR }) {
  const sharp = require('./img');
  let img = sharp(file, { limitInputPixels: false }).rotate();
  if (crop && crop > 0) {
    const m = await sharp(file).metadata();
    let w = m.width; let h = m.height;
    if (Math.abs(w / h - crop) > 0.02) {
      if (w / h > crop) w = Math.round(h * crop); else h = Math.round(w / crop);
      img = img.extract({ left: Math.round((m.width - w) / 2), top: Math.round((m.height - h) / 2), width: w, height: h });
    }
  }
  const dir = path.join(path.dirname(source), EDIT_DIR);
  await fsp.mkdir(dir, { recursive: true });
  const name = path.parse(source).name;
  for (const ext of ['.png', '.jpg']) await fsp.rm(path.join(dir, name + ext), { force: true });
  const out = path.join(dir, name + '.png');
  await img.png({ compressionLevel: 6 }).toFile(out);
  return out;
}

const STORE_URL = 'ms-windows-store://pdp/?ProductId=9NT1R1C2HH7J';

module.exports = { ChatGptBridge, findApp, saveResult, STORE_URL, _test: { imageToClipboard, clipboardPng, fingerprint } };
