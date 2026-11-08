import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ImagePlus, Undo2, Redo2, Eye, Save, SlidersHorizontal, Crop, Eraser, MessageSquare, WandSparkles, Sparkles, RefreshCcw,
  Bookmark, FolderCog, RotateCw, SquareCenterlineDashedHorizontal, SquareCenterlineDashedVertical, Check, X, Copy, FolderOpen,
  MonitorUp, ZoomIn, ZoomOut, Maximize, Download, Layers, Images, Undo, PaintBucket, Expand, TriangleAlert,
} from 'lucide-react';
import { api, useStore, mediaUrl, fileName, type MediaItem } from '../api';
import { Btn, Segmented } from '../components/controls';
import { GalleryPicker } from '../components/UpscalePicker';
import { PasteLayerBox, PastePanel, bakeLayer, initialLayer, type Layer } from '../editor/PasteLayer';
import { PAINT_CSS, defaultOpts, loadPix, toPng, type PasteOpts } from '../editor/composite';
import { EditorGL, defaultAdjust, clone, autoAdjust, curveAt, CURVE_X, LOOKS, HSL_NAMES, HSL_COLORS, type Adjust, type Crop as CropRect } from '../editor/gl';

type Tool = 'adjust' | 'crop' | 'erase' | 'expand' | 'chatgpt' | 'paste';
type CgMode = 'remove' | 'enhance' | 'custom';
/** Who makes the expansion: the local AI (FLUX Fill on the GPU) or the ChatGPT app. */
type ExpEngine = 'local' | 'chatgpt';
interface LocalAiStatus {
  installed: boolean; installing: boolean; running: boolean; busy: boolean;
  progress?: number; stage?: string; error?: string; sizeGb?: number; missing?: string[];
}
/** One undo step: the working file plus the adjustments on top of it. */
interface Snapshot { base: string | null; adj: Adjust }
/** Brush stroke in normalised image coordinates; r = radius relative to the width. */
interface Stroke { pts: [number, number][]; r: number; erase?: boolean }

const NO_CROP: CropRect = { x: 0, y: 0, w: 1, h: 1 };
const clampTo = (v: number, max: number) => Math.max(0, Math.min(max, v));

