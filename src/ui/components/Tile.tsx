import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Film, Sparkles, BoxSelect, Scissors } from 'lucide-react';
import { useThumb, mediaUrl, useStore, type MediaItem } from '../api';

/** Gallery tile — lazy thumbnail; videos/GIFs play on hover. */
export function Tile({ item, onOpen, current, index }: { item: MediaItem; onOpen: () => void; current?: boolean; index: number }) {
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
    <motion.div
      ref={ref}
      className="tile"
      layout
      initial={{ opacity: 0, y: 16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 300, damping: 28, delay: Math.min(index, 24) * 0.018 }}
      whileHover={{ y: -4 }}
      whileTap={{ scale: 0.97 }}
      onClick={onOpen}
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
        {animated && <span className="badge anim"><Film size={10} /> {item.type === 'gif' ? 'GIF' : 'Vídeo'}</span>}
      </div>
      <div className="meta ellipsis">{item.name}</div>
    </motion.div>
  );
}
