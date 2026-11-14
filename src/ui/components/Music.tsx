import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ExternalLink, Music2, Pause, Play, Search, Square, X, Check, ListMusic, Plus, Trash2, SkipForward, UserCheck, LogIn } from 'lucide-react';
import { api, useStore, fileName, folderName } from '../api';
import { Btn, Toggle } from './controls';

export interface Track { id: string; title: string; channel?: string; length?: string }
/** A group of tracks the user made (e.g. "Resident Evil"): wallpapers of the category play them at random. */
export interface MusicCat { id: string; name: string; tracks: Track[] }
interface MusicStatus {
  playing: { id: string; title: string; file?: string; preview?: boolean; cat?: string | null } | null;
  paused: boolean; userPaused?: boolean; enabled: boolean; volume: number; account?: boolean;
  /** Where the track is: seconds, length, when it was read, playing or not, an ad on screen. */
  pos?: { t: number; d: number; at: number; playing: boolean; ad?: boolean };
}
const clock = (s: number) => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`; };

function useMusic() {
  const [st, setSt] = useState<MusicStatus | null>(null);
  useEffect(() => {
    api.invoke<MusicStatus>('music:status').then(setSt).catch(() => {});
    return api.on('music', (s: MusicStatus) => setSt(s));
  }, []);
  return st;
}

/** The categories and a way to save them (they live in the global settings). */
export function useMusicCats() {
  const { state, setGlobal } = useStore();
  const m = ((state?.config.global as any)?.music || {}) as { enabled?: boolean; volume?: number; categories?: MusicCat[] };
  const cats = Array.isArray(m.categories) ? m.categories : [];
  const save = (next: MusicCat[]) => setGlobal({ music: { ...m, categories: next } });
  return { cats, save, music: m };
}

/** YouTube search box with results to listen to; `onPick` gets the chosen track. */
function TrackSearch({ start, onPick, pickLabel }: { start: string; onPick: (t: Track) => void; pickLabel: string }) {
  const { toast } = useStore();
  const st = useMusic();
  const [q, setQ] = useState(start);
  const [results, setResults] = useState<Track[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setQ(start); setResults(null); }, [start]);
  const run = async () => {
    if (!q.trim()) return;
    setBusy(true);
    try { setResults(await api.invoke<Track[]>('music:search', q.trim())); } catch (e: any) { toast({ kind: 'error', title: 'A busca falhou', message: e.message }); } finally { setBusy(false); }
  };
  const previewing = st?.playing?.preview ? st.playing.id : null;
  return (
    <>
      <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); run(); }}>
        <input className="input grow" placeholder="Ex.: Resident Evil 4 save room theme (ou cole um link do YouTube)" value={q} onChange={(e) => setQ(e.target.value)} />
        <Btn className="sm primary" disabled={busy || !q.trim()}><Search size={13} /> {busy ? 'Buscando…' : 'Buscar'}</Btn>
      </form>
      {results && !results.length && <span className="small muted">Nada encontrado. Tente outras palavras.</span>}
      {results && results.map((t) => (
        <div className={`track ${previewing === t.id ? 'on' : ''}`} key={t.id}>
          <Btn className="sm icon" title={previewing === t.id ? 'Parar' : 'Ouvir'} onClick={() => api.invoke(previewing === t.id ? 'music:stopPreview' : 'music:preview', t)}>{previewing === t.id ? <Square size={12} /> : <Play size={12} />}</Btn>
          <div className="g"><b className="ellipsis" title={t.title}>{t.title}</b><small className="ellipsis">{t.channel}{t.length ? ` · ${t.length}` : ''}</small></div>
          <Btn className="sm" onClick={() => onPick(t)}>{pickLabel}</Btn>
        </div>
      ))}
    </>
  );
}

/** One strip for the whole app (page Monitores): the switch, the volume and what is playing. */
export function MusicBar() {
  const { state, setGlobal } = useStore();
  const st = useMusic();
  const { cats, music: m } = useMusicCats();
  const [manage, setManage] = useState(false);
  if (!state) return null;
  const enabled = m.enabled !== false;
  const volume = Number.isFinite(m.volume) ? (m.volume as number) : 0.15;
  const set = (patch: any) => setGlobal({ music: { ...m, ...patch } });
  const cat = st?.playing?.cat ? cats.find((c) => c.id === st.playing!.cat) : null;
  const follow = (m as any).follow || '';
  const followName = (() => { const mon = state.monitors.find((x) => x.id === follow) || state.monitors.find((x) => x.primary); return mon ? `monitor ${mon.index}` : 'monitor principal'; })();
  return (
    <div className={`music-wrap ${enabled ? 'on' : ''}`}>
    <div className={`music-bar ${enabled ? 'on' : ''}`}>
      <span className="ico"><Music2 size={16} /></span>
      <div className="grow" style={{ minWidth: 0 }}>
        <b>Música do wallpaper</b>
        <span className="small muted ellipsis" style={{ display: 'block' }}>
          {!enabled ? 'Desligada.' : st?.playing ? `${st.paused ? 'Pausada' : 'Tocando'}${cat ? ` (${cat.name})` : ''}: ${st.playing.title || 'vídeo do YouTube'}` : `O wallpaper do ${followName} não tem música. Escolha em "Música deste wallpaper" ou crie uma categoria.`}
        </span>
      </div>
      {enabled && cat && <Btn className="sm icon" title="Outra música da categoria" onClick={() => api.invoke('music:next')}><SkipForward size={13} /></Btn>}
      {enabled && (
        <label className="vol" title="Volume da música">
          <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => set({ volume: Number(e.target.value) })} />
          <span>{Math.round(volume * 100)}%</span>
        </label>
      )}
      <Btn className="sm" onClick={() => setManage(true)}><ListMusic size={13} /> Categorias{cats.length ? ` (${cats.length})` : ''}</Btn>
      <Btn className="sm ghost" title="Abre a página do YouTube que está tocando" onClick={() => api.invoke('music:show')}><ExternalLink size={13} /> Tocador</Btn>
      <Toggle on={enabled} onChange={(v) => set({ enabled: v })} label="Música do wallpaper" />
      {manage && <MusicCategories onClose={() => setManage(false)} />}
    </div>
    {enabled && (
      <div className="music-row">
        <div className="music-src">
          <span className="small muted">Tocar a música do wallpaper do</span>
          <div className="seg mini">
            {state.monitors.map((mon) => {
              const on = follow ? follow === mon.id : mon.primary;
              return <button key={mon.id} className={on ? 'on' : ''} onClick={() => set({ follow: mon.primary ? '' : mon.id })}>Monitor {mon.index}</button>;
            })}
          </div>
        </div>
        {st?.playing && <MusicPlayer st={st} />}
        {st && (st.account
          ? <span className="acct ok" title="O tocador usa a sua conta do YouTube (Premium = sem anúncios)"><UserCheck size={13} /> Conta do YouTube conectada</span>
          : <Btn className="sm" title="Abre o login do Google numa janela. Você digita a sua senha lá; ela fica só no seu PC." onClick={() => api.invoke('music:login')}><LogIn size={13} /> Entrar no YouTube (Premium, sem anúncios)</Btn>)}
      </div>
    )}
    </div>
  );
}

/** Play/pause and a seek bar for the track playing (the position is estimated between reads). */
function MusicPlayer({ st }: { st: MusicStatus }) {
  const [, tick] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);
  const pos = st.pos || { t: 0, d: 0, at: Date.now(), playing: false };
  useEffect(() => { if (!pos.playing) return; const t = setInterval(() => tick((x) => x + 1), 500); return () => clearInterval(t); }, [pos.playing]);
  const now = pos.playing ? Math.min(pos.d || Infinity, pos.t + (Date.now() - pos.at) / 1000) : pos.t;
  const shown = drag ?? now;
  return (
    <div className="music-player">
      <Btn className="sm icon" title={st.userPaused ? 'Tocar' : 'Pausar'} onClick={() => api.invoke('music:toggle')}>{st.userPaused ? <Play size={13} /> : <Pause size={13} />}</Btn>
      <span className="tm">{clock(shown)}</span>
      <input type="range" min={0} max={Math.max(1, pos.d)} step={1} value={Math.min(shown, Math.max(1, pos.d))} disabled={!pos.d}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={() => { if (drag != null) { api.invoke('music:seek', drag); setDrag(null); } }}
        onKeyUp={() => { if (drag != null) { api.invoke('music:seek', drag); setDrag(null); } }}
        style={{ ['--p' as any]: `${pos.d ? (Math.min(shown, pos.d) / pos.d) * 100 : 0}%` }} />
      <span className="tm">{pos.d ? clock(pos.d) : '--:--'}</span>
      {pos.ad && <span className="small muted">anúncio do YouTube…</span>}
    </div>
  );
}

/** Make categories, name them and fill them with YouTube tracks. */
export function MusicCategories({ onClose }: { onClose: () => void }) {
  const { cats, save } = useMusicCats();
  const [sel, setSel] = useState<string | null>(cats[0]?.id || null);
  const cur = cats.find((c) => c.id === sel) || null;
  useEffect(() => () => { api.invoke('music:stopPreview').catch(() => {}); }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
  const add = () => { const c: MusicCat = { id: `c${Date.now().toString(36)}`, name: 'Nova categoria', tracks: [] }; save([...cats, c]); setSel(c.id); };
  const patch = (id: string, p: Partial<MusicCat>) => save(cats.map((c) => (c.id === id ? { ...c, ...p } : c)));
  return createPortal(
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal wide music-cats">
        <div className="modal-head">
          <div><h2><ListMusic size={18} /> Categorias de música</h2><p className="muted small">Cada categoria junta músicas do YouTube. Os wallpapers ligados a ela tocam uma delas, sorteada, e passam para outra quando acaba.</p></div>
          <button className="modal-x" onClick={onClose} aria-label="Fechar"><X size={18} /></button>
        </div>
        <div className="mc-body">
          <div className="mc-list">
            {cats.map((c) => (
              <button key={c.id} className={`mc-item ${sel === c.id ? 'on' : ''}`} onClick={() => setSel(c.id)}>
                <span className="grow ellipsis">{c.name}</span><small>{c.tracks.length}</small>
              </button>
            ))}
            <Btn className="sm" onClick={add}><Plus size={13} /> Nova categoria</Btn>
          </div>
          {cur ? (
            <div className="mc-edit">
              <div className="row" style={{ gap: 8 }}>
                <input className="input grow" value={cur.name} onChange={(e) => patch(cur.id, { name: e.target.value })} placeholder="Nome (ex.: Resident Evil)" />
                <Btn className="sm danger" title="Apagar esta categoria" onClick={() => { save(cats.filter((c) => c.id !== cur.id)); setSel(null); }}><Trash2 size={13} /></Btn>
              </div>
              <span className="label">Músicas desta categoria ({cur.tracks.length})</span>
              {!cur.tracks.length && <span className="small muted">Ainda vazia. Busque abaixo e clique em Adicionar.</span>}
              {cur.tracks.map((t) => (
                <div className="track" key={t.id}>
                  <Btn className="sm icon" title="Ouvir" onClick={() => api.invoke('music:preview', t)}><Play size={12} /></Btn>
                  <div className="g"><b className="ellipsis" title={t.title}>{t.title}</b><small className="ellipsis">{t.channel}{t.length ? ` · ${t.length}` : ''}</small></div>
                  <Btn className="sm ghost icon" title="Tirar da categoria" onClick={() => patch(cur.id, { tracks: cur.tracks.filter((x) => x.id !== t.id) })}><X size={13} /></Btn>
                </div>
              ))}
              <span className="label">Adicionar do YouTube</span>
              <TrackSearch start={`${cur.name === 'Nova categoria' ? '' : cur.name} ost theme`.trim()} pickLabel="Adicionar" onPick={(t) => { if (!cur.tracks.some((x) => x.id === t.id)) patch(cur.id, { tracks: [...cur.tracks, t] }); }} />
            </div>
          ) : <div className="mc-edit"><span className="muted">Crie uma categoria para começar (ex.: Resident Evil, Naruto, Relax).</span></div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** "Música deste wallpaper": a category (random tracks) or one track of its own. Saved with the picture. */
export function ImageMusic({ file }: { file: string }) {
  const { state, toast } = useStore();
  const st = useMusic();
  const { cats } = useMusicCats();
  const entry = state?.config.images?.[file.toLowerCase()] as any;
  const chosen: Track | null = entry?.music || null;
  const cat = cats.find((c) => c.id === entry?.musicCat) || null;
  const [open, setOpen] = useState(false);
  const [manage, setManage] = useState(false);
  // Starting point for the search: the folder and the file name usually say what it is.
  const guess = `${folderName(file.replace(/[\\/][^\\/]*$/, ''))} ${fileName(file).replace(/\.[a-z0-9]+$/i, '').replace(/[_\-.]+/g, ' ').replace(/\b[a-z0-9]{12,}\b/gi, '')}`.replace(/\s+/g, ' ').trim();
  // Leaving the picker ends a preview (the monitor's own music comes back).
  useEffect(() => () => { api.invoke('music:stopPreview').catch(() => {}); }, []);
  if (!state) return null;
  const use = async (t: Track | null) => {
    await api.invoke('music:set', file, t);
    toast(t ? { kind: 'ok', title: 'Música salva neste wallpaper', message: t.title } : { kind: 'info', title: 'Música própria removida' });
  };
  const head = chosen ? `Música: ${chosen.title}` : cat ? `Música: categoria ${cat.name}` : 'Música deste wallpaper';

  return (
    <div className={`img-look ${open ? 'open' : ''} ${chosen || cat ? 'own' : ''}`}>
      <button className="img-look-head" onClick={() => { const v = !open; setOpen(v); if (!v) api.invoke('music:stopPreview').catch(() => {}); }}>
        <Music2 size={14} />
        <span className="grow ellipsis">{head}</span>
        {(chosen || cat) && <span className="chip-on">salva</span>}
        <ChevronDown size={14} className="chev" />
      </button>
      {open && (
        <div className="img-look-body">
          <span className="label">Categoria (toca uma música sorteada dela)</span>
          <div className="row" style={{ gap: 6 }}>
            <select className="select grow" value={entry?.musicCat || ''} onChange={(e) => api.invoke('music:setCat', [file], e.target.value || null)}>
              <option value="">Nenhuma</option>
              {cats.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.tracks.length})</option>)}
            </select>
            <Btn className="sm" onClick={() => setManage(true)}><ListMusic size={13} /> Categorias</Btn>
          </div>
          <span className="label">Ou uma música só deste wallpaper{chosen && cat ? ' (ela vale no lugar da categoria)' : ''}</span>
          {chosen && (
            <div className="track on">
              <Check size={14} />
              <div className="g"><b className="ellipsis">{chosen.title}</b><small className="ellipsis">{chosen.channel || 'YouTube'}{chosen.length ? ` · ${chosen.length}` : ''}</small></div>
              <Btn className="sm ghost" title="Tirar a música própria" onClick={() => use(null)}><X size={13} /></Btn>
            </div>
          )}
          <TrackSearch start={`${guess} theme ost`.trim()} pickLabel="Usar" onPick={use} />
          {st && !st.enabled && <span className="small muted"><Pause size={11} /> A música está desligada na página Monitores.</span>}
          {manage && <MusicCategories onClose={() => setManage(false)} />}
        </div>
      )}
    </div>
  );
}
