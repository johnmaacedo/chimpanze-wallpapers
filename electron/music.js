'use strict';
// Ambient music for the wallpaper on screen. John picks a YouTube video for a
// wallpaper (config.images[..].music = { id, title }); while that wallpaper is on
// the main monitor the video plays, sound only, at a low volume, in a hidden
// window of its own (session "persist:music", so signing in to YouTube there
// once keeps his Premium: no ads). Nothing is downloaded; it is YouTube's own
// page playing.
const { BrowserWindow, net } = require('electron');
const { EventEmitter } = require('events');
const log = require('./log');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const idOf = (s) => {
  const m = /(?:v=|youtu\.be\/|\/shorts\/|\/embed\/)([\w-]{11})/.exec(String(s || '')) || /^([\w-]{11})$/.exec(String(s || '').trim());
  return m ? m[1] : null;
};

/** Searches YouTube (its results page; no key, no account). → [{ id, title, channel, length }] */
async function search(query) {
  const direct = idOf(query);
  const url = 'https://www.youtube.com/results?hl=pt-BR&search_query=' + encodeURIComponent(direct ? direct : query);
  const res = await net.fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.6' } });
  if (!res.ok) throw new Error(`O YouTube respondeu ${res.status}.`);
  const html = await res.text();
  const m = /var ytInitialData = (\{.*?\});<\/script>/s.exec(html) || /ytInitialData"\]\s*=\s*(\{.*?\});/s.exec(html);
  if (!m) throw new Error('Não consegui ler a busca do YouTube (a página mudou?).');
  const out = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object' || out.length >= 12) return;
    if (o.videoRenderer && o.videoRenderer.videoId) {
      const v = o.videoRenderer;
      const text = (t) => (t ? (t.simpleText || (t.runs || []).map((r) => r.text).join('')) : '');
      const length = text(v.lengthText);
      if (length) out.push({ id: v.videoId, title: text(v.title), channel: text(v.ownerText || v.longBylineText), length });
      return;
    }
    for (const k in o) walk(o[k]);
  };
  walk(JSON.parse(m[1]));
  return out;
}

class Music extends EventEmitter {
  constructor({ config }) {
    super();
    this.config = config;
    this.win = null;
    this.current = null; // { id, title, file, preview }
    this.paused = false; // a fullscreen app is over the main monitor
    this.userPaused = false; // paused with the app's own player
    this.pos = { t: 0, d: 0, at: 0, playing: false }; // where the track is (for the app's seek bar)
    this.timer = null;
    this.noEmbed = new Set(); // videos whose owner does not allow the embedded player
  }

  settings() {
    const m = this.config.global.music || {};
    return { enabled: m.enabled !== false, volume: Math.max(0, Math.min(1, Number.isFinite(m.volume) ? m.volume : 0.15)) };
  }

  status() {
    return {
      playing: this.current ? { id: this.current.id, title: this.current.title, file: this.current.file, preview: !!this.current.preview, cat: this.current.cat || null } : null,
      paused: this.paused || this.userPaused, userPaused: this.userPaused, pos: this.pos, account: !!this.account, ...this.settings(),
    };
  }

  /** Signed in to YouTube in the player's own session (for Premium: no ads)? */
  async checkAccount() {
    try {
      const { session } = require('electron');
      const c = await session.fromPartition('persist:music').cookies.get({ domain: '.youtube.com' });
      const was = this.account;
      this.account = c.some((x) => x.name === 'LOGIN_INFO' || x.name === 'SAPISID' || x.name === '__Secure-3PSID');
      if (was !== this.account) this.emit('status', this.status());
    } catch (_) { /* ignore */ }
    return !!this.account;
  }

  /** Opens Google's sign-in for YouTube in the player window (the user types the password there). */
  login() {
    const w = this.window();
    w.loadURL('https://accounts.google.com/ServiceLogin?service=youtube&continue=' + encodeURIComponent('https://www.youtube.com/signin?action_handle_signin=true&next=%2F'));
    w.setSkipTaskbar(false); w.show(); w.focus();
    // When the sign-in ends back on YouTube, check it worked and restart the music signed in.
    const done = async () => {
      const u = w.webContents.getURL();
      if (!/youtube\.com/.test(u) || /accounts\.google/.test(u)) return;
      w.webContents.off('did-navigate', done);
      if (await this.checkAccount()) {
        log.info('música: conta do YouTube conectada');
        if (this.current) { const c = this.current; this.current = null; this.play(c.id, c.title, c.file, c.preview, c.cat); }
      }
    };
    w.webContents.on('did-navigate', done);
  }

