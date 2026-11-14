import { useEffect, useRef, useState } from 'react';
import { Film, Sparkles, BoxSelect, Scissors, Check, EyeOff, SlidersHorizontal, Music2 } from 'lucide-react';
import { useThumb, mediaUrl, useStore, type MediaItem } from '../api';

/** Gallery tile — lazy thumbnail; videos/GIFs play on hover. */
export function Tile({ item, onOpen, current, index, selected, selecting, onToggle, onMenu }: {
  item: MediaItem; onOpen: () => void; current?: boolean; index: number;
  /** Multi-selection (Ctrl/Shift+click, or the round mark). */
  selected?: boolean; selecting?: boolean; onToggle?: (shift: boolean) => void; onMenu?: (x: number, y: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [hover, setHover] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVisible(true); io.disconnect(); } }, { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const thumb = useThumb(visible ? item.edited || item.path : null);
  const animated = item.type !== 'image';
  const { state } = useStore();
  const dimg = state?.config.images?.[item.path.toLowerCase()];
  return (
    // A plain element (not an animated one): a gallery has hundreds of tiles, and one spring +
    // layout tracker per tile made opening the Galeria stall. Entrance and hover are CSS only.
    <div
      ref={ref}
      style={{ ['--i' as any]: Math.min(index, 24) }}
      className={`tile ${selected ? 'sel' : ''} ${selecting ? 'selecting' : ''}`}
      onClick={(e) => { if (onToggle && (e.ctrlKey || e.metaKey || e.shiftKey || selecting)) onToggle(e.shiftKey); else onOpen(); }}
      onContextMenu={(e) => { if (onMenu) { e.preventDefault(); onMenu(e.clientX, e.clientY); } }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}
    >
      {!thumb && <div className="skeleton" />}
      {thumb && !(hover && item.type === 'video') && <img src={item.type === 'gif' && hover ? mediaUrl(item.path) : thumb} alt="" loading="lazy" draggable={false} />}
      {hover && item.type === 'video' && <video src={mediaUrl(item.path)} autoPlay muted loop playsInline />}
      <div className="shade" />
      <div className="badges">
        {current && <span className="badge cur">No ar</span>}
        {item.upscaled && <span className="badge k4"><Sparkles size={10} /> 4K</span>}
        {item.edited && <span className="badge ed">Editado</span>}
        {dimg?.depth === false && <span className="badge d3off" title="Profundidade 3D desligada nesta imagem"><BoxSelect size={10} /> 3D off</span>}
        {dimg?.cut ? <span className="badge cutn" title="Recorte refeito"><Scissors size={10} /> Recorte {dimg.cut}</span> : null}
        {dimg?.look && <span className="badge look" title="Tem ajustes próprios de movimento"><SlidersHorizontal size={10} /> Próprio</span>}
        {!dimg?.music && dimg?.musicCat && <span className="badge look" title="Tem categoria de música"><Music2 size={10} /></span>}
        {dimg?.music && <span className="badge look" title={`Música: ${dimg.music.title}`}><Music2 size={10} /></span>}
        {dimg?.blink === false && <span className="badge d3off" title="Não pisca nesta imagem"><EyeOff size={10} /></span>}
        {animated && <span className="badge anim"><Film size={10} /> {item.type === 'gif' ? 'GIF' : 'Vídeo'}</span>}
      </div>
      {onToggle && <button className="tile-mark" title="Selecionar (Ctrl+clique)" onClick={(e) => { e.stopPropagation(); onToggle(e.shiftKey); }}>{selected && <Check size={13} />}</button>}
      <div className="meta ellipsis">{item.name}</div>
    </div>
  );
}
