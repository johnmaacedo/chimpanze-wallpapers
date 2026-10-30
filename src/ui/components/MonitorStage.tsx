import { motion, AnimatePresence } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Pause, Pin, PowerOff } from 'lucide-react';
import { useStore, useThumb, fmtDuration, type Monitor, type OfflineMonitor, type Rect } from '../api';
import { Ring } from './controls';

type Item = (Monitor & { offline?: false }) | OfflineMonitor;

export function MonitorStage({ selected, onSelect, showOffline = true }: { selected: string | null; onSelect: (id: string) => void; showOffline?: boolean }) {
  const { state } = useStore();
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  if (!state) return null;

  const online: Item[] = state.monitors;
  const offline: Item[] = showOffline ? state.offline.filter((o) => o.rect) : [];
  const all = [...online, ...offline];
  if (!all.length) {
    return <div className="stage" ref={ref}><div className="empty-state" style={{ border: 0 }}>Nenhum monitor detectado ainda.</div></div>;
  }

  // Lay out online monitors with their real arrangement; offline ones to the right.
  const rects = new Map<string, Rect>();
  online.forEach((m) => rects.set(m.id, (m as Monitor).rect));
  if (offline.length) {
    let maxX = Math.max(...online.map((m) => (m as Monitor).rect.x + (m as Monitor).rect.width), 0);
    for (const o of offline) {
      const r = o.rect!;
      rects.set(o.id, { x: maxX + 400, y: 0, width: r.width, height: r.height });
      maxX += 400 + r.width;
    }
  }
  const xs = [...rects.values()];
  const minX = Math.min(...xs.map((r) => r.x)); const minY = Math.min(...xs.map((r) => r.y));
  const maxX = Math.max(...xs.map((r) => r.x + r.width)); const maxY = Math.max(...xs.map((r) => r.y + r.height));
  const gap = 18;
  const avail = Math.max(300, width - 52);
  const scale = Math.min(avail / (maxX - minX), 300 / (maxY - minY));
  const W = (maxX - minX) * scale; const H = (maxY - minY) * scale;

  return (
    <div className="stage" ref={ref}>
      <div className="stage-inner" style={{ width: W, height: H }}>
        <AnimatePresence>
          {all.map((m, i) => {
            const r = rects.get(m.id)!;
            const box = { left: (r.x - minX) * scale + gap / 2, top: (r.y - minY) * scale + gap / 2, width: r.width * scale - gap, height: r.height * scale - gap };
            return (
              <motion.div
                key={m.id}
                layout
                className={`screen ${selected === m.id ? 'selected' : ''} ${m.offline ? 'offline' : ''}`}
                style={{ ...box, cursor: 'pointer' }}
                initial={{ opacity: 0, y: 24, scale: 0.92 }}
                animate={{ opacity: m.offline ? 0.45 : 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.85, filter: 'blur(6px)' }}
                transition={{ type: 'spring', stiffness: 260, damping: 26, delay: i * 0.05 }}
                whileHover={{ y: -4 }}
                onClick={() => onSelect(m.id)}
              >
                <ScreenBody m={m} />
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}

function ScreenBody({ m }: { m: Item }) {
  const { state, sched } = useStore();
  const cfg = state!.config.monitors[m.id];
  const current = cfg && (cfg.fixed || cfg.current);
  const thumb = useThumb(current || null);
  const s = sched && sched.monitors[m.id];
  const [, force] = useState(0);
  useEffect(() => { const t = setInterval(() => force((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  const remaining = s && s.nextAt ? Math.max(0, (s.nextAt - Date.now()) / 1000) : 0;
  const total = cfg ? Math.max(5, cfg.intervalSec) : 1;
  const rect = m.offline ? m.rect : (m as Monitor).rect;

  return (
    <>
      <div className="bezel">
        <AnimatePresence mode="popLayout">
          {thumb ? (
            <motion.img key={thumb} src={thumb} alt="" initial={{ opacity: 0, scale: 1.08 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.7, ease: [0.22, 0.8, 0.25, 1] }} />
          ) : (
            <motion.div key="empty" className="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              {m.offline ? 'Desconectado' : cfg && cfg.folder ? 'Carregando…' : 'Escolha uma pasta'}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <div className="tag">
        <span className="num">{m.offline ? <PowerOff size={13} /> : (m as Monitor).index}</span>
        {!m.offline && (m as Monitor).primary && <span className="chip">Principal</span>}
        {cfg && cfg.fixed && <span className="chip"><Pin size={11} /> Fixo</span>}
        {s && s.occluded && <span className="chip"><Pause size={11} /> Pausado</span>}
      </div>
      <div className="foot">
        <div style={{ minWidth: 0 }}>
          <div className="name ellipsis">{(cfg && cfg.alias) || m.name}</div>
          {rect && <div className="res">{rect.width}×{rect.height}{!m.offline && (m as Monitor).refreshRate ? `  ${(m as Monitor).refreshRate} Hz` : ''}</div>}
        </div>
        {!m.offline && cfg && cfg.auto && !cfg.fixed && cfg.folder && s && s.nextAt > 0 && (
          <Ring fraction={1 - remaining / total} label={remaining >= 3600 ? `${Math.floor(remaining / 3600)}h` : remaining >= 60 ? `${Math.floor(remaining / 60)}m` : `${Math.ceil(remaining)}s`} />
        )}
      </div>
    </>
  );
}

export function useCountdown(id: string) {
  const { sched } = useStore();
  const [, force] = useState(0);
  useEffect(() => { const t = setInterval(() => force((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  const s = sched && sched.monitors[id];
  if (!s || !s.nextAt) return null;
  return fmtDuration((s.nextAt - Date.now()) / 1000);
}