  /** The app's player: play/pause and jump to a time (seconds). */
  toggle() { this.userPaused = !this.userPaused; this.apply(); this.emit('status', this.status()); return this.status(); }
  seek(t) {
    if (!this.win || this.win.isDestroyed() || !this.current) return this.status();
    const v = Math.max(0, Number(t) || 0);
    this.win.webContents.executeJavaScript(`(() => { const v = document.querySelector('video'); if (v) v.currentTime = ${v.toFixed(2)}; })()`, true).catch(() => {});
    this.pos = Object.assign({}, this.pos, { t: v, at: Date.now() });
    this.emit('status', this.status());
    return this.status();
  }

  /** Music categories made by the user: [{ id, name, tracks: [{ id, title, channel, length }] }]. */
  categories() { const c = (this.config.global.music || {}).categories; return Array.isArray(c) ? c : []; }

  /** A track of the category at random (not the one that just played, when there is another). */
  draw(cat, not) {
    const list = (cat.tracks || []).filter((t) => t && t.id);
    if (!list.length) return null;
    const pool = list.length > 1 ? list.filter((t) => t.id !== not) : list;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  window() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.win = new BrowserWindow({
      width: 980, height: 640, show: false, useContentSize: true, title: 'Música do wallpaper (YouTube)', autoHideMenuBar: true, skipTaskbar: true,
      webPreferences: { partition: 'persist:music', autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false, sandbox: true, contextIsolation: true },
    });
    this.win.webContents.setUserAgent(UA);
    // Closing the window only hides it (the music goes on); it is destroyed on quit.
    this.win.on('close', (e) => { if (!this.quitting) { e.preventDefault(); this.win.hide(); this.win.setSkipTaskbar(true); } });
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    return this.win;
  }

  /** Shows the player (to sign in to YouTube once, or to see what is playing). */
  show() {
    const w = this.window();
    if (!this.current && !w.webContents.getURL().includes('youtube.com')) w.loadURL('https://www.youtube.com/');
    w.setSkipTaskbar(false); w.show(); w.focus();
  }

  /** Runs in YouTube's page: keep the video looping, at our volume, playing or paused. */
  apply() {
    if (!this.win || this.win.isDestroyed() || !this.current) return;
    const { volume } = this.settings();
    // While the player window is open the user is in charge there: only the volume is kept.
    // (Forcing play/pause every few seconds fought with them; that is what froze the music.)
    const visible = this.win.isVisible();
    const pause = this.paused || this.userPaused;
    const control = visible ? '' : `
      for (const el of document.querySelectorAll('#secondary, #comments, #related, #chat, ytd-merch-shelf-renderer')) el.remove();
      ${pause ? 'if (!v.paused) v.pause();' : 'if (v.paused && !v.seeking) v.play().catch(() => {});'}`;
    const js = `(() => { if (document.querySelector('.ytp-error, .ytp-embed-error')) return { r: 'error' };
      const v = document.querySelector('video'); if (!v) return { r: 'none' };
      v.loop = ${this.current.cat ? 'false' : 'true'}; v.volume = ${volume.toFixed(3)}; v.muted = false;
      const ad = !!document.querySelector('.ad-showing');
      const st = { t: v.currentTime || 0, d: isFinite(v.duration) ? v.duration : 0, ad };
      if (v.ended) return Object.assign(st, { r: 'ended' });
      ${control}
      return Object.assign(st, { r: v.paused ? 'paused' : 'playing' }); })()`;
    // Silent until the volume is really set (the page starts at full volume).
    const wc = this.win.webContents;
    wc.executeJavaScript(js, true).then((res) => {
      const r = res && res.r;
      if (res && (r === 'playing' || r === 'paused')) {
        const was = this.pos;
        // During a YouTube ad (not signed in to Premium) keep the music's own length.
        this.pos = { t: res.ad ? was.t : res.t, d: res.ad ? was.d : res.d, at: Date.now(), playing: r === 'playing' && !res.ad, ad: !!res.ad };
        this.emit('status', this.status());
      }
      // The light embedded player was refused for this video ("playback on other websites
      // disabled"): play it on the normal page instead, and remember that for this video.
      if (r === 'error' && this.current && this.current.embed) {
        this.noEmbed.add(this.current.id);
        this.current.embed = false;
        log.info('música: vídeo não aceita o player embutido, usando a página normal', this.current.id);
        this.win.loadURL(`https://www.youtube.com/watch?v=${this.current.id}`).catch(() => {});
        return;
      }
      if (r !== 'none' && r !== 'error' && !wc.isDestroyed()) wc.setAudioMuted(false);
      // A category plays one track after another, drawn at random.
      if (r === 'ended' && this.current && this.current.cat) {
        const cat = this.categories().find((c) => c.id === this.current.cat);
        const next = cat && this.draw(cat, this.current.id);
        if (next) { const { file, cat: id } = this.current; this.current = null; this.play(next.id, next.title, file, false, id); }
      }
    }).catch(() => {});
  }

