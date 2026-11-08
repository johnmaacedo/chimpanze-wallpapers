import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Check, CheckCheck, Images, Rocket, Sparkles, X } from 'lucide-react';
import { api, useStore, useThumb, folderName, fileName, type MediaItem } from '../api';
import { Btn, Segmented } from './controls';

/**
 * Picks pictures from the app's own wallpaper folders (the same ones the
 * Gallery shows). Calls onPick with the chosen paths; nothing starts here.
 */
/** Pictures already in the app. `single`: one click picks one picture (Editor). */
export function GalleryPicker({ onPick, onClose, single, title, hint }: { onPick: (paths: string[]) => void; onClose: () => void; single?: boolean; title?: string; hint?: string }) {
  const { state, mediaVersion } = useStore();
  const folders = useMemo(() => {
    if (!state) return [] as { folder: string; label: string; monitors: number[] }[];
    const map = new Map<string, number[]>();
    for (const m of state.monitors) {
      const f = state.config.monitors[m.id]?.folder;
      if (f) map.set(f, [...(map.get(f) || []), m.index]);
    }
    for (const c of Object.values(state.config.monitors)) if (c.folder && !map.has(c.folder)) map.set(c.folder, []);
    return [...map.entries()].map(([folder, monitors]) => ({ folder, label: folderName(folder), monitors }));
  }, [state]);
  const [folder, setFolder] = useState<string | null>(folders[0]?.folder || null);
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [filter, setFilter] = useState<'nok' | 'all'>(single ? 'all' : 'nok');
  const [sel, setSel] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!folder) return;
    let alive = true;
    setItems(null);
    api.invoke<MediaItem[]>('media:list', folder, {}).then((xs) => alive && setItems(xs.filter((i) => i.type === 'image'))).catch(() => alive && setItems([]));
    return () => { alive = false; };
  }, [folder, mediaVersion]);

  const shown = (items || []).filter((i) => filter === 'all' || !i.upscaled);
  const toggle = (p: string) => setSel((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  const allOn = shown.length > 0 && shown.every((i) => sel.has(i.path));
  const selectAll = () => setSel((s) => { const n = new Set(s); if (allOn) shown.forEach((i) => n.delete(i.path)); else shown.forEach((i) => n.add(i.path)); return n; });

  return (
    <Modal onClose={onClose} wide>
      <div className="modal-head">
        <div>
          <h2><Images size={18} /> {title || 'Escolher da galeria'}</h2>
          <p className="muted small">{hint || (single ? 'Os wallpapers que já estão no app. Clique em um.' : 'Os wallpapers que já estão no app. Marque quantos quiser.')}</p>
        </div>
        <button className="modal-x" onClick={onClose} aria-label="Fechar"><X size={18} /></button>
      </div>
      {!folders.length ? (
        <div className="empty-state" style={{ margin: 18 }}>
          <Images size={32} /><h3>Nenhuma pasta no app ainda</h3><p>Escolha a pasta de um monitor na página Monitores, ou use “Do computador”.</p>
        </div>
      ) : (
        <>
          <div className="picker-bar">
            <div className="folder-tabs">
              {folders.map((f) => (
                <button key={f.folder} className={`folder-tab ${folder === f.folder ? 'on' : ''}`} onClick={() => setFolder(f.folder)} title={f.folder}>
                  {f.monitors.map((n) => <span key={n} className="n">{n}</span>)}
                  {f.label}
                </button>
              ))}
            </div>
            <div className="grow" />
            {!single && <Segmented value={filter} onChange={setFilter} options={[{ value: 'nok', label: 'Sem 4K' }, { value: 'all', label: 'Todas' }]} />}
            {!single && <Btn className="sm" onClick={selectAll} disabled={!shown.length}><CheckCheck size={14} /> {allOn ? 'Desmarcar' : 'Marcar'} todas</Btn>}
          </div>
          <div className="pick-grid">
            {items === null && Array.from({ length: 12 }).map((_, i) => <div key={i} className="pick-tile"><div className="skeleton" /></div>)}
            {items !== null && !shown.length && <div className="muted" style={{ gridColumn: '1/-1', padding: 20 }}>{items.length ? 'Todas as imagens desta pasta já têm versão 4K. Use “Todas” para refazer.' : 'Esta pasta não tem imagens.'}</div>}
            {shown.map((it) => <PickTile key={it.path} item={it} on={sel.has(it.path)} onClick={() => (single ? onPick([it.path]) : toggle(it.path))} />)}
          </div>
        </>
      )}
      {!single && <div className="modal-foot">
        <span className="muted small">{sel.size ? `${sel.size} imagem(ns) marcada(s)` : 'Nenhuma imagem marcada'}</span>
        <div className="row" style={{ gap: 8 }}>
          <Btn className="ghost" onClick={onClose}>Cancelar</Btn>
          <Btn className="primary" disabled={!sel.size} onClick={() => onPick([...sel])}>Continuar</Btn>
        </div>
      </div>}
    </Modal>
  );
}

function PickTile({ item, on, onClick }: { item: MediaItem; on: boolean; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVisible(true); io.disconnect(); } }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const thumb = useThumb(visible ? item.path : null);
  return (
    <button ref={ref} className={`pick-tile ${on ? 'on' : ''}`} onClick={onClick} title={item.name}>
      {thumb ? <img src={thumb} alt="" /> : <div className="skeleton" />}
      {item.upscaled && <span className="badge4k">4K</span>}
      <span className="check">{on && <Check size={14} strokeWidth={3} />}</span>
      <span className="nm ellipsis">{item.name}</span>
    </button>
  );
}

