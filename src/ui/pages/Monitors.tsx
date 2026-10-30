import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { FolderOpen, ScanSearch, MonitorSmartphone, SkipBack, SkipForward, Pin, PinOff, Trash, RefreshCw, Shuffle, ListOrdered, Sparkles } from 'lucide-react';
import { api, useStore, useThumb, thumbUrl, fileName, folderName, TRANSITION_LABELS, TRANSITION_LIST, TRANSITION_CATEGORIES, EASING_LABELS, FIT_LABELS, type MonitorCfg, type MediaItem } from '../api';
import { MonitorStage, useCountdown } from '../components/MonitorStage';
import { Btn, Segmented, SwitchRow, Toggle } from '../components/controls';
import { TransitionPreview } from '../components/TransitionPreview';

const PRESETS = [
  { s: 30, l: '30s' }, { s: 60, l: '1 min' }, { s: 300, l: '5 min' }, { s: 900, l: '15 min' }, { s: 1800, l: '30 min' }, { s: 3600, l: '1 h' }, { s: 10800, l: '3 h' }, { s: 86400, l: '1 dia' },
];

export function MonitorsPage({ selected, setSelected }: { selected: string | null; setSelected: (id: string) => void }) {
  const { state, toast } = useStore();
  const [scanning, setScanning] = useState(false);
  if (!state) return null;
  const isOffline = selected ? !state.monitors.some((m) => m.id === selected) : false;

  const rescan = async () => {
    setScanning(true);
    try { await api.invoke('monitors:rescan'); } finally { setTimeout(() => setScanning(false), 500); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Seus monitores</h1>
          <p>Cada tela tem a própria pasta, o próprio timer e a própria transição. Tirou um cabo? A configuração fica guardada e volta sozinha quando ele for reconectado.</p>
        </div>
        <div className="actions">
          <Btn onClick={() => api.invoke('monitors:identify')}><MonitorSmartphone size={16} /> Identificar</Btn>
          <Btn onClick={rescan}>
            <motion.span animate={{ rotate: scanning ? 360 : 0 }} transition={{ duration: 0.8, repeat: scanning ? Infinity : 0, ease: 'linear' }} style={{ display: 'inline-flex' }}><ScanSearch size={16} /></motion.span>
            Detectar monitores
          </Btn>
        </div>
      </div>

      <MonitorStage selected={selected} onSelect={setSelected} />

      <AnimatePresence mode="wait">
        {selected && (
          <motion.div key={selected} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.35, ease: [0.22, 0.8, 0.25, 1] }}>
            {isOffline ? <OfflinePanel id={selected} /> : <MonitorPanel id={selected} toastErr={(m) => toast({ kind: 'error', title: 'Não deu certo', message: m })} />}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function OfflinePanel({ id }: { id: string }) {
  const { state, refresh } = useStore();
  const cfg = state!.config.monitors[id];
  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <h3>{cfg?.alias || cfg?.name || 'Monitor'} <span className="sub">desconectado</span></h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Este monitor não está ligado agora. Pasta, timer e transição continuam salvos e voltam a funcionar assim que ele for reconectado.
      </p>
      <div className="row">
        {cfg?.folder && <span className="muted small ellipsis grow">Pasta: {cfg.folder}</span>}
        <Btn className="danger sm" onClick={async () => { await api.invoke('monitor:forget', id); refresh(); }}><Trash size={14} /> Esquecer este monitor</Btn>
      </div>
    </div>
  );
}

function MonitorPanel({ id, toastErr }: { id: string; toastErr: (m: string) => void }) {
  const { state, setMonitor, mediaVersion } = useStore();
  const mon = state!.monitors.find((m) => m.id === id)!;
  const cfg: MonitorCfg = state!.config.monitors[id] || ({ id, folder: '', intervalSec: 300, auto: true, order: 'random', transition: 'inherit', transitionMs: 0, easing: 'inherit', fit: 'cover', kenBurns: true, fixed: '', current: '' } as MonitorCfg);
  const g = state!.config.global;
  const countdown = useCountdown(id);
  const current = cfg.fixed || cfg.current;
  const thumb = useThumb(current || null);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [previewPics, setPreviewPics] = useState<[string | null, string | null]>([null, null]);

  useEffect(() => {
    let alive = true;
    if (!cfg.folder) { setItems([]); return; }
    api.invoke<MediaItem[]>('media:list', cfg.folder, { includeSubfolders: cfg.includeSubfolders }).then((xs) => alive && setItems(xs)).catch(() => {});
    return () => { alive = false; };
  }, [cfg.folder, cfg.includeSubfolders, mediaVersion]);

  // Two stills for the live transition preview.
  useEffect(() => {
    let alive = true;
    const stills = items.filter((i) => i.type === 'image');
    const a = current && stills.find((s) => s.path === current) ? current : stills[0]?.path;
    const b = stills.find((s) => s.path !== a)?.path || a;
    Promise.all([a ? thumbUrl(a) : null, b ? thumbUrl(b) : null]).then(([ua, ub]) => alive && setPreviewPics([ua, ub]));
    return () => { alive = false; };
  }, [items, current]);

  const counts = useMemo(() => {
    const c = { image: 0, gif: 0, video: 0, up: 0 };
    for (const i of items) { c[i.type]++; if (i.upscaled) c.up++; }
    return c;
  }, [items]);

  const set = (patch: Partial<MonitorCfg>) => setMonitor(id, patch).catch((e) => toastErr(e.message));
  const pickFolder = async () => {
    const f = await api.invoke<string | null>('dialog:folder', `Pasta de wallpapers do ${mon.name}`);
    if (f) set({ folder: f, fixed: '' });
  };
  const transition = cfg.transition === 'inherit' ? g.defaultTransition : cfg.transition;
  const duration = cfg.transitionMs || g.transitionMs;
  const easing = cfg.easing === 'inherit' ? g.easing : cfg.easing;
  const isPreset = PRESETS.some((p) => p.s === cfg.intervalSec);

  return (
    <div className="monitor-grid">
      <div className="stack">
        <div className="panel">
          <h3>{mon.index}. {cfg.alias || mon.name} <span className="sub">{mon.rect.width}×{mon.rect.height}{mon.scaleFactor !== 1 ? `, escala ${Math.round(mon.scaleFactor * 100)}%` : ''}</span></h3>
          <div className="stack">
            <button className="folder-box" onClick={pickFolder} style={{ textAlign: 'left' }}>
              <span className="ico"><FolderOpen size={20} /></span>
              <span className="grow" style={{ minWidth: 0 }}>
                <span className="t ellipsis" style={{ display: 'block' }}>{cfg.folder ? folderName(cfg.folder) : 'Escolher pasta de wallpapers'}</span>
                <span className="p ellipsis" style={{ display: 'block' }}>
                  {cfg.folder ? `${counts.image} imagens${counts.video + counts.gif ? `, ${counts.video + counts.gif} animados` : ''}${counts.up ? `, ${counts.up} em 4K` : ''}` : 'JPG, PNG, WebP, GIF, MP4 e WebM'}
                </span>
              </span>
              <span className="btn sm">{cfg.folder ? 'Trocar' : 'Escolher'}</span>
            </button>

            {current && (
              <div className="now-playing">
                <div className="thumb">{thumb && <img src={thumb} alt="" />}</div>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis" style={{ fontWeight: 700 }}>{fileName(current)}</div>
                  <div className="muted small">
                    {cfg.fixed ? 'Fixado neste monitor' : cfg.auto && cfg.folder ? (countdown ? `Próxima troca em ${countdown}` : 'Agendando…') : 'Troca automática desligada'}
                  </div>
                  <div className="ctrl-row">
                    <Btn className="sm icon" title="Anterior" onClick={() => api.invoke('monitor:prev', id).catch((e) => toastErr(e.message))}><SkipBack size={15} /></Btn>
                    <Btn className="sm primary" disabled={!cfg.folder} onClick={() => api.invoke('monitor:next', id).catch((e) => toastErr(e.message))}><SkipForward size={15} /> Próximo</Btn>
                    {cfg.fixed
                      ? <Btn className="sm" onClick={() => set({ fixed: '' })}><PinOff size={14} /> Soltar</Btn>
                      : <Btn className="sm" onClick={() => current && set({ fixed: current })}><Pin size={14} /> Fixar este</Btn>}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="panel">
          <h3>Troca automática</h3>
          <SwitchRow title="Trocar sozinho" desc="Usa o timer abaixo, independente dos outros monitores." on={cfg.auto} onChange={(v) => set({ auto: v })} />
          <div style={{ opacity: cfg.auto ? 1 : 0.45, pointerEvents: cfg.auto ? 'auto' : 'none', transition: 'opacity .3s' }}>
            <div className="field" style={{ marginTop: 6 }}>
              <span className="label">Intervalo</span>
              <div className="interval">
                {PRESETS.map((p) => (
                  <button key={p.s} className={`chipbtn ${cfg.intervalSec === p.s ? 'on' : ''}`} onClick={() => set({ intervalSec: p.s })}>{p.l}</button>
                ))}
                <IntervalCustom value={cfg.intervalSec} active={!isPreset} onChange={(s) => set({ intervalSec: s })} />
              </div>
            </div>
            <div className="row" style={{ marginTop: 14, justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <Segmented value={cfg.order} onChange={(v) => set({ order: v })} options={[{ value: 'random', label: 'Aleatória' }, { value: 'sequential', label: 'Em ordem' }]} />
              <label className="row small muted" style={{ gap: 8 }}>
                <Toggle on={cfg.includeSubfolders} onChange={(v) => set({ includeSubfolders: v })} label="Incluir subpastas" /> Incluir subpastas
              </label>
            </div>
            <div className="muted small" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              {cfg.order === 'random' ? <Shuffle size={13} /> : <ListOrdered size={13} />}
              {cfg.order === 'random' ? 'Mostra todas antes de repetir alguma.' : 'Segue a ordem dos nomes dos arquivos.'}
            </div>
          </div>
        </div>
      </div>

      <div className="stack">
        <div className="panel">
          <h3>Transição <span className="sub">prévia ao vivo com o shader real</span></h3>
          <div style={{ aspectRatio: '16 / 9', borderRadius: 14, overflow: 'hidden', background: '#000', border: '1px solid var(--line)', marginBottom: 14 }}>
            {previewPics[0]
              ? <TransitionPreview a={previewPics[0]} b={previewPics[1]} transition={transition} duration={duration} easing={easing} fit={cfg.fit} />
              : <div className="empty-state" style={{ height: '100%', border: 0, padding: 20 }}>Escolha uma pasta para ver a prévia.</div>}
          </div>
          <div className="trans-grid">
            <button className={`trans-card random ${cfg.transition === 'inherit' ? 'on' : ''}`} onClick={() => set({ transition: 'inherit' })}>
              <span className="t"><Sparkles size={13} /> Padrão do app<br /><span style={{ fontWeight: 500, fontSize: 10.5 }}>{TRANSITION_LABELS[g.defaultTransition]}</span></span>
            </button>
            <TransCard name="random" label="Aleatória" on={cfg.transition === 'random'} onClick={() => set({ transition: 'random' })} />
            <TransCard name="randomSoft" label="Aleatória suave" on={cfg.transition === 'randomSoft'} onClick={() => set({ transition: 'randomSoft' })} />
          </div>
          {TRANSITION_CATEGORIES.map((cat) => (
            <div key={cat.id}>
              <div className="trans-cat">{cat.label}</div>
              <div className="trans-grid">
                {TRANSITION_LIST.filter((t) => t.cat === cat.id).map((t) => (
                  <TransCard key={t.id} name={t.id} label={t.label} on={cfg.transition === t.id} onClick={() => set({ transition: t.id })} />
                ))}
              </div>
            </div>
          ))}
          <div className="row" style={{ marginTop: 16, gap: 14, flexWrap: 'wrap' }}>
            <div className="field grow" style={{ minWidth: 180 }}>
              <span className="label">Duração: {(duration / 1000).toFixed(1)} s</span>
              <input type="range" min={400} max={4000} step={100} value={duration} onChange={(e) => set({ transitionMs: Number(e.target.value) })} />
            </div>
            <div className="field" style={{ minWidth: 170 }}>
              <span className="label">Curva</span>
              <select className="select" value={cfg.easing} onChange={(e) => set({ easing: e.target.value })}>
                <option value="inherit">Padrão do app</option>
                {Object.entries(EASING_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
          </div>
        </div>

        <div className="panel">
          <h3>Enquadramento</h3>
          <div className="field">
            <select className="select" value={cfg.fit} onChange={(e) => set({ fit: e.target.value as any })}>
              {Object.entries(FIT_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
          <SwitchRow title="Movimento sutil (Ken Burns)" desc="Zoom e deslize bem lentos enquanto a imagem fica parada." on={cfg.kenBurns} onChange={(v) => set({ kenBurns: v })} />
          <div className="field" style={{ marginTop: 6 }}>
            <span className="label">Apelido do monitor</span>
            <input className="input" placeholder={mon.name} defaultValue={cfg.alias} onBlur={(e) => set({ alias: e.target.value.trim() })} />
          </div>
          {cfg.folder && (
            <div className="row" style={{ marginTop: 14 }}>
              <Btn className="sm ghost" onClick={() => set({ folder: '', fixed: '', current: '' })}><RefreshCw size={14} /> Devolver este monitor ao wallpaper do Windows</Btn>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TransCard({ name, label, on, onClick }: { name: string; label: string; on: boolean; onClick: () => void }) {
  if (name === 'random' || name === 'randomSoft') {
    return <button className={`trans-card ${on ? 'on' : ''}`} onClick={onClick} style={{ background: 'linear-gradient(135deg, #3a2a20, #24170f)' }}><span className="t"><Shuffle size={12} /> {label}</span></button>;
  }
  return (
    <motion.button className={`trans-card ${on ? 'on' : ''}`} onClick={onClick} whileHover={{ y: -2 }} whileTap={{ scale: 0.96 }}
      style={{ background: GLYPH_BG[name] || 'var(--cocoa-0)' }}>
      <span className="t">{label}</span>
    </motion.button>
  );
}

// Each card gets a small visual signature hinting at the motion.
const GLYPH_BG: Record<string, string> = {
  fade: 'linear-gradient(90deg, #2b1d15, #6b4a33)',
  zoomBlur: 'radial-gradient(circle at 50% 50%, #ffb547 0, #4a2f1e 40%, #1a110c 75%)',
  liquid: 'radial-gradient(120% 80% at 20% 80%, #4a7fa8 0, transparent 50%), radial-gradient(90% 70% at 80% 20%, #8a5532 0, #1a110c 70%)',
  circleReveal: 'radial-gradient(circle at 40% 50%, #ff9a3d 0 22%, #ffe1b0 23%, #2a1b12 26%)',
  slices: 'repeating-linear-gradient(90deg, #6b4a33 0 12px, #2a1b12 12px 24px)',
  glitch: 'linear-gradient(0deg, #2a1b12 0 30%, #ff6f61 30% 34%, #2a1b12 34% 60%, #59d6ff 60% 63%, #2a1b12 63%)',
  pixelDissolve: 'conic-gradient(from 0deg at 50% 50%, #6b4a33 25%, #2a1b12 0 50%, #6b4a33 0 75%, #2a1b12 0) 0 0 / 16px 16px',
  softWipe: 'linear-gradient(115deg, #6b4a33 0 45%, #ffb547 50%, #2a1b12 55%)',
  inkBleed: 'radial-gradient(60% 60% at 30% 40%, #1a110c 0 40%, transparent 41%), radial-gradient(50% 50% at 70% 60%, #1a110c 0 35%, #6b4a33 36%)',
  parallaxSlide: 'linear-gradient(90deg, #2a1b12 0 58%, #120c09 58% 60%, #8a5532 60%)',
  ripple: 'repeating-radial-gradient(circle at 50% 50%, #3a2a20 0 6px, #6b4a33 6px 12px)',
  dreamWave: 'linear-gradient(160deg, #3d2a52, #6b4a33 60%, #ffb547)',
  cardSwap: 'linear-gradient(90deg, transparent 8%, #6b4a33 8% 46%, transparent 46% 54%, #8a5532 54% 92%, transparent 92%), #120c09',
  lightLeak: 'radial-gradient(70% 90% at 70% 30%, #ffcf6e 0, #ff6f61 30%, #2a1b12 70%)',
  chromaPunch: 'radial-gradient(circle at 48% 50%, #ff6f61 0 18%, transparent 19%), radial-gradient(circle at 52% 50%, #59d6ff 0 18%, #2a1b12 19%)',
  gridFlip: 'linear-gradient(90deg, #120c09 2px, transparent 2px) 0 0 / 22px 22px, linear-gradient(0deg, #120c09 2px, #6b4a33 2px) 0 0 / 22px 22px',
  crossBlur: 'radial-gradient(60% 80% at 35% 50%, rgba(255,181,71,.55), transparent 70%), radial-gradient(60% 80% at 70% 50%, rgba(185,166,255,.45), #1a110c 75%)',
  appleZoom: 'radial-gradient(circle at 50% 50%, #ffe1b0 0 10%, #8a5532 30%, #1a110c 70%)',
  lumaReveal: 'linear-gradient(180deg, #fff1d6 0%, #b07a4c 40%, #2a1b12 100%)',
  mistFade: 'radial-gradient(50% 40% at 30% 30%, rgba(255,240,220,.35), transparent 70%), radial-gradient(60% 50% at 70% 70%, rgba(255,240,220,.25), #2a1b12 80%)',
  bokeh: 'radial-gradient(circle at 25% 35%, #ffcf6e 0 9%, transparent 10%), radial-gradient(circle at 65% 60%, #ff9a3d 0 12%, transparent 13%), radial-gradient(circle at 80% 25%, #ffe1b0 0 6%, #2a1b12 7%)',
  morph: 'conic-gradient(from 200deg at 60% 40%, #6b4a33, #3d2a52, #8a5532, #6b4a33)',
  dipBlack: 'linear-gradient(90deg, #6b4a33, #050302 50%, #8a5532)',
  flashWhite: 'linear-gradient(90deg, #6b4a33, #fff6e8 50%, #8a5532)',
  irisSoft: 'radial-gradient(circle at 50% 50%, #ffb547 0 18%, #6b4a33 34%, #1a110c 60%)',
  pushLeft: 'linear-gradient(90deg, #4a3326 0 55%, rgba(0,0,0,.6) 55% 57%, #8a5532 57%)',
  sheetUp: 'linear-gradient(180deg, #2a1b12 0 40%, #120c09 40% 42%, #8a5532 42%)',
  elasticSwipe: 'linear-gradient(90deg, #6b4a33, #8a5532 40%, #ffb547 60%, #6b4a33)',
  prism: 'linear-gradient(90deg, #ff6f61 0 33%, #7fe3b4 33% 66%, #59d6ff 66%)',
  waveReveal: 'radial-gradient(120% 60% at 50% 120%, #ffb547 0 55%, #2a1b12 56%)',
  lightSweep: 'linear-gradient(110deg, #2a1b12 0 42%, #fff1d6 50%, #6b4a33 58%)',
  directionalWarp: 'linear-gradient(135deg, #8a5532 0 45%, #2a1b12 55%)',
  radialSoft: 'conic-gradient(from 0deg, #ffb547 0 35%, #2a1b12 45%)',
  cube3d: 'linear-gradient(100deg, #6b4a33 0 48%, #120c09 48% 52%, #3a2a20 52%)',
  tilt3d: 'linear-gradient(80deg, #120c09 0 15%, #6b4a33 15% 45%, #120c09 45% 55%, #8a5532 55% 85%, #120c09 85%)',
  doorway: 'linear-gradient(90deg, #6b4a33 0 30%, #ffb547 30% 70%, #6b4a33 70%)',
  squircle: 'radial-gradient(closest-side, #ffb547 0 60%, #2a1b12 62%)',
  bubbles: 'radial-gradient(circle, #ffb547 0 40%, #2a1b12 42%) 0 0 / 16px 16px',
  crossZoom: 'radial-gradient(circle at 35% 50%, #fff1d6 0, #ff9a3d 18%, #2a1b12 60%)',
  zoomSpin: 'conic-gradient(from 45deg, #2a1b12, #ffb547, #2a1b12, #8a5532, #2a1b12)',
  swirlSoft: 'conic-gradient(from 0deg at 50% 50%, #3d2a52, #6b4a33, #ffb547, #3d2a52)',
};

function IntervalCustom({ value, active, onChange }: { value: number; active: boolean; onChange: (s: number) => void }) {
  const [h, setH] = useState(Math.floor(value / 3600));
  const [m, setM] = useState(Math.floor((value % 3600) / 60));
  const [s, setS] = useState(value % 60);
  useEffect(() => { setH(Math.floor(value / 3600)); setM(Math.floor((value % 3600) / 60)); setS(value % 60); }, [value]);
  const commit = (hh = h, mm = m, ss = s) => {
    const total = Math.max(5, hh * 3600 + mm * 60 + ss);
    if (total !== value) onChange(total);
  };
  const box = (val: number, set: (n: number) => void, max: number, label: string, which: 'h' | 'm' | 's') => (
    <span className="row" style={{ gap: 4 }}>
      <input className="input" type="number" min={0} max={max} value={val} aria-label={label}
        onChange={(e) => set(Math.max(0, Math.min(max, Number(e.target.value) || 0)))}
        onBlur={() => commit()} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        style={{ borderColor: active ? 'rgba(255,181,71,.5)' : undefined }} />
      <span className="small muted">{which}</span>
    </span>
  );
  return (
    <span className="custom">
      {box(h, setH, 168, 'Horas', 'h')}
      {box(m, setM, 59, 'Minutos', 'm')}
      {box(s, setS, 59, 'Segundos', 's')}
    </span>
  );
}