  play(id, title, file, preview = false, cat = null) {
    if (this.current && this.current.id === id) { this.current = Object.assign({}, this.current, { title, file, preview, cat }); this.apply(); this.emit('status', this.status()); return; }
    this.current = { id, title, file, preview, cat };
    const w = this.window();
    w.webContents.setAudioMuted(true);
    // The normal watch page (the embedded player is refused inside the app: YouTube error 152-4).
    w.loadURL(`https://www.youtube.com/watch?v=${id}`).catch((err) => log.warn('música: não carregou', err.message));
    clearInterval(this.timer);
    // The player takes a moment to exist, and YouTube resets the volume now and then.
    let n = 0;
    this.timer = setInterval(() => { this.apply(); if (++n > 6) { clearInterval(this.timer); this.timer = setInterval(() => this.apply(), 3000); } }, 1500);
    this.userPaused = false;
    this.pos = { t: 0, d: 0, at: Date.now(), playing: false };
    log.info('música: tocando', id, title || '');
    this.emit('status', this.status());
  }

  stop() {
    if (!this.current) return;
    this.current = null;
    clearInterval(this.timer);
    this.pos = { t: 0, d: 0, at: 0, playing: false };
    // Nothing to play: close the YouTube page altogether (it holds ~350 MB of memory).
    if (this.win && !this.win.isDestroyed() && !this.win.isVisible()) { this.win.destroy(); this.win = null; }
    else if (this.win && !this.win.isDestroyed()) this.win.loadURL('about:blank').catch(() => {});
    this.emit('status', this.status());
  }

  setPaused(p) {
    if (this.paused === !!p) return;
    this.paused = !!p;
    this.apply();
    this.emit('status', this.status());
  }

  /** The wallpaper on the main monitor changed (or the settings did): play its music, or none. */
  sync(file) {
    if (this.current && this.current.preview) return; // listening to a search result
    const { enabled } = this.settings();
    const img = enabled && file ? this.config.image(file) : {};
    const m = img.music;
    const cat = !m && img.musicCat ? this.categories().find((c) => c.id === img.musicCat) : null;
    if (m && m.id) this.play(m.id, m.title, file);
    else if (cat) {
      // Same category still playing (another wallpaper of it came up): let the track go on.
      const going = this.current && this.current.cat === cat.id && (cat.tracks || []).some((t) => t.id === this.current.id);
      if (going) this.current.file = file;
      else { const t = this.draw(cat, this.current && this.current.id); if (t) this.play(t.id, t.title, file, false, cat.id); else this.stop(); }
    } else this.stop();
    this.apply();
  }

  endPreview() { if (this.current && this.current.preview) { this.current = Object.assign({}, this.current, { preview: false }); this.stop(); } }

  destroy() {
    this.quitting = true;
    clearInterval(this.timer);
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
  }
}

module.exports = { Music, search, idOf };