/** Last step before any upscale: what will run, with which settings. */
export function UpscaleConfirm({ files, onConfirm, onClose }: { files: string[]; onConfirm: () => void; onClose: () => void }) {
  const { state } = useStore();
  const u = state!.config.global.upscale;
  const mode = ({ auto: 'Detectar sozinho', anime: 'Anime', photo: 'Foto realista', art: 'Arte digital' } as Record<string, string>)[u.mode] || u.mode;
  const target = ({ '4k': '4K (3840×2160)', '5k': '5K', '8k': '8K', monitor: 'Maior monitor', x2: '2x', x4: '4x' } as Record<string, string>)[u.target] || u.target;
  const fmt = ({ png: 'PNG sem perdas', jpg: 'JPG 95', webp: 'WebP 95' } as Record<string, string>)[u.format] || u.format;
  const first = useThumb(files[0]);
  return (
    <Modal onClose={onClose}>
      <div className="modal-head">
        <div>
          <h2><Sparkles size={18} /> Começar o upscale?</h2>
          <p className="muted small">{files.length === 1 ? fileName(files[0]) : `${files.length} imagens, uma por vez na GPU.`}</p>
        </div>
        <button className="modal-x" onClick={onClose} aria-label="Fechar"><X size={18} /></button>
      </div>
      <div className="confirm-body">
        <div className="confirm-thumb">
          {first ? <img src={first} alt="" /> : <div className="skeleton" />}
          {files.length > 1 && <span className="more">+{files.length - 1}</span>}
        </div>
        <dl className="confirm-list">
          <div><dt>Tipo de imagem</dt><dd>{mode}</dd></div>
          <div><dt>Tamanho final</dt><dd>{target}</dd></div>
          <div><dt>Formato</dt><dd>{fmt}</dd></div>
          <div><dt>Já grandes</dt><dd>{u.skipIfLarger ? 'Puladas' : 'Refeitas'}</dd></div>
        </dl>
      </div>
      <p className="muted small" style={{ margin: '0 22px 6px' }}>O original nunca é alterado: a versão nova vai para a subpasta _4K. Dá para cancelar a qualquer momento na fila.</p>
      <div className="modal-foot">
        <span />
        <div className="row" style={{ gap: 8 }}>
          <Btn className="ghost" onClick={onClose}>Cancelar</Btn>
          <Btn className="primary" onClick={onConfirm}><Rocket size={15} /> Iniciar upscale</Btn>
        </div>
      </div>
    </Modal>
  );
}

export function Modal({ children, onClose, wide = false }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <motion.div className="modal-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <motion.div className={`modal ${wide ? 'wide' : ''}`} initial={{ opacity: 0, y: 24, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12, scale: 0.98 }} transition={{ type: 'spring', stiffness: 380, damping: 32 }}>
        {children}
      </motion.div>
    </motion.div>
  );
}