export function EditorPage({ initialPath, clearInitial }: { initialPath: string | null; clearInitial: () => void }) {
  const { state, toast } = useStore();
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<EditorGL | null>(null);
  /** The original picture (what gets saved as `_Editado/<name>`). */
  const [source, setSource] = useState<string | null>(null);
  /** The file being worked on: 4K version, eraser or upscale results. */
  const [base, setBase] = useState<string | null>(null);
  const [adj, setAdj] = useState<Adjust>(defaultAdjust());
  const [undo, setUndo] = useState<Snapshot[]>([]);
  const [redo, setRedo] = useState<Snapshot[]>([]);
  const [tool, setTool] = useState<Tool>('adjust');
  const [showBefore, setShowBefore] = useState(false);
  const [busy, setBusy] = useState('');
  const [loaded, setLoaded] = useState(0);
  const [stage, setStage] = useState({ w: 800, h: 450 });
  const [brush, setBrush] = useState(40);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [cropDraft, setCropDraft] = useState<CropRect>(adj.crop);
  const [cropAspect, setCropAspectState] = useState<number | null>(null);
  const [expandAspect, setExpandAspect] = useState(16 / 9);
  const [expEngine, setExpEngineState] = useState<ExpEngine>(() => {
    try { return localStorage.getItem('cw.expEngine') === 'chatgpt' ? 'chatgpt' : 'local'; } catch (_) { return 'local'; }
  });
  const setExpEngine = (e: ExpEngine) => { setExpEngineState(e); try { localStorage.setItem('cw.expEngine', e); } catch (_) { /* ignore */ } };
  const [expPrompt, setExpPrompt] = useState('');
  const [expPromptEdited, setExpPromptEdited] = useState(false);
  /** The working picture has "Pintar" paint on it (changes what the ChatGPT request says). */
  const [hasPaint, setHasPaint] = useState(false);
  const [localAi, setLocalAi] = useState<LocalAiStatus | null>(null);
  const [sceneHint, setSceneHint] = useState('');
  const [localQuality, setLocalQuality] = useState<'fast' | 'best'>('best');
  const [cgMode, setCgMode] = useState<CgMode>('remove');
  const [removeWhat, setRemoveWhat] = useState('');
  const [customEdit, setCustomEdit] = useState('');
  const [prompt, setPrompt] = useState('');
  const [promptEdited, setPromptEdited] = useState(false);
  const [cgStatus, setCgStatus] = useState<{ waiting: boolean; stage?: string; installed?: boolean }>({ waiting: false });
  const [sentImage, setSentImage] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [format, setFormat] = useState<'png' | 'jpg'>('png');
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  /** "Colar imagem": the picture placed on top, waiting for Aplicar. */
  const [layer, setLayer] = useState<Layer | null>(null);
  const [layerAlpha, setLayerAlpha] = useState(1);
  const [pasteOpts, setPasteOpts] = useState<PasteOpts>(defaultOpts());
  const [pasteMode, setPasteMode] = useState<'move' | 'distort'>('move');
  const [pasteView, setPasteView] = useState<'box' | 'preview' | 'diff'>('box');
  const [showMask, setShowMask] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [picker, setPicker] = useState<null | 'open' | 'layer'>(null);
  /** "Pintar": strokes of solid paint (hide parts before sending to ChatGPT). Size in picture px. */
  const [paint, setPaint] = useState<Stroke[]>([]);
  const [paintSize, setPaintSize] = useState(120);
  const [paintErase, setPaintErase] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  /** The "Pintar" brush is on in Expandir when ChatGPT makes the expansion (it must not see some parts). */
  const painting = tool === 'expand' && expEngine === 'chatgpt';

  useEffect(() => {
    if (!canvasRef.current) return;
    try { glRef.current = new EditorGL(canvasRef.current); } catch (err: any) { toast({ kind: 'error', title: 'Editor indisponível', message: err.message }); }
    return () => { glRef.current?.destroy(); glRef.current = null; };
  }, []);
  useEffect(() => { if (initialPath) { open(initialPath); clearInitial(); } }, [initialPath]);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setStage({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const open = async (file: string) => {
    // The 4K version (if any) is the better starting point.
    const best = await api.invoke<string | null>('editor:bestBase', file).catch(() => null);
    setSource(file);
    await loadBase(best || file);
    setAdj(defaultAdjust()); setUndo([]); setRedo([]); setStrokes([]); setPaint([]); setTool('adjust'); setLayer(null); setHasPaint(false);
  };
  const loadBase = async (file: string) => {
    const gl = glRef.current;
    if (!gl) return;
    setBusy('Carregando…');
    try {
      await gl.load(mediaUrl(file));
      setBase(file);
      setLoaded((n) => n + 1);
    } catch (err: any) {
      toast({ kind: 'error', title: 'Não consegui abrir a imagem', message: err.message });
    } finally { setBusy(''); }
  };

  // Crop and eraser work on the whole (unrotated, for the eraser) image.
  const viewAdj = useMemo(() => {
    if (tool !== 'crop' && tool !== 'erase' && tool !== 'paste' && !painting) return adj;
    const a = clone(adj);
    a.crop = { ...NO_CROP };
    if (tool === 'erase' || tool === 'paste' || painting) { a.rotate = 0; a.flipX = false; a.flipY = false; }
    return a;
  }, [adj, tool]);

  // Size of the preview on screen (fitted into the stage).
  const view = useMemo(() => {
    const gl = glRef.current;
    if (!gl || !gl.width) return { w: 0, h: 0, scale: 1, ow: 0, oh: 0 };
    const out = gl.outputSize(viewAdj);
    const s = Math.min((stage.w - 24) / out.w, (stage.h - 24) / out.h, 1);
    return { w: Math.max(1, Math.round(out.w * s)), h: Math.max(1, Math.round(out.h * s)), scale: s, ow: out.w, oh: out.h };
  }, [stage, viewAdj, loaded]);

  useEffect(() => {
    const gl = glRef.current; const cv = canvasRef.current;
    if (!gl || !cv || !view.w) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // When zoomed in, render more pixels (up to the real resolution) so it stays sharp.
    const maxZoom = view.ow ? Math.max(1, view.ow / (view.w * dpr)) : 1;
    const z = Math.min(zoom, maxZoom, 8192 / Math.max(1, view.w * dpr));
    const w = Math.round(view.w * dpr * z); const h = Math.round(view.h * dpr * z);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const raf = requestAnimationFrame(() => gl.draw(viewAdj, w, h, showBefore, Math.max(1, 1 / (view.scale * dpr * z))));
    return () => cancelAnimationFrame(raf);
  }, [viewAdj, view, showBefore, loaded, zoom]);

  /** Records an undo step, then applies `next` (and optionally switches the working file). */
  const commit = useCallback((next: Adjust, nextBase?: string) => {
    if (!base) return;
    setUndo((u) => [...u.slice(-40), { base, adj: clone(adj) }]);
    setRedo([]);
    setAdj(next);
    if (nextBase && nextBase !== base) loadBase(nextBase);
  }, [adj, base]);

  // Sliders: one undo step per drag (changes less than 400 ms apart are merged).
  const burstTimer = useRef(0);
  const burstStart = useRef<Adjust | null>(null);
  const live = (mutate: (a: Adjust) => void) => {
    if (!burstStart.current) {
      burstStart.current = clone(adj);
      setUndo((u) => [...u.slice(-40), { base, adj: clone(adj) }]);
      setRedo([]);
    }
    const a = clone(adj);
    mutate(a);
    setAdj(a);
    window.clearTimeout(burstTimer.current);
    burstTimer.current = window.setTimeout(() => { burstStart.current = null; }, 400);
  };
  const doUndo = () => {
    const last = undo[undo.length - 1];
    if (!last) return;
    setRedo((r) => [{ base, adj: clone(adj) }, ...r]);
    setUndo((u) => u.slice(0, -1));
    setAdj(last.adj);
    if (last.base !== base && last.base) loadBase(last.base);
  };
  const doRedo = () => {
    const next = redo[0];
    if (!next) return;
    setUndo((u) => [...u, { base, adj: clone(adj) }]);
    setRedo((r) => r.slice(1));
    setAdj(next.adj);
    if (next.base !== base && next.base) loadBase(next.base);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && painting && paint.length && !e.shiftKey) { e.preventDefault(); setPaint((p) => p.slice(0, -1)); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); }
      if (e.key === '\\' && !(e.target instanceof HTMLInputElement)) setShowBefore((v) => !v);
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && base && !typing) { e.preventDefault(); importLayerClipboard(); }
      if (tool === 'paste' && layer && !typing) {
        const gl = glRef.current;
        const step = e.shiftKey ? 10 : 1;
        const d = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, number[]>)[e.key];
        if (d && gl) { e.preventDefault(); setLayer({ ...layer, cx: layer.cx + d[0] / gl.width, cy: layer.cy + d[1] / gl.height }); }
        if (e.key === 'Enter') { e.preventDefault(); applyLayer(); }
        if (e.key === 'Escape') { e.preventDefault(); setLayer(null); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    return api.on('chatgpt:status', (st) => setCgStatus((s) => ({ ...s, ...st })));
  }, []);
  // Checked each time the ChatGPT tab opens, so installing the app is noticed without a restart.
  useEffect(() => {
    if (tool === 'chatgpt' || tool === 'expand') api.invoke('chatgpt:status').then(setCgStatus).catch(() => {});
  }, [tool]);

  // --- Requests to ChatGPT ---------------------------------------------------
  const aspectLabel = useMemo(() => {
    const mon = state?.monitors.find((m) => Math.abs(m.rect.width / m.rect.height - expandAspect) < 0.001);
    return ({ '1.778': '16:9', '2.333': '21:9', '3.556': '32:9', '0.563': '9:16' } as Record<string, string>)[expandAspect.toFixed(3)]
      || (mon ? `${mon.rect.width}:${mon.rect.height}` : expandAspect.toFixed(2) + ':1');
  }, [expandAspect, state?.monitors]);
  /** Current picture's proportion (after crop/rotation) and where the expansion adds scenery. */
  const imgAspect = (() => { const g = glRef.current; if (!g || !g.width) return 0; const o = g.outputSize(adj); return o.w / o.h; })();
  const expandSides = imgAspect && expandAspect < imgAspect ? 'em cima e embaixo' : 'à esquerda e à direita';
  const alreadyThere = !!imgAspect && Math.abs(imgAspect - expandAspect) / expandAspect < 0.02;
  /**
   * The expansion request, written for how the app works: ChatGPT only adds scenery; the app puts
   * the untouched original back afterwards (so it must keep scale/position, and the blue paint is
   * only a placeholder that must not spread into the new areas).
   */
  const autoExpandPrompt = useMemo(() => {
    const lines = [
      `Expanda esta imagem para o formato ${aspectLabel} (${expandAspect >= 1 ? 'paisagem' : 'retrato'}), para virar papel de parede, acrescentando cenário ${expandSides}.`,
      '',
      'Regras importantes:',
      '1. Não mexa no que já existe: a imagem atual tem que continuar inteira, no mesmo tamanho, na mesma posição (centralizada) e com o mesmo enquadramento. Não aproxime, não afaste, não corte, não gire, não mude a câmera e não redesenhe nada dela.',
      `2. Só crie as partes novas ${expandSides}, continuando o ambiente de forma natural e coerente: mesma perspectiva e linhas de fuga, mesma altura do horizonte, mesma luz (direção, cor e intensidade), mesmas sombras, mesmas cores, mesmo desfoque de fundo, mesma textura e granulado, e o mesmo estilo visual (render 3D, anime, foto ou pintura, igual ao da imagem). Móveis, paredes, chão e objetos cortados na borda devem continuar com o formato certo.`,
    ];
    if (hasPaint) lines.push('3. As áreas pintadas de azul liso são marcações minhas: deixe-as exatamente como estão, em azul liso, sem desenhar nada dentro. Não estenda o azul para as partes novas. Onde o azul encosta na borda, continue nas partes novas apenas o cenário que estaria atrás (parede, móveis, cama, chão), sem pessoas e sem partes de corpo.');
    lines.push(`${hasPaint ? '4' : '3'}. Não adicione pessoas, animais, textos, logotipos, marcas d'água, molduras, bordas, vinhetas nem faixas pretas.`);
    lines.push('', `Entregue uma única imagem, exatamente na proporção ${aspectLabel}, na maior resolução possível, sem explicações.`);
    return lines.join('\n');
  }, [aspectLabel, expandAspect, expandSides, hasPaint]);
  useEffect(() => { if (!expPromptEdited) setExpPrompt(autoExpandPrompt); }, [autoExpandPrompt, expPromptEdited]);
  const autoPrompt = useMemo(() => {
    const keep = "Mantenha todo o resto exatamente igual: pessoas, rostos, corpos, roupas, cabelo, cores, luz, sombras, estilo e enquadramento. Não adicione texto, marca d'água, molduras nem pessoas novas.";
    if (cgMode === 'remove') return `Remova desta imagem: ${removeWhat.trim() || '[descreva o que remover]'}.\nReconstrua o lugar de forma natural, como se aquilo nunca tivesse existido: continue o fundo, as linhas, as texturas e a iluminação ao redor.\n${keep}\nEntregue a imagem com a mesma proporção e o mesmo enquadramento, na maior resolução possível.`;
    if (cgMode === 'enhance') return 'Melhore esta imagem para usar como papel de parede: mais nitidez e definição nos detalhes, cores e iluminação equilibradas, sem ruído, granulado excessivo, serrilhado ou artefatos de compressão.\nNão mude o conteúdo: mesmas pessoas, mesmos rostos e expressões, mesmas roupas, mesmo cenário e mesmo enquadramento.\nEntregue a imagem com a mesma proporção, na maior resolução possível.';
    return `${customEdit.trim() || '[descreva a edição]'}\n${keep}\nEntregue a imagem com a mesma proporção, na maior resolução possível.`;
  }, [cgMode, removeWhat, customEdit]);
  useEffect(() => { if (!promptEdited) setPrompt(autoPrompt); }, [autoPrompt, promptEdited]);

  const exportTemp = async () => {
    const bytes = await glRef.current!.exportPng(adj);
    return api.invoke<string>('editor:writeTemp', bytes);
  };
  /** `expand`: the Expandir flow (its request and proportion); otherwise the "Editar com IA" tab. */
  const sendToChatGpt = async (expand: boolean) => {
    if (!base || !source) return;
    if (paint.length) { toast({ kind: 'warn', title: 'Falta aplicar a pintura', message: 'Clique em "Aplicar pintura" antes de enviar (senão o ChatGPT vê a imagem sem ela).' }); return; }
    setBusy('Preparando a imagem…');
    try {
      const file = await exportTemp();
      setSentImage(file);
      setBusy('');
      const r = await api.invoke('chatgpt:send', {
        image: file, source, prompt: expand ? expPrompt : prompt,
        aspect: expand ? expandAspect : 0,
        label: expand ? `Expandir ${aspectLabel}` : cgMode === 'remove' ? 'Remover objeto' : cgMode === 'enhance' ? 'Melhorar' : 'Edição',
      });
      if (r && r.notInstalled) {
        setCgStatus((s) => ({ ...s, installed: false }));
        toast({ kind: 'error', title: 'ChatGPT não instalado', message: 'Instale o aplicativo do ChatGPT para usar esta função.' });
      } else if (r && r.auto === false && r.reason === 'focus') {
        toast({ kind: 'info', title: 'Cole manualmente no ChatGPT', message: 'A janela do ChatGPT não ficou em primeiro plano. Use os botões Copiar imagem / Copiar pedido.' });
      }
    } catch (err: any) {
      toast({ kind: 'error', title: 'ChatGPT', message: err.message });
    } finally { setBusy(''); }
  };
  const pickChatGptFile = async (expand: boolean) => {
    const r = await api.invoke('chatgpt:pickFile');
    if (r && source) window.dispatchEvent(new CustomEvent('chatgpt-manual', { detail: { ...r, source, aspect: expand ? expandAspect : 0, label: expand ? `Expandir ${aspectLabel}` : '' } }));
  };

  // --- Local AI expansion (FLUX Fill on the GPU, through the app's own ComfyUI) --------------
  useEffect(() => api.on('localai:status', (st: LocalAiStatus) => setLocalAi(st)), []);
  useEffect(() => { if (tool === 'expand') api.invoke<LocalAiStatus>('localai:status').then(setLocalAi).catch(() => {}); }, [tool]);
  const installLocal = async () => {
    try { await api.invoke('localai:install'); } catch (err: any) {
      toast({ kind: 'error', title: 'Não consegui preparar a IA local', message: String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
    }
  };
  const expandLocal = async () => {
    if (!base || !source) return;
    if (alreadyThere) { toast({ kind: 'info', title: 'Já está nessa proporção', message: `A imagem já é ${aspectLabel}. Escolha outro formato.` }); return; }
    setBusy('Preparando a imagem…');
    try {
      const file = await exportTemp();
      setBusy('');
      const r = await api.invoke<{ file: string; width: number; height: number; place: { x: number; y: number; w: number; h: number }; warning: string }>('localai:expand', { image: file, aspect: expandAspect, quality: localQuality, hint: sceneHint.trim() });
      // `original`: the exact picture that was expanded (with crop/adjustments), joined back 1:1 at `place`.
      window.dispatchEvent(new CustomEvent('chatgpt-manual', { detail: { ...r, via: 'local', source, original: file, aspect: expandAspect, label: `Expandir ${aspectLabel}` } }));
    } catch (err: any) {
      const msg = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      if (!/cancelad/i.test(msg)) toast({ kind: 'error', title: 'A IA local não conseguiu expandir', message: msg });
    } finally { setBusy(''); }
  };

  // --- Zoom / pan of the preview --------------------------------------------
  const zoomAt = (z: number, cx?: number, cy?: number) => {
    z = Math.max(1, Math.min(12, z));
    const el = stageRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = (cx ?? r.left + r.width / 2) - (r.left + r.width / 2);
    const dy = (cy ?? r.top + r.height / 2) - (r.top + r.height / 2);
    const f = z / zoom;
    setPan((p) => (z === 1 ? { x: 0, y: 0 } : { x: dx - (dx - p.x) * f, y: dy - (dy - p.y) * f }));
    setZoom(z);
  };
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, [base, tool]);
  const panDrag = useRef<{ x: number; y: number; p: { x: number; y: number } } | null>(null);
  const canPan = zoom > 1 && (tool === 'adjust' || tool === 'chatgpt' || tool === 'paste');

  // --- Actions ---------------------------------------------------------------
  const browse = async () => {
    const [f] = await api.invoke<string[]>('dialog:files', { title: 'Imagem para editar' });
    if (f) open(f);
  };
  // --- Colar imagem ------------------------------------------------------------
  const importLayer = async (file: string) => {
    const gl = glRef.current;
    if (!gl || !gl.width) return;
    const url = mediaUrl(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const l = initialLayer(file, url, img.naturalWidth, img.naturalHeight, gl.width, gl.height);
      setLayer(l);
      setLayerAlpha(1);
      setTool('paste');
      autoFit(l, true);
    } catch (err: any) {
      toast({ kind: 'error', title: 'Não consegui abrir a imagem', message: err.message || String(err) });
    }
  };
  const importLayerFile = async () => {
    const [f] = await api.invoke<string[]>('dialog:files', { title: 'Imagem para colar por cima' });
    if (f) importLayer(f);
  };
  const importLayerClipboard = async () => {
    const f = await api.invoke<string | null>('editor:clipboardImage');
    if (f) importLayer(f);
    else toast({ kind: 'info', title: 'Nada copiado', message: 'Copie uma imagem (no ChatGPT, no navegador ou no Explorer) e tente de novo.' });
  };
  /** Encaixe automático: scale, position, stretch (and the view switches to the result). */
  const autoFit = async (l: Layer | null = layer, quiet = false) => {
    if (!l || !base) return;
    setAutoBusy(true);
    try {
      const r = await api.invoke<{ score: number; w: number; sy: number; cx: number; cy: number }>('editor:autoAlign', base, l.path);
      if (r.score < 0.55) {
        if (!quiet) toast({ kind: 'warn', title: 'Não achei um encaixe seguro', message: 'As imagens parecem diferentes demais. Ajuste à mão (Diferença ajuda a ver).' });
        return;
      }
      setLayer((cur) => (cur && cur.path === l.path ? { ...cur, w: r.w, sy: r.sy, cx: r.cx, cy: r.cy, rot: 0, corners: [[0, 0], [0, 0], [0, 0], [0, 0]] } : cur));
      setPasteView('preview');
      setPasteOpts((o) => ({ ...o, mode: 'all', match: 1, feather: Math.max(o.feather, 24) }));
      toast({ kind: 'ok', title: 'Encaixado', message: `Confiança ${Math.round(r.score * 100)}%. Confira em "Diferença" e ajuste à mão se precisar.` });
    } catch (err: any) {
      if (!quiet) toast({ kind: 'error', title: 'O encaixe automático falhou', message: err.message });
    } finally { setAutoBusy(false); }
  };
  /** "Juntar sem marcas": the pasted picture is the original, the open one an expansion of it (merge-core.js). */
  const mergeLayer = async () => {
    if (!layer || !base) return;
    setBusy('Juntando o original com a expansão…');
    try {
      const r = await api.invoke<{ file: string; width: number; height: number; warnings: string[] }>('expand:merge', { source: layer.path, expansion: base, aspect: 0 });
      commit(adj, r.file);
      setLayer(null);
      toast({ kind: 'ok', title: 'Juntado sem marcas', message: `${r.width}×${r.height}. ${r.warnings.join(' ')} Use Desfazer (Ctrl+Z) para voltar.`.trim() });
    } catch (err: any) {
      toast({ kind: 'error', title: 'Não consegui juntar', message: String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
    } finally { setBusy(''); }
  };
  const applyLayer = async () => {
    if (!layer || !base) return;
    setBusy('Colando a imagem em resolução total…');
    try {
      const bytes = await toPng(await bakeLayer(mediaUrl(base), layer, pasteOpts));
      const out = await api.invoke<string>('editor:writeTemp', bytes);
      commit(adj, out);
      setLayer(null);
      toast({ kind: 'ok', title: 'Imagem colada', message: 'Use Desfazer (Ctrl+Z) para voltar.' });
    } catch (err: any) {
      toast({ kind: 'error', title: 'Não consegui colar', message: err.message });
    } finally { setBusy(''); }
  };

  const keepGeometry = () => ({ rotate: adj.rotate, flipX: adj.flipX, flipY: adj.flipY, crop: adj.crop });
  const auto = () => {
    const gl = glRef.current;
    if (!gl) return;
    commit({ ...clone(adj), ...autoAdjust(gl.sample()) });
    toast({ kind: 'ok', title: 'Ajuste automático aplicado', message: 'Use Desfazer (Ctrl+Z) se não gostar.' });
  };
  const applyLook = (id: string) => commit({ ...defaultAdjust(), ...clone(LOOKS[id].adj), ...keepGeometry() });
  const resetAll = () => commit({ ...defaultAdjust(), ...keepGeometry() });
  /** Runs a tool that produces a new working file (eraser, upscale). */
  const runOnBase = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    try { commit(adj, await fn()); } catch (err: any) {
      toast({ kind: 'error', title: 'Não deu certo', message: err.message });
    } finally { setBusy(''); }
  };
  const erase = async () => {
    const gl = glRef.current;
    if (!gl || !base || !strokes.length) return;
    // Mask at full resolution: white = remove.
    const w = gl.width; const h = gl.height;
    const oc = new OffscreenCanvas(w, h);
    const ctx = oc.getContext('2d')!;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const s of strokes) {
      ctx.lineWidth = s.r * 2 * w;
      ctx.beginPath();
      s.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)));
      if (s.pts.length === 1) { ctx.arc(s.pts[0][0] * w, s.pts[0][1] * h, s.r * w, 0, Math.PI * 2); ctx.fill(); } else ctx.stroke();
    }
    const mask = new Uint8Array(await (await oc.convertToBlob({ type: 'image/png' })).arrayBuffer());
    await runOnBase('Apagando com IA…', () => api.invoke('editor:erase', base, mask));
    setStrokes([]);
  };
  /** Pintar: the strokes burnt into the picture at full size (solid colour). */
  const applyPaint = async () => {
    if (!base || !paint.length) return;
    setBusy('Pintando em resolução total…');
    try {
      const B = await loadPix(mediaUrl(base));
      const oc = new OffscreenCanvas(B.w, B.h);
      const ctx = oc.getContext('2d')!;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(B.data), B.w, B.h), 0, 0);
      const pc = new OffscreenCanvas(B.w, B.h);
      drawStrokes(pc.getContext('2d')!, paint, B.w, B.h, PAINT_CSS);
      ctx.drawImage(pc, 0, 0);
      const bytes = new Uint8Array(await (await oc.convertToBlob({ type: 'image/png' })).arrayBuffer());
      const out = await api.invoke<string>('editor:writeTemp', bytes);
      commit(adj, out);
      setPaint([]);
      setHasPaint(true);
      toast({ kind: 'ok', title: 'Pintura aplicada', message: 'Agora é só enviar para o ChatGPT. Quando a imagem voltar, o app põe o original de volta sozinho.' });
    } catch (err: any) {
      toast({ kind: 'error', title: 'Não consegui pintar', message: err.message });
    } finally { setBusy(''); }
  };
  const upscale = () => base && runOnBase('Upscale 4K na GPU…', () => api.invoke('editor:upscale', base));
  const save = async (monitorId?: string) => {
    const gl = glRef.current;
    if (!gl || !source) return;
    if (layer) { setTool('paste'); toast({ kind: 'warn', title: 'Falta aplicar a imagem colada', message: 'Clique em Aplicar (ou Cancelar) na aba Colar antes de salvar.' }); return; }
    setBusy('Salvando em resolução total…');
    try {
      const bytes = await gl.exportPng(adj);
      const r = await api.invoke<{ out: string; updated: boolean; canceled?: boolean }>('editor:save', { source, bytes, format });
      if (r.canceled) return;
      if (monitorId) await api.invoke('monitor:apply', monitorId, r.updated ? source : r.out, { fix: false });
      toast({ kind: 'ok', title: r.updated ? 'Imagem da galeria atualizada' : 'Salvo', message: r.updated ? `${fileName(r.out)} foi atualizada (o original ficou guardado na pasta _Backup).` : r.out });
    } catch (err: any) {
      toast({ kind: 'error', title: 'Não consegui salvar', message: err.message });
    } finally { setBusy(''); }
  };
  /** Same colour/detail settings on every image of the folder (no crop/rotation). */
  const applyToFolder = async () => {
    const gl = glRef.current;
    if (!gl || !source) return;
    const folder = source.replace(/[\\/][^\\/]+$/, '');
    const list = (await api.invoke<MediaItem[]>('media:list', folder, {})).filter((i) => i.type === 'image');
    if (!list.length) return;
    const a: Adjust = { ...clone(adj), rotate: 0, flipX: false, flipY: false, crop: { ...NO_CROP } };
    setBatch({ done: 0, total: list.length });
    const keep = base;
    try {
      for (let i = 0; i < list.length; i++) {
        const best = await api.invoke<string | null>('editor:bestBase', list[i].path);
        await gl.load(mediaUrl(best || list[i].path));
        const bytes = await gl.exportPng(a);
        await api.invoke('editor:save', { source: list[i].path, bytes, format, mode: 'edited' });
        setBatch({ done: i + 1, total: list.length });
      }
      toast({ kind: 'ok', title: 'Ajustes aplicados na pasta', message: `${list.length} imagens salvas em _Editado.` });
    } catch (err: any) {
      toast({ kind: 'error', title: 'Lote interrompido', message: err.message });
    } finally {
      setBatch(null);
      if (keep) await loadBase(keep);
    }
  };
  const presets = state?.config.global.editPresets || [];
  const savePreset = async () => {
    const name = `Meu ajuste ${presets.length + 1}`;
    const next = [...presets, { name, adj: { ...clone(adj), crop: { ...NO_CROP }, rotate: 0, flipX: false, flipY: false } }];
    await api.invoke('config:global', { editPresets: next });
    toast({ kind: 'ok', title: 'Preset salvo', message: name });
  };

  // --- Pointer on the image (brush / crop box) ----------------------------------
  const rel = (e: React.PointerEvent): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };
  const drag = useRef<{ mode: 'brush' | 'move' | 'tl' | 'br' | 'new'; start: [number, number]; crop: CropRect } | null>(null);
  const onDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = rel(e);
    if (tool === 'erase') {
      const r = brush / 2 / ((view.w || 1) * zoom);
      setStrokes((s) => [...s, { pts: [p], r }]);
      drag.current = { mode: 'brush', start: p, crop: cropDraft };
    } else if (painting) {
      const r = paintSize / 2 / (glRef.current?.width || 1);
      setPaint((s) => [...s, { pts: [p], r, erase: paintErase }]);
      drag.current = { mode: 'brush', start: p, crop: cropDraft };
    } else if (tool === 'crop') {
      const c = cropDraft;
      const near = (a: number, b: number) => Math.abs(a - b) < 0.03;
      let mode: 'move' | 'tl' | 'br' | 'new' = 'move';
      if (near(p[0], c.x + c.w) && near(p[1], c.y + c.h)) mode = 'br';
      else if (near(p[0], c.x) && near(p[1], c.y)) mode = 'tl';
      else if (!(p[0] > c.x && p[0] < c.x + c.w && p[1] > c.y && p[1] < c.y + c.h)) mode = 'new';
      drag.current = { mode, start: p, crop: { ...c } };
    }
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = rel(e);
    if (d.mode === 'brush') {
      const add = (s: Stroke[]) => { const c = s.slice(); const last = c[c.length - 1]; if (last) last.pts = [...last.pts, p]; return c; };
      if (painting) setPaint(add); else setStrokes(add);
      return;
    }
    const dx = p[0] - d.start[0]; const dy = p[1] - d.start[1];
    let c = { ...d.crop };
    // Aspect lock in normalised units (the box is drawn over a non-square image).
    const lock = cropAspect ? cropAspect * ((view.h || 1) / (view.w || 1)) : null;
    if (d.mode === 'move') {
      c.x = clampTo(d.crop.x + dx, 1 - c.w);
      c.y = clampTo(d.crop.y + dy, 1 - c.h);
    } else {
      let x0 = d.mode === 'tl' ? d.crop.x + dx : d.mode === 'new' ? Math.min(d.start[0], p[0]) : d.crop.x;
      let y0 = d.mode === 'tl' ? d.crop.y + dy : d.mode === 'new' ? Math.min(d.start[1], p[1]) : d.crop.y;
      let x1 = d.mode === 'br' ? d.crop.x + d.crop.w + dx : d.mode === 'new' ? Math.max(d.start[0], p[0]) : d.crop.x + d.crop.w;
      let y1 = d.mode === 'br' ? d.crop.y + d.crop.h + dy : d.mode === 'new' ? Math.max(d.start[1], p[1]) : d.crop.y + d.crop.h;
      x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(1, x1); y1 = Math.min(1, y1);
      let w = Math.max(0.05, x1 - x0); let h = Math.max(0.05, y1 - y0);
      if (lock) { h = w / lock; if (y0 + h > 1) { h = 1 - y0; w = h * lock; } }
      c = { x: x0, y: y0, w, h };
    }
    setCropDraft(c);
  };
  const onUp = () => { drag.current = null; };
  useEffect(() => { if (tool === 'crop') setCropDraft(adj.crop); }, [tool]);
  const setCropAspect = (a: number | null) => {
    setCropAspectState(a);
    if (!a || !view.w) return;
    // Largest centred box with that aspect.
    const ratio = a * (view.h / view.w);
    let w = 1; let h = w / ratio;
    if (h > 1) { h = 1; w = ratio; }
    setCropDraft({ x: (1 - w) / 2, y: (1 - h) / 2, w, h });
  };

  // Brush strokes drawn over the preview.
  useEffect(() => {
    const cv = overlayRef.current;
    if (!cv) return;
    cv.width = view.w; cv.height = view.h;
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (painting) { drawStrokes(ctx, paint, cv.width, cv.height, PAINT_CSS); return; }
    if (tool !== 'erase') return;
    ctx.strokeStyle = 'rgba(255,90,120,.55)'; ctx.fillStyle = 'rgba(255,90,120,.55)'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const s of strokes) {
      ctx.lineWidth = s.r * 2 * cv.width;
      ctx.beginPath();
      s.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * cv.width, y * cv.height) : ctx.moveTo(x * cv.width, y * cv.height)));
      if (s.pts.length === 1) { ctx.arc(s.pts[0][0] * cv.width, s.pts[0][1] * cv.height, s.r * cv.width, 0, Math.PI * 2); ctx.fill(); } else ctx.stroke();
    }
  }, [strokes, paint, view, tool]);

  const monitors = state?.monitors || [];
  const aspects = useMemo(() => [
    ...monitors.map((m) => ({ label: `Monitor ${m.index} (${m.rect.width}×${m.rect.height})`, v: m.rect.width / m.rect.height })),
    { label: '16:9', v: 16 / 9 }, { label: '21:9', v: 21 / 9 }, { label: '32:9', v: 32 / 9 }, { label: '9:16', v: 9 / 16 },
  ], [monitors]);
  /** Wallpaper formats for Expandir: one chip per proportion, naming the monitors that use it. */
  const expandChips = useMemo(() => {
    const named: Record<string, string> = { '1.778': '16:9', '2.333': '21:9', '3.556': '32:9', '1.600': '16:10' };
    const map = new Map<string, { v: number; mons: number[] }>();
    for (const m of monitors) {
      const v = m.rect.width / m.rect.height; const k = v.toFixed(3);
      if (v <= 1) continue;
      const e = map.get(k) || { v, mons: [] }; e.mons.push(m.index); map.set(k, e);
    }
    for (const v of [16 / 9, 21 / 9, 32 / 9]) { const k = v.toFixed(3); if (!map.has(k)) map.set(k, { v, mons: [] }); }
    return [...map.entries()].map(([k, e]) => ({
      v: e.v,
      label: (named[k] || `${e.v.toFixed(2)}:1`) + (e.mons.length ? ` · monitor${e.mons.length > 1 ? 'es' : ''} ${e.mons.join(' e ')}` : ''),
    }));
  }, [monitors]);
  const outSize = glRef.current && glRef.current.width ? glRef.current.outputSize(adj) : null;

  return (
    <div className="page editor-page">
      <div className="page-head">
        <div>
          <h1>Editor</h1>
          <p>
            {source
              ? `${fileName(source)}${outSize ? `, ${outSize.w}×${outSize.h}` : ''}${base && base !== source ? ' (versão trabalhada)' : ''}`
              : 'Ajustes de luz e cor, detalhe, recorte, borracha com IA e encaixe no monitor. O original nunca é alterado.'}
          </p>
        </div>
        <div className="actions">
          <Btn onClick={browse} title="Abrir uma imagem do computador"><ImagePlus size={16} /> Abrir</Btn>
          <Btn onClick={() => setPicker('open')} title="Abrir uma imagem da galeria do app"><Images size={16} /> Da galeria</Btn>
          <Btn className="icon" title="Desfazer (Ctrl+Z)" onClick={doUndo} disabled={!undo.length}><Undo2 size={16} /></Btn>
          <Btn className="icon" title="Refazer (Ctrl+Y)" onClick={doRedo} disabled={!redo.length}><Redo2 size={16} /></Btn>
          <Btn className={`icon ${showBefore ? 'primary' : ''}`} title="Antes/depois (segure, ou tecla \)"
            onMouseDown={() => setShowBefore(true)} onMouseUp={() => setShowBefore(false)} onMouseLeave={() => setShowBefore(false)} disabled={!base}>
            <Eye size={16} />
          </Btn>
          <Segmented value={format} onChange={setFormat} options={[{ value: 'png', label: 'PNG' }, { value: 'jpg', label: 'JPG' }]} />
          <Btn className="primary" onClick={() => save()} disabled={!base || !!busy}><Save size={16} /> Salvar</Btn>
        </div>
      </div>

      <div className="editor-grid">
        <div
          className="editor-stage"
          ref={stageRef}
          onWheel={(e) => { if (base) zoomAt(zoom * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY); }}
          onPointerDown={(e) => {
            // Middle button always pans; left button pans when zoomed in on Ajustes/ChatGPT.
            if (e.button === 1 || (canPan && e.button === 0)) {
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              panDrag.current = { x: e.clientX, y: e.clientY, p: pan };
            }
          }}
          onPointerMove={(e) => { const d = panDrag.current; if (d) setPan({ x: d.p.x + e.clientX - d.x, y: d.p.y + e.clientY - d.y }); }}
          onPointerUp={() => { panDrag.current = null; }}
        >
          {!base && (
            <div className="empty-state" style={{ position: 'absolute', inset: 0, border: 0 }}>
              <ImagePlus size={36} />
              <h3>Abra uma imagem</h3>
              <p>Pela Galeria (botão Editar) ou pelo botão Abrir. Se existir a versão 4K, ela é usada automaticamente.</p>
              <div className="row" style={{ gap: 8 }}>
                <Btn className="primary" onClick={browse}><ImagePlus size={16} /> Do computador</Btn>
                <Btn onClick={() => setPicker('open')}><Images size={16} /> Da galeria</Btn>
              </div>
            </div>
          )}
          <div
            className="editor-canvas"
            style={{
              width: view.w, height: view.h, visibility: base ? 'visible' : 'hidden',
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '50% 50%',
              cursor: canPan ? 'grab' : undefined,
            }}
            onPointerDown={onDown}
            onPointerMove={(e) => {
              if (painting || tool === 'erase') { const r = e.currentTarget.getBoundingClientRect(); setCursor({ x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom }); }
              onMove(e);
            }}
            onPointerLeave={() => setCursor(null)}
            onPointerUp={onUp}
          >
            <canvas ref={canvasRef} style={{ width: view.w, height: view.h }} />
            <canvas ref={overlayRef} className="editor-overlay" />
            {tool === 'crop' && (
              <div className="crop-box" style={{ left: `${cropDraft.x * 100}%`, top: `${cropDraft.y * 100}%`, width: `${cropDraft.w * 100}%`, height: `${cropDraft.h * 100}%` }}>
                <i className="h tl" /><i className="h br" />
              </div>
            )}
            {tool === 'paste' && layer && glRef.current && (
              <PasteLayerBox layer={layer} onChange={(l) => setLayer(l)} bw={glRef.current.width} bh={glRef.current.height} viewW={view.w} viewH={view.h} zoom={zoom}
                alpha={layerAlpha} mode={pasteMode} view={pasteView} opts={pasteOpts} baseUrl={base ? mediaUrl(base) : ''} showMask={showMask} />
            )}
            {(painting || tool === 'erase') && cursor && (() => {
              const d = painting ? (paintSize / (glRef.current?.width || 1)) * view.w : brush / zoom;
              return <div className="brush-cursor" style={{ left: cursor.x, top: cursor.y, width: d, height: d, borderWidth: 1.5 / zoom }} />;
            })()}
            {tool === 'erase' && <div className="brush-hint">Pinte por cima da marca d'água ou do objeto</div>}
          </div>
          {base && (
            <div className="zv-tools editor-zoom" onPointerDown={(e) => e.stopPropagation()} style={{ left: 14, transform: 'none' }}>
              <button title="Diminuir zoom" onClick={() => zoomAt(zoom / 1.5)}><ZoomOut size={14} /></button>
              <span>{Math.round(zoom * (view.scale || 1) * 100)}%</span>
              <button title="Aumentar zoom (roda do mouse)" onClick={() => zoomAt(zoom * 1.5)}><ZoomIn size={14} /></button>
              <button title="Ajustar à tela" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}><Maximize size={14} /></button>
            </div>
          )}
          <AnimatePresence>
            {(busy || batch) && (
              <motion.div className="editor-busy" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: 'linear' }} style={{ display: 'inline-flex' }}><Sparkles size={18} /></motion.span>
                {batch ? `Aplicando na pasta… ${batch.done}/${batch.total}` : busy}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="editor-side">
          <div className="tool-groups">
            {([
              ['Imagem', [['adjust', 'Ajustes', SlidersHorizontal], ['crop', 'Recorte', Crop], ['erase', 'Borracha', Eraser]]],
              ['Wallpaper com IA', [['expand', 'Expandir', Expand], ['chatgpt', 'Editar IA', WandSparkles], ['paste', 'Colar', Layers]]],
            ] as const).map(([group, items]) => (
              <div key={group} className="tool-group">
                <span className="tool-group-title">{group}</span>
                <div className="tool-tabs">
                  {items.map(([id, label, Icon]) => (
                    <button key={id} className={tool === id ? 'on' : ''} onClick={() => setTool(id)} disabled={!base}>
                      {tool === id && <motion.span layoutId="tooltab" className="seg-pill" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
                      <span><Icon size={15} /> {label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="editor-scroll">
            {tool === 'paste' && (
              <PastePanel layer={layer} setLayer={setLayer} bw={glRef.current?.width || 1} bh={glRef.current?.height || 1}
                alpha={layerAlpha} setAlpha={setLayerAlpha} opts={pasteOpts} setOpts={setPasteOpts}
                mode={pasteMode} setMode={setPasteMode} view={pasteView} setView={setPasteView} showMask={showMask} setShowMask={setShowMask}
                onImportFile={importLayerFile} onImportGallery={() => setPicker('layer')} onImportClipboard={importLayerClipboard}
                onAuto={() => autoFit()} autoBusy={autoBusy}
                onApply={applyLayer} onCancel={() => setLayer(null)} busy={!!busy} onMerge={mergeLayer} />
            )}
            {tool === 'expand' && (
              <div className="steps">
                <p className="muted small" style={{ margin: 0 }}>
                  Transforma a imagem num wallpaper do formato do monitor, criando cenário novo em volta. O original nunca é redesenhado: no fim, o app põe ele de volta inteiro.
                </p>

                <Step n={1} title="Formato do wallpaper">
                  <div className="chips">
                    {expandChips.map((a) => (
                      <button key={a.label} className={`chip-t ${Math.abs(expandAspect - a.v) < 0.001 ? 'on' : ''}`} onClick={() => setExpandAspect(a.v)}>{a.label}</button>
                    ))}
                  </div>
                  <span className="muted small">
                    {alreadyThere ? `A imagem já está em ${aspectLabel}: escolha outro formato.` : `Vai ganhar cenário ${expandSides} até ficar ${aspectLabel}.`}
                  </span>
                </Step>

                <Step n={2} title="Quem cria o cenário novo">
                  <Segmented value={expEngine} onChange={setExpEngine}
                    options={[{ value: 'local', label: 'IA local (no PC)' }, { value: 'chatgpt', label: 'ChatGPT' }]} />
                  {expEngine === 'local' ? (
                    <div className="stack" style={{ gap: 8 }}>
                      <span className="muted small">FLUX Fill rodando na sua placa de vídeo: sem censura, sem internet e sem precisar esconder nada. Leva cerca de 1 a 2 minutos.</span>
                      {localAi && !localAi.installed && (
                        <div className="cg-missing">
                          <b className="small">{localAi.installing ? 'Preparando a IA local…' : 'A IA local ainda não está instalada'}</b>
                          {localAi.installing
                            ? <ProgressLine stage={localAi.stage} value={localAi.progress} />
                            : <span className="muted small">É um download único de cerca de {localAi.sizeGb || 18} GB (modelo FLUX Fill e o motor ComfyUI). Depois funciona offline.</span>}
                          {localAi.error && <span className="merge-warn small"><TriangleAlert size={12} /> {localAi.error}</span>}
                          {!localAi.installing && <Btn className="sm primary" onClick={installLocal}><Download size={13} /> Baixar e preparar</Btn>}
                        </div>
                      )}
                      {localAi?.installed && (
                        <>
                          <label className="stack" style={{ gap: 4 }}>
                            <span className="small muted">Descrição do cenário (opcional, ajuda em cenas difíceis)</span>
                            <input className="input" placeholder="ex.: quarto aconchegante com abajures e quadros" value={sceneHint} onChange={(e) => setSceneHint(e.target.value)} />
                          </label>
                          <Segmented value={localQuality} onChange={setLocalQuality} options={[{ value: 'best', label: 'Melhor qualidade' }, { value: 'fast', label: 'Mais rápido' }]} />
                          {localAi.busy
                            ? (
                              <div className="cg-wait">
                                <ProgressLine stage={localAi.stage} value={localAi.progress} />
                                <Btn className="sm ghost" onClick={() => api.invoke('localai:cancel')}><X size={13} /> Parar</Btn>
                              </div>
                            )
                            : <Btn className="sm primary" onClick={expandLocal} disabled={!base || !!busy || alreadyThere}><Sparkles size={14} /> Expandir no PC</Btn>}
                          {localAi.error && !localAi.busy && <span className="merge-warn small"><TriangleAlert size={12} /> {localAi.error}</span>}
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="stack" style={{ gap: 8 }}>
                      <span className="muted small"><b>a)</b> Pinte por cima do que o ChatGPT não deve ver (ele recusa conteúdo sensível). Evite encostar a pintura na borda da imagem, quando der.</span>
                      <Segmented value={paintErase ? 'erase' : 'paint'} onChange={(v) => setPaintErase(v === 'erase')} options={[{ value: 'paint', label: 'Pintar' }, { value: 'erase', label: 'Apagar pintura' }]} />
                      <label className="paste-range">
                        <span className="row" style={{ justifyContent: 'space-between' }}><span>Tamanho do pincel</span><b>{paintSize} px</b></span>
                        <input type="range" min={0} max={100} step={0.5} value={Math.round((Math.log(paintSize / 4) / Math.log(2000 / 4)) * 1000) / 10}
                          onChange={(e) => setPaintSize(Math.round(4 * Math.pow(2000 / 4, Number(e.target.value) / 100)))} />
                      </label>
                      <div className="chips">
                        {[20, 60, 150, 400, 900, 1600].map((n) => <button key={n} className={`chip-t ${paintSize === n ? 'on' : ''}`} onClick={() => setPaintSize(n)}>{n < 100 ? 'P' : n < 300 ? 'M' : n < 800 ? 'G' : n < 1200 ? 'GG' : 'Enorme'} {n}</button>)}
                      </div>
                      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                        <Btn className="sm primary" onClick={applyPaint} disabled={!paint.length || !!busy}><PaintBucket size={14} /> Aplicar pintura</Btn>
                        <Btn className="sm" onClick={() => setPaint((p) => p.slice(0, -1))} disabled={!paint.length}><Undo size={14} /> Desfazer traço</Btn>
                        <Btn className="sm ghost" onClick={() => setPaint([])} disabled={!paint.length}><X size={14} /> Limpar</Btn>
                      </div>
                      {hasPaint && <span className="muted small"><Check size={12} style={{ verticalAlign: -2 }} /> Pintura aplicada (Ctrl+Z desfaz).</span>}
                      <span className="muted small"><b>b)</b> Envie. O app abre o ChatGPT, cola a imagem e o pedido e envia sozinho.</span>
                      {cgStatus.installed === false && (
                        <div className="cg-missing">
                          <b className="small">É necessário instalar o aplicativo do ChatGPT</b>
                          <span className="muted small">Instale pela Microsoft Store, entre na sua conta e volte aqui.</span>
                          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                            <Btn className="sm primary" onClick={() => api.invoke('chatgpt:store')}><Download size={13} /> Instalar o ChatGPT</Btn>
                            <Btn className="sm ghost" onClick={() => api.invoke('chatgpt:status').then(setCgStatus)}><RefreshCcw size={13} /> Já instalei</Btn>
                          </div>
                        </div>
                      )}
                      <Btn className="sm primary" onClick={() => sendToChatGpt(true)} disabled={!base || !!busy || cgStatus.installed === false || alreadyThere}><MessageSquare size={14} /> Enviar para o ChatGPT</Btn>
                      <details className="prompt-box">
                        <summary className="small">Ver ou editar o pedido</summary>
                        <textarea className="input" value={expPrompt} onChange={(e) => { setExpPrompt(e.target.value); setExpPromptEdited(true); }} />
                        {expPromptEdited && <button className="small muted" onClick={() => setExpPromptEdited(false)}>↺ voltar ao pedido automático</button>}
                      </details>
                      {cgStatus.waiting && (
                        <div className="cg-wait">
                          <b className="small">Aguardando a imagem do ChatGPT…</b>
                          <span className="muted small">{cgStatus.stage}</span>
                          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                            <Btn className="sm ghost" onClick={() => sentImage && api.invoke('chatgpt:copyImage', sentImage)}><Copy size={13} /> Copiar imagem</Btn>
                            <Btn className="sm ghost" onClick={() => api.invoke('chatgpt:copyText', expPrompt)}><Copy size={13} /> Copiar pedido</Btn>
                            <Btn className="sm ghost" onClick={() => api.invoke('chatgpt:cancel')}><X size={13} /> Parar</Btn>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </Step>

                <Step n={3} title="Juntar com o original (automático)">
                  <span className="muted small">
                    Quando a imagem expandida chegar, o app encaixa o original de volta inteiro, na resolução dele, iguala as cores e esconde a emenda. Você confere numa comparação e salva.
                  </span>
                  <Btn className="sm ghost" onClick={() => pickChatGptFile(true)} disabled={!source}><FolderOpen size={13} /> Já tenho a imagem expandida: escolher</Btn>
                </Step>
              </div>
            )}
            {tool === 'adjust' && (
              <>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <Btn className="sm primary" onClick={auto} disabled={!base}><WandSparkles size={14} /> Auto</Btn>
                  <Btn className="sm" onClick={upscale} disabled={!base || !!busy}><Sparkles size={14} /> Upscale 4K</Btn>
                  <Btn className="sm ghost" onClick={resetAll} disabled={!base}><RefreshCcw size={14} /> Zerar</Btn>
                </div>
                <Section title="Filtros">
                  <div className="chips">
                    {Object.entries(LOOKS).map(([id, l]) => <button key={id} className="chip-t" onClick={() => applyLook(id)} disabled={!base}>{l.label}</button>)}
                    {presets.map((p, i) => (
                      <button key={i} className="chip-t on" onClick={() => commit({ ...clone(p.adj), ...keepGeometry() })}>{p.name}</button>
                    ))}
                  </div>
                </Section>
                <Section title="Luz">
                  <Slider label="Exposição" v={adj.exposure} min={-2} max={2} on={(v) => live((a) => { a.exposure = v; })} />
                  <Slider label="Contraste" v={adj.contrast} min={-1} max={1} on={(v) => live((a) => { a.contrast = v; })} />
                  <Slider label="Realces" v={adj.highlights} min={-1} max={1} on={(v) => live((a) => { a.highlights = v; })} />
                  <Slider label="Sombras" v={adj.shadows} min={-1} max={1} on={(v) => live((a) => { a.shadows = v; })} />
                  <Slider label="Brancos" v={adj.whites} min={-1} max={1} on={(v) => live((a) => { a.whites = v; })} />
                  <Slider label="Pretos" v={adj.blacks} min={-1} max={1} on={(v) => live((a) => { a.blacks = v; })} />
                </Section>
                <Section title="Cor">
                  <Slider label="Temperatura" v={adj.temperature} min={-1} max={1} track="linear-gradient(90deg,#4d8dff,#ddd,#ffb03d)" on={(v) => live((a) => { a.temperature = v; })} />
                  <Slider label="Matiz" v={adj.tint} min={-1} max={1} track="linear-gradient(90deg,#4dd86b,#ddd,#e24dff)" on={(v) => live((a) => { a.tint = v; })} />
                  <Slider label="Vibração" v={adj.vibrance} min={-1} max={1} on={(v) => live((a) => { a.vibrance = v; })} />
                  <Slider label="Saturação" v={adj.saturation} min={-1} max={1} on={(v) => live((a) => { a.saturation = v; })} />
                </Section>
                <Section title="Cor por faixa (HSL)" collapsed>
                  {HSL_NAMES.map((name, i) => (
                    <div className="hsl-row" key={name}>
                      <span className="sw" style={{ background: HSL_COLORS[i] }} />
                      <b>{name}</b>
                      <Slider label="Matiz" v={adj.hsl[i].h} min={-1} max={1} on={(v) => live((a) => { a.hsl[i].h = v; })} compact />
                      <Slider label="Saturação" v={adj.hsl[i].s} min={-1} max={1} on={(v) => live((a) => { a.hsl[i].s = v; })} compact />
                      <Slider label="Luminância" v={adj.hsl[i].l} min={-1} max={1} on={(v) => live((a) => { a.hsl[i].l = v; })} compact />
                    </div>
                  ))}
                </Section>
                <Section title="Curvas" collapsed>
                  {(['master', 'r', 'g', 'b'] as const).map((ch) => (
                    <CurveEditor key={ch}
                      label={{ master: 'RGB', r: 'Vermelho', g: 'Verde', b: 'Azul' }[ch]}
                      color={{ master: '#f7ece1', r: '#ff6b6b', g: '#6bdc8b', b: '#6ba8ff' }[ch]}
                      pts={adj.curve[ch]}
                      on={(pts) => live((a) => { a.curve[ch] = pts; })}
                      reset={() => commit({ ...clone(adj), curve: { ...adj.curve, [ch]: [...CURVE_X] } })}
                    />
                  ))}
                </Section>
                <Section title="Detalhe">
                  <Slider label="Nitidez" v={adj.sharpen} min={0} max={1} on={(v) => live((a) => { a.sharpen = v; })} />
                  <Slider label="Claridade" v={adj.clarity} min={-1} max={1} on={(v) => live((a) => { a.clarity = v; })} />
                  <Slider label="Remover névoa" v={adj.dehaze} min={0} max={1} on={(v) => live((a) => { a.dehaze = v; })} />
                  <Slider label="Redução de ruído" v={adj.denoise} min={0} max={1} on={(v) => live((a) => { a.denoise = v; })} />
                  <Slider label="Anti-faixas (debanding)" v={adj.deband} min={0} max={1} on={(v) => live((a) => { a.deband = v; })} />
                </Section>
                <Section title="Efeitos">
                  <Slider label="Vinheta" v={adj.vignette} min={0} max={1} on={(v) => live((a) => { a.vignette = v; })} />
                  <Slider label="Granulação" v={adj.grain} min={0} max={1} on={(v) => live((a) => { a.grain = v; })} />
                </Section>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                  <Btn className="sm" onClick={savePreset} disabled={!base}><Bookmark size={14} /> Salvar como preset</Btn>
                  <Btn className="sm" onClick={applyToFolder} disabled={!base || !!batch}><FolderCog size={14} /> Aplicar na pasta inteira</Btn>
                </div>
              </>
            )}

            {tool === 'crop' && (
              <Section title="Recorte e rotação">
                <div className="chips">
                  <button className={`chip-t ${cropAspect === null ? 'on' : ''}`} onClick={() => setCropAspect(null)}>Livre</button>
                  {aspects.map((a) => <button key={a.label} className={`chip-t ${cropAspect === a.v ? 'on' : ''}`} onClick={() => setCropAspect(a.v)}>{a.label}</button>)}
                </div>
                <div className="row" style={{ gap: 8, marginTop: 12 }}>
                  <Btn className="sm icon" title="Girar 90°" onClick={() => commit({ ...clone(adj), rotate: ((adj.rotate + 90) % 360) as Adjust['rotate'], crop: { ...NO_CROP } })}><RotateCw size={14} /></Btn>
                  <Btn className="sm icon" title="Espelhar" onClick={() => commit({ ...clone(adj), flipX: !adj.flipX })}><SquareCenterlineDashedHorizontal size={14} /></Btn>
                  <Btn className="sm icon" title="Inverter" onClick={() => commit({ ...clone(adj), flipY: !adj.flipY })}><SquareCenterlineDashedVertical size={14} /></Btn>
                </div>
                <p className="muted small">Arraste para mover; puxe os cantos para redimensionar; arraste fora para desenhar um novo recorte.</p>
                <div className="row" style={{ gap: 8 }}>
                  <Btn className="sm primary" onClick={() => { commit({ ...clone(adj), crop: cropDraft }); setTool('adjust'); }}><Check size={14} /> Aplicar recorte</Btn>
                  <Btn className="sm ghost" onClick={() => { commit({ ...clone(adj), crop: { ...NO_CROP } }); setCropDraft({ ...NO_CROP }); }}><X size={14} /> Sem recorte</Btn>
                </div>
              </Section>
            )}

            {tool === 'erase' && (
              <Section title="Borracha rápida (IA local)">
                <p className="muted small" style={{ marginTop: 0 }}>
                  Pinte por cima de marcas d'água, textos, assinaturas ou pequenos objetos. A LaMa preenche o lugar na hora, offline, usando sua placa de vídeo. Para remoções grandes ou difíceis, use a aba ChatGPT.
                </p>
                <Slider label={`Pincel: ${brush}px`} v={brush} min={6} max={200} step={1} on={(v) => setBrush(Math.round(v))} raw />
                <div className="row" style={{ gap: 8, marginTop: 8 }}>
                  <Btn className="sm primary" onClick={erase} disabled={!strokes.length || !!busy}><Eraser size={14} /> Apagar marcado</Btn>
                  <Btn className="sm ghost" onClick={() => setStrokes([])} disabled={!strokes.length}><X size={14} /> Limpar pincel</Btn>
                </div>
                <p className="muted small">Dica: use o zoom (roda do mouse) para pintar detalhes pequenos com precisão.</p>
              </Section>
            )}

            {tool === 'chatgpt' && (
              <Section title="Editar com o ChatGPT">
                <p className="muted small" style={{ marginTop: 0 }}>
                  Remover objetos, melhorar a imagem ou uma edição livre pelo aplicativo do ChatGPT do seu PC. Para virar wallpaper (mais largo), use a aba <b>Expandir</b>. Quando a imagem nova ficar pronta, é só <b>baixar</b> ou <b>copiar</b> no ChatGPT: o Chimpanzé pega sozinho.
                </p>
                <Segmented value={cgMode} onChange={(v) => { setCgMode(v); setPromptEdited(false); }}
                  options={[{ value: 'remove', label: 'Remover' }, { value: 'enhance', label: 'Melhorar' }, { value: 'custom', label: 'Livre' }]} />
                {cgMode === 'remove' && (
                  <input className="input" placeholder="O que remover? ex.: a pessoa ao fundo, o texto no canto" value={removeWhat} onChange={(e) => { setRemoveWhat(e.target.value); setPromptEdited(false); }} />
                )}
                {cgMode === 'custom' && (
                  <input className="input" placeholder="Descreva a edição, ex.: deixe o céu ao pôr do sol" value={customEdit} onChange={(e) => { setCustomEdit(e.target.value); setPromptEdited(false); }} />
                )}
                <span className="small muted">Pedido que vai para o ChatGPT (pode editar):</span>
                <textarea className="input" value={prompt} onChange={(e) => { setPrompt(e.target.value); setPromptEdited(true); }} />
                {promptEdited && <button className="small muted" style={{ alignSelf: 'flex-start' }} onClick={() => setPromptEdited(false)}>↺ voltar ao pedido automático</button>}
                {cgStatus.installed === false && (
                  <div className="cg-missing">
                    <b className="small">É necessário instalar o aplicativo do ChatGPT</b>
                    <span className="muted small">Esta função usa o app do ChatGPT para Windows (não o site). Instale pela Microsoft Store, entre na sua conta e volte aqui.</span>
                    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      <Btn className="sm primary" onClick={() => api.invoke('chatgpt:store')}><Download size={13} /> Instalar o ChatGPT</Btn>
                      <Btn className="sm ghost" onClick={() => api.invoke('chatgpt:status').then(setCgStatus)}><RefreshCcw size={13} /> Já instalei</Btn>
                    </div>
                  </div>
                )}
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <Btn className="sm primary" onClick={() => sendToChatGpt(false)} disabled={!base || !!busy || cgStatus.installed === false}><MessageSquare size={14} /> Enviar para o ChatGPT</Btn>
                </div>
                {cgStatus.waiting && (
                  <div className="cg-wait">
                    <b className="small">Aguardando a imagem do ChatGPT…</b>
                    <span className="muted small">{cgStatus.stage}</span>
                    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      <Btn className="sm ghost" onClick={() => sentImage && api.invoke('chatgpt:copyImage', sentImage)}><Copy size={13} /> Copiar imagem</Btn>
                      <Btn className="sm ghost" onClick={() => api.invoke('chatgpt:copyText', prompt)}><Copy size={13} /> Copiar pedido</Btn>
                      <Btn className="sm ghost" onClick={() => api.invoke('chatgpt:cancel')}><X size={13} /> Parar</Btn>
                    </div>
                  </div>
                )}
                <Btn className="sm ghost" onClick={() => pickChatGptFile(false)} disabled={!source}><FolderOpen size={13} /> Já baixei: escolher o arquivo</Btn>
              </Section>
            )}
          </div>

          {base && monitors.length > 0 && (
            <div className="editor-foot">
              <span className="small muted">Salvar e já colocar em:</span>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                {monitors.map((m) => <Btn key={m.id} className="sm" onClick={() => save(m.id)} disabled={!!busy}><MonitorUp size={13} /> {m.index}</Btn>)}
              </div>
            </div>
          )}
        </div>
      </div>
      <AnimatePresence>
        {picker && (
          <GalleryPicker key="pick" single
            title={picker === 'open' ? 'Abrir da galeria' : 'Imagem para colar por cima'}
            hint={picker === 'open' ? 'Clique na imagem que você quer editar.' : 'Clique na imagem que vai por cima da que está aberta (por exemplo, o original).'}
            onClose={() => setPicker(null)}
            onPick={([p]) => { const which = picker; setPicker(null); if (p) { if (which === 'open') open(p); else importLayer(p); } }} />
        )}
      </AnimatePresence>
    </div>
  );
}

/** Numbered step of a guided flow (Expandir). */
function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="step">
      <div className="step-head"><span className="step-n">{n}</span><b>{title}</b></div>
      <div className="step-body">{children}</div>
    </div>
  );
}

/** Stage text + progress bar (value 0..1, or undefined = working). */
function ProgressLine({ stage, value }: { stage?: string; value?: number }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      <span className="muted small">{stage || 'Trabalhando…'}{value != null ? ` ${Math.round(value * 100)}%` : ''}</span>
      <div className="pbar"><i style={{ width: value != null ? `${Math.max(2, value * 100)}%` : '35%' }} className={value == null ? 'indet' : ''} /></div>
    </div>
  );
}

function Section({ title, children, collapsed = false }: { title: string; children: ReactNode; collapsed?: boolean }) {
  const [open, setOpen] = useState(!collapsed);
  return (
    <div className="ed-section">
      <button className="ed-head" onClick={() => setOpen((o) => !o)}>
        <span>{title}</span>
        <motion.span animate={{ rotate: open ? 90 : 0 }} style={{ display: 'inline-block' }}>›</motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25 }} style={{ overflow: 'hidden' }}>
            <div className="ed-body">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Slider shown as −100…+100; double click resets to 0. `raw` hides the value (used for the brush size). */
function Slider({ label, v, min, max, step = 0.01, on, track, compact = false, raw = false }: {
  label: string; v: number; min: number; max: number; step?: number; on: (v: number) => void; track?: string; compact?: boolean; raw?: boolean;
}) {
  return (
    <label className={`ed-slider ${compact ? 'compact' : ''}`} onDoubleClick={() => !raw && on(0)}>
      <span className="l">{label}</span>
      {!raw && <span className="v">{v > 0 ? '+' : ''}{Math.round(v * 100)}</span>}
      <input type="range" min={min} max={max} step={step} value={v} onChange={(e) => on(Number(e.target.value))} style={track ? { background: track } : undefined} />
    </label>
  );
}

/** Five draggable points (shadows → highlights) with the same Catmull-Rom curve the shader uses. */
function CurveEditor({ label, pts, color, on, reset }: { label: string; pts: number[]; color: string; on: (pts: number[]) => void; reset: () => void }) {
  const dragging = useRef<number | null>(null);
  const y = (v: number) => 120 - v * 120;
  const path = useMemo(() => {
    let d = '';
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      d += `${i ? 'L' : 'M'}${t * 220},${y(curveAt(pts, t))}`;
    }
    return d;
  }, [pts]);
  return (
    <div className="curve">
      <div className="row">
        <b className="small grow">{label}</b>
        <button className="small muted" onClick={reset}>zerar</button>
      </div>
      <svg width={220} height={120} viewBox="0 0 220 120"
        onPointerMove={(e) => {
          if (dragging.current === null) return;
          const r = e.currentTarget.getBoundingClientRect();
          const v = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
          const next = pts.slice();
          next[dragging.current] = v;
          on(next);
        }}
        onPointerUp={() => { dragging.current = null; }}
        onPointerLeave={() => { dragging.current = null; }}
      >
        {[0.25, 0.5, 0.75].map((g) => <line key={g} x1={g * 220} x2={g * 220} y1={0} y2={120} stroke="rgba(255,220,190,.08)" />)}
        {[0.25, 0.5, 0.75].map((g) => <line key={'h' + g} y1={g * 120} y2={g * 120} x1={0} x2={220} stroke="rgba(255,220,190,.08)" />)}
        <path d={path} fill="none" stroke={color} strokeWidth={2} />
        {pts.map((v, i) => (
          <circle key={i} cx={(i / (pts.length - 1)) * 220} cy={y(v)} r={6} fill={color} stroke="#1b130f" strokeWidth={2} style={{ cursor: 'ns-resize' }}
            onPointerDown={(e) => { e.currentTarget.ownerSVGElement!.setPointerCapture(e.pointerId); dragging.current = i; }} />
        ))}
      </svg>
    </div>
  );
}

/** Brush strokes (normalised) drawn in one colour; "erase" strokes cut the paint away. */
function drawStrokes(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, strokes: Stroke[], w: number, h: number, color: string) {
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const st of strokes) {
    ctx.globalCompositeOperation = st.erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = color; ctx.fillStyle = color;
    ctx.lineWidth = st.r * 2 * w;
    ctx.beginPath();
    if (st.pts.length === 1) { ctx.arc(st.pts[0][0] * w, st.pts[0][1] * h, st.r * w, 0, Math.PI * 2); ctx.fill(); }
    else { st.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h))); ctx.stroke(); }
  }
  ctx.globalCompositeOperation = 'source-over';
}
