import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, MotionConfig } from 'motion/react';
import {
  MonitorSmartphone, Images, Palette, Sparkles, Settings2, Minus, Square, X, PanelBottomClose, Eye, Pause, Play,
  CheckCircle2, AlertTriangle, XCircle, Info, ListTodo, SkipForward, Maximize2, FolderOpen,
} from 'lucide-react';
import { api, StoreCtx, useStore, useStoreValue, useThumb, folderName, type Toast } from './api';
import { MonitorsPage } from './pages/Monitors';
import { GalleryPage } from './pages/Gallery';
import { EditorPage } from './pages/Editor';
import { UpscalePage } from './pages/Upscale';
import { SettingsPage } from './pages/Settings';
import { Btn } from './components/controls';
import { useCountdown } from './components/MonitorStage';
import { ChatGptResult } from './components/ChatGptResult';

type Page = 'monitors' | 'gallery' | 'editor' | 'upscale' | 'settings';

export function App() {
  const store = useStoreValue();
  return (
    <StoreCtx.Provider value={store}>
      <MotionConfig reducedMotion={store.state?.config.global.reduceMotion ? 'always' : 'user'}>
        <Shell />
      </MotionConfig>
    </StoreCtx.Provider>
  );
}

function Shell() {
  const { state, sched, newMonitor } = useStore();
  const [page, setPage] = useState<Page>('monitors');
  const [selected, setSelected] = useState<string | null>(null);
  const [compact, setCompact] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [leaving, setLeaving] = useState<null | 'hide' | 'min'>(null);
  const [peek, setPeek] = useState(false);
  const [editImage, setEditImage] = useState<string | null>(null);

  useEffect(() => {
    return api.on('window', (w: any) => {
      if ('compact' in w) setCompact(!!w.compact);
      if ('maximized' in w) setMaximized(!!w.maximized);
      if (w.shown) setLeaving(null);
    });
  }, []);
  useEffect(() => { if (state) setCompact(state.compact); }, [!!state]);
  useEffect(() => {
    if (!state) return;
    if (!selected || (!state.monitors.some((m) => m.id === selected) && !state.offline.some((o) => o.id === selected))) {
      setSelected(state.monitors[0]?.id || null);
    }
  }, [state, selected]);
  useEffect(() => { if (newMonitor) { setPage('monitors'); setSelected(newMonitor.id); } }, [newMonitor]);

  // Hold "P" (outside text fields) to peek at the wallpaper through the window.
  const opacityRef = useRef(1);
  opacityRef.current = state?.config.global.uiOpacity ?? 1;
  useEffect(() => {
    const isField = (t: EventTarget | null) => t instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(t.tagName);
    const down = (e: KeyboardEvent) => { if (e.key.toLowerCase() === 'p' && !e.repeat && !isField(e.target)) setPeek(true); };
    const up = (e: KeyboardEvent) => { if (e.key.toLowerCase() === 'p') setPeek(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', () => setPeek(false));
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);
  useEffect(() => { api.invoke('win:opacity', peek ? 0.06 : opacityRef.current); }, [peek]);

  const leave = (kind: 'hide' | 'min') => {
    setLeaving(kind);
    setTimeout(() => {
      api.invoke(kind === 'hide' ? 'win:hide' : 'win:minimize');
      setTimeout(() => setLeaving(null), 400);
    }, 220);
  };
  const toggleCompact = () => api.invoke('win:compact', !compact).then((v) => setCompact(!!v));

  if (!state) {
    return <div className="app-shell" style={{ display: 'grid', placeItems: 'center' }}><motion.img src="./logo.png" width={96} animate={{ scale: [0.95, 1.05, 0.95] }} transition={{ repeat: Infinity, duration: 1.6 }} /></div>;
  }

  if (compact) return <><CompactView onExpand={toggleCompact} peek={peek} setPeek={setPeek} /><Toasts /></>;

  const nav: { id: Page; label: string; icon: any; ai?: boolean }[] = [
    { id: 'monitors', label: 'Monitores', icon: MonitorSmartphone },
    { id: 'gallery', label: 'Galeria', icon: Images },
    { id: 'editor', label: 'Editor', icon: Palette, ai: true },
    { id: 'upscale', label: 'Upscale 4K', icon: Sparkles },
    { id: 'settings', label: 'Ajustes', icon: Settings2 },
  ];
  const activeCount = state.monitors.filter((m) => state.config.monitors[m.id]?.folder || state.config.monitors[m.id]?.fixed).length;

  return (
    <motion.div
      className={`app-shell ${maximized ? 'maximized' : ''}`}
      initial={{ opacity: 0, scale: 0.965, y: 10 }}
      animate={leaving ? { opacity: 0, scale: leaving === 'min' ? 0.9 : 0.96, y: leaving === 'min' ? 40 : 8 } : { opacity: 1, scale: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 320, damping: 30 }}
    >
      <div className="titlebar">
        <div className="brand"><img src="./logo.png" alt="" />Chimpanzé Wallpapers</div>
        <div className="spacer" />
        <div className="tools">
          <button className={`tb-btn ${sched?.globalPaused ? 'on' : ''}`} title={sched?.globalPaused ? 'Retomar trocas' : 'Pausar todas as trocas'} onClick={() => api.invoke('scheduler:pause', !sched?.globalPaused)}>
            {sched?.globalPaused ? <Play size={15} /> : <Pause size={15} />}
          </button>
          <button className="tb-btn" title="Espiar o wallpaper (segure, ou segure a tecla P)" onMouseDown={() => setPeek(true)} onMouseUp={() => setPeek(false)} onMouseLeave={() => setPeek(false)}><Eye size={16} /></button>
          <button className="tb-btn" title="Modo compacto" onClick={toggleCompact}><PanelBottomClose size={16} /></button>
          <span className="tb-sep" />
          <button className="tb-btn" title="Minimizar" onClick={() => leave('min')}><Minus size={16} /></button>
          <button className="tb-btn" title={maximized ? 'Restaurar' : 'Maximizar'} onClick={() => api.invoke('win:maximize')}><Square size={13} /></button>
          <button className="tb-btn close" title="Fechar para a bandeja" onClick={() => leave('hide')}><X size={17} /></button>
        </div>
      </div>

      <nav className="nav">
        {nav.map((n) => (
          <motion.button key={n.id} className={`nav-item ${page === n.id ? 'active' : ''}`} onClick={() => setPage(n.id)} whileTap={{ scale: 0.97 }}>
            {page === n.id && <motion.span layoutId="nav-pill" className="pill" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
            <n.icon size={18} />
            <span>{n.label}</span>
            {n.ai && <span className="ai-dot" title="Com IA" />}
          </motion.button>
        ))}
        <div className="nav-foot">
          <div className="nav-status">
            <b>{state.monitors.length}</b> monitor(es) ligado(s), <b>{activeCount}</b> com wallpaper do app.
            {state.offline.length ? <> <b>{state.offline.length}</b> guardado(s) offline.</> : null}
          </div>
        </div>
      </nav>

      <main className="main">
        <AnimatePresence mode="wait">
          <motion.div key={page} style={{ position: 'absolute', inset: 0 }}
            initial={{ opacity: 0, y: 12, filter: 'blur(4px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} exit={{ opacity: 0, y: -8, filter: 'blur(4px)' }}
            transition={{ duration: 0.28, ease: [0.22, 0.8, 0.25, 1] }}>
            {page === 'monitors' && <MonitorsPage selected={selected} setSelected={setSelected} />}
            {page === 'gallery' && <GalleryPage onEdit={(p) => { setEditImage(p); setPage('editor'); }} />}
            {page === 'editor' && <EditorPage initialPath={editImage} clearInitial={() => setEditImage(null)} />}
            {page === 'upscale' && <UpscalePage />}
            {page === 'settings' && <SettingsPage />}
          </motion.div>
        </AnimatePresence>
      </main>

      <Toasts />
      <Jobs />
      <NewMonitorModal />
      <ChatGptResult />
      <AnimatePresence>{peek && <motion.div className="peek-hint" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>Espiando o wallpaper</motion.div>}</AnimatePresence>
    </motion.div>
  );
}

function Toasts() {
  const { toasts, dismiss } = useStore();
  const icon = (t: Toast) => (t.kind === 'ok' ? <CheckCircle2 size={17} /> : t.kind === 'warn' ? <AlertTriangle size={17} /> : t.kind === 'error' ? <XCircle size={17} /> : <Info size={17} />);
  return (
    <div className="toasts">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div key={t.id} layout className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}
            initial={{ opacity: 0, x: 60, scale: 0.9 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: 60, scale: 0.9 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}>
            <span className="ic">{icon(t)}</span>
            <div style={{ minWidth: 0 }}><b>{t.title}</b>{t.message && <span>{t.message}</span>}</div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function Jobs() {
  const { jobs } = useStore();
  const [open, setOpen] = useState(false);
  const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued');
  const running = jobs.find((j) => j.status === 'running');
  if (!jobs.length) return null;
  return (
    <>
      <div className="jobs-fab">
        <Btn className={running ? 'primary' : ''} onClick={() => setOpen((o) => !o)}>
          <ListTodo size={16} /> {active.length ? `${active.length} tarefa(s)` : 'Tarefas'}
          {running && <span style={{ fontVariantNumeric: 'tabular-nums' }}>{Math.round(running.progress * 100)}%</span>}
        </Btn>
      </div>
      <AnimatePresence>
        {open && (
          <motion.div className="jobs-panel" initial={{ opacity: 0, y: 16, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12, scale: 0.97 }} transition={{ type: 'spring', stiffness: 380, damping: 30 }}>
            <div className="row" style={{ marginBottom: 10 }}>
              <b className="grow">Tarefas na GPU</b>
              <Btn className="sm ghost" onClick={() => api.invoke('jobs:clear')}>Limpar concluídas</Btn>
            </div>
            {jobs.slice(0, 30).map((j) => (
              <motion.div key={j.id} className="job" layout>
                <div className="top">
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="t ellipsis">{j.kind === 'upscale' ? 'Upscale: ' : ''}{j.title}</div>
                    <div className="s ellipsis">{j.status === 'error' ? j.error : j.stage}</div>
                  </div>
                  {(j.status === 'running' || j.status === 'queued') && <Btn className="sm icon ghost" title="Cancelar" onClick={() => api.invoke('jobs:cancel', j.id)}><X size={14} /></Btn>}
                  {j.status === 'done' && j.result?.output && <Btn className="sm icon ghost" title="Mostrar no Explorer" onClick={() => api.invoke('shell:reveal', j.result.output)}><FolderOpen size={14} /></Btn>}
                </div>
                {(j.status === 'running' || j.status === 'queued') && <div className="bar"><i style={{ width: `${Math.round(j.progress * 100)}%` }} /></div>}
              </motion.div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function NewMonitorModal() {
  const { newMonitor, clearNewMonitor, state, setMonitor } = useStore();
  if (!state) return null;
  const known = Object.values(state.config.monitors).filter((c) => c.folder && c.id !== newMonitor?.id);
  const choose = async () => {
    if (!newMonitor) return;
    const f = await api.invoke<string | null>('dialog:folder', `Pasta de wallpapers para ${newMonitor.name}`);
    if (f) { await setMonitor(newMonitor.id, { folder: f }); clearNewMonitor(); }
  };
  return (
    <AnimatePresence>
      {newMonitor && (
        <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={clearNewMonitor}>
          <motion.div className="modal" initial={{ scale: 0.9, y: 30, opacity: 0 }} animate={{ scale: 1, y: 0, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 360, damping: 28 }} onClick={(e) => e.stopPropagation()}>
            <motion.div initial={{ rotate: -12, scale: 0.6 }} animate={{ rotate: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 12, delay: 0.1 }}
              style={{ width: 56, height: 56, borderRadius: 16, display: 'grid', placeItems: 'center', background: 'var(--sunset)', color: '#2a1308' }}>
              <MonitorSmartphone size={28} />
            </motion.div>
            <h2>Novo monitor detectado</h2>
            <p><b>{newMonitor.name}</b>, {newMonitor.rect.width}×{newMonitor.rect.height}. Quer colocar wallpapers do app nele?</p>
            <div className="stack" style={{ gap: 8 }}>
              <Btn className="primary" onClick={choose}><FolderOpen size={16} /> Escolher uma pasta</Btn>
              {known.slice(0, 3).map((c) => (
                <Btn key={c.id} onClick={async () => { await setMonitor(newMonitor.id, { folder: c.folder, intervalSec: c.intervalSec, order: c.order, transition: c.transition, fit: c.fit }); clearNewMonitor(); }}>
                  Usar a mesma pasta do {c.alias || c.name} ({folderName(c.folder)})
                </Btn>
              ))}
              <Btn className="ghost" onClick={clearNewMonitor}>Agora não (fica com o wallpaper do Windows)</Btn>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function CompactView({ onExpand, peek, setPeek }: { onExpand: () => void; peek: boolean; setPeek: (v: boolean) => void }) {
  const { state, sched } = useStore();
  if (!state) return null;
  return (
    <motion.div className="compact-shell" initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} transition={{ type: 'spring', stiffness: 380, damping: 30 }}>
      <div className="compact-head">
        <img src="./logo.png" width={22} height={22} style={{ borderRadius: 6 }} alt="" />
        <b style={{ fontFamily: 'var(--display)', fontSize: 12 }}>Chimpanzé</b>
        <div className="tools">
          <button className={`tb-btn ${sched?.globalPaused ? 'on' : ''}`} onClick={() => api.invoke('scheduler:pause', !sched?.globalPaused)} title="Pausar ou retomar">
            {sched?.globalPaused ? <Play size={14} /> : <Pause size={14} />}
          </button>
          <button className="tb-btn" title="Espiar (segure)" onMouseDown={() => setPeek(true)} onMouseUp={() => setPeek(false)} onMouseLeave={() => setPeek(false)}><Eye size={15} /></button>
          <button className="tb-btn" title="Expandir" onClick={onExpand}><Maximize2 size={14} /></button>
          <button className="tb-btn close" title="Fechar para a bandeja" onClick={() => api.invoke('win:hide')}><X size={15} /></button>
        </div>
      </div>
      <div className="compact-list">
        {state.monitors.map((m, i) => <CompactRow key={m.id} id={m.id} index={m.index} name={state.config.monitors[m.id]?.alias || m.name} delay={i * 0.05} />)}
      </div>
    </motion.div>
  );
}

function CompactRow({ id, index, name, delay }: { id: string; index: number; name: string; delay: number }) {
  const { state } = useStore();
  const cfg = state!.config.monitors[id];
  const thumb = useThumb(cfg ? cfg.fixed || cfg.current : null);
  const cd = useCountdown(id);
  return (
    <motion.div className="cm" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay, type: 'spring', stiffness: 400, damping: 30 }}>
      <div className="th">{thumb && <AnimatePresence mode="popLayout"><motion.img key={thumb} src={thumb} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} /></AnimatePresence>}<span className="n">{index}</span></div>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="ellipsis" style={{ fontWeight: 700, fontSize: 12.5 }}>{name}</div>
        <div className="muted small">{cfg?.fixed ? 'Fixado' : cfg?.folder ? (cd ? `Troca em ${cd}` : 'Troca manual') : 'Sem pasta'}</div>
      </div>
      <Btn className="sm icon" disabled={!cfg?.folder} title="Próximo" onClick={() => api.invoke('monitor:next', id).catch(() => {})}><SkipForward size={14} /></Btn>
    </motion.div>
  );
}
