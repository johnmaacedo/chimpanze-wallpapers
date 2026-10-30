import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Wand2, ImagePlus, RefreshCw, FolderOpen, Download, Brain, Film, Info } from 'lucide-react';
import { api, useStore, mediaUrl, folderName, type MediaItem } from '../api';
import { Btn, Segmented, Toggle } from '../components/controls';
import { Tile } from '../components/Tile';
import { Lightbox } from '../components/Lightbox';

interface Status {
  comfy: { online: boolean; url?: string; version?: string };
  models: { known: boolean; missing: { name: string; size: string; folder: string }[] };
  gpu: { name: string; vramTotal: number; vramFree: number } | null;
  ollama: { online: boolean; hasModel?: boolean; models?: string[] };
  wanModels: { name: string; size: string; folder: string }[];
  tools: { upscaler: boolean; rife: boolean; ffmpeg: boolean };
}

const PRESET_LABELS: Record<string, string> = {
  hair: 'Cabelo ao vento', clouds: 'Nuvens', water: 'Água', rain: 'Chuva', snow: 'Neve', lights: 'Luzes e neon',
  particles: 'Partículas', petals: 'Pétalas e folhas', fire: 'Fogo e velas', blink: 'Respirar e piscar', stars: 'Estrelas', fog: 'Névoa',
};

export function AnimatedPage({ initialImage, clearInitial }: { initialImage: string | null; clearInitial: () => void }) {
  const { state, setGlobal, toast, mediaVersion, jobs } = useStore();
  const [status, setStatus] = useState<Status | null>(null);
  const [checking, setChecking] = useState(false);
  const [image, setImage] = useState<string | null>(initialImage);
  const [prompt, setPrompt] = useState('');
  const [presets, setPresets] = useState<string[]>(['hair']);
  const [seconds, setSeconds] = useState(5);
  const [fps, setFps] = useState<'24' | '30' | '60'>('30');
  const [quality, setQuality] = useState<'hd' | 'fast'>('hd');
  const [loop, setLoop] = useState<'crossfade' | 'pingpong' | 'none'>('crossfade');
  const [upscale, setUpscale] = useState(false);
  const [kind, setKind] = useState<'anime' | 'photo'>('anime');
  const [gif, setGif] = useState(false);
  const [describing, setDescribing] = useState(false);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [open, setOpen] = useState<number | null>(null);

  const folder = state?.config.global.animatedFolder || '';

  const check = async () => {
    setChecking(true);
    try { setStatus(await api.invoke<Status>('studio:status')); } catch { /* ignore */ } finally { setChecking(false); }
  };
  useEffect(() => { check(); }, []);
  useEffect(() => { if (initialImage) { setImage(initialImage); clearInitial(); } }, [initialImage]);
  useEffect(() => {
    if (!folder) return;
    api.invoke<MediaItem[]>('media:list', folder, {}).then(setItems).catch(() => setItems([]));
  }, [folder, mediaVersion]);

  const running = jobs.some((j) => j.kind === 'animate' && (j.status === 'running' || j.status === 'queued'));
  const frames = Math.round((seconds * 24) / 4) * 4 + 1;
  const ready = !!status?.comfy.online && (!status.models.known || !status.models.missing.length);

  const pickImage = async () => {
    const [f] = await api.invoke<string[]>('dialog:files', { title: 'Imagem para animar' });
    if (f) setImage(f);
  };
  const describe = async () => {
    if (!image) return;
    setDescribing(true);
    try {
      const p = await api.invoke<string>('studio:describe', image);
      setPrompt(p);
      toast({ kind: 'ok', title: 'Prompt sugerido pela IA', message: 'Revise e ajuste à vontade.' });
    } catch (e: any) {
      toast({ kind: 'error', title: 'Não consegui analisar a imagem', message: e.message });
    } finally { setDescribing(false); }
  };
  const generate = async () => {
    if (!image) return;
    await api.invoke('studio:generate', { image, prompt, presets, cameraStatic: true, seconds, fps: Number(fps), quality, loop, upscale: upscale ? 'x2' : 'none', kind, gif });
    toast({ kind: 'info', title: 'Animação na fila', message: 'A GPU vai gerar os quadros. Isso leva alguns minutos.' });
  };
  const pickModelsDir = async () => {
    const dir = await api.invoke<string | null>('dialog:folder', 'Pasta "models" do ComfyUI');
    if (!dir) return;
    try {
      await api.invoke('studio:downloadModels', dir);
      toast({ kind: 'info', title: 'Download dos modelos iniciado', message: 'São cerca de 17 GB. Acompanhe no botão de tarefas.' });
    } catch (e: any) { toast({ kind: 'error', title: 'Não foi possível baixar', message: e.message }); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Wallpapers animados</h1>
          <p>Transforme uma imagem num loop animado gerado por IA na sua placa de vídeo. Nada sai do seu PC.</p>
        </div>
        <div className="actions">
          <Btn onClick={() => api.invoke('shell:open', folder)} disabled={!folder}><FolderOpen size={16} /> Abrir pasta</Btn>
          <Btn onClick={check}><motion.span animate={{ rotate: checking ? 360 : 0 }} transition={{ duration: 0.8, repeat: checking ? Infinity : 0, ease: 'linear' }} style={{ display: 'inline-flex' }}><RefreshCw size={15} /></motion.span> Verificar IA</Btn>
        </div>
      </div>

      <div className="studio">
        <div className="stack">
          <div className="panel">
            <h3>Estúdio</h3>
            <button className={`drop ${image ? 'has' : ''}`} onClick={pickImage} style={{ width: '100%' }}>
              {image ? <img src={mediaUrl(image)} alt="" /> : (
                <span className="stack" style={{ alignItems: 'center', gap: 8 }}>
                  <ImagePlus size={30} color="var(--lilac)" />
                  <b style={{ color: 'var(--ink)' }}>Escolher imagem</b>
                  <span className="small">Ou abra uma imagem na Galeria e clique em "Animar com IA"</span>
                </span>
              )}
            </button>
            <div className="field" style={{ marginTop: 16 }}>
              <div className="row">
                <span className="label grow">O que deve se mexer</span>
                <Btn className="sm ai" onClick={describe} disabled={!image || describing || !status?.ollama.online}>
                  <Brain size={14} /> {describing ? 'Analisando…' : 'Entender a imagem'}
                </Btn>
              </div>
              <div className="chips">
                {Object.entries(PRESET_LABELS).map(([k, l]) => (
                  <motion.button key={k} whileTap={{ scale: 0.92 }} className={`chip-t ${presets.includes(k) ? 'on' : ''}`}
                    onClick={() => setPresets((ps) => (ps.includes(k) ? ps.filter((x) => x !== k) : [...ps, k]))}>{l}</motion.button>
                ))}
              </div>
              <textarea className="input" placeholder="Descreva o movimento em inglês (opcional). Ex.: her hair and ribbon sway gently, cherry petals fall slowly" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
              <span className="hint">A câmera fica sempre parada e o movimento é sutil, para o loop ficar natural.</span>
            </div>
          </div>
        </div>

        <div className="stack">
          <div className="panel">
            <h3>Motor de IA local</h3>
            <div className="stack" style={{ gap: 8 }}>
              <div className="status-line"><span className={`dot ${status?.comfy.online ? 'ok' : 'bad'}`} /> <span className="grow">ComfyUI {status?.comfy.online ? `conectado (${status.comfy.url})` : 'não encontrado'}</span></div>
              <div className="status-line"><span className={`dot ${ready ? 'ok' : status?.comfy.online ? 'warn' : 'bad'}`} />
                <span className="grow">Wan 2.2 TI2V-5B {status?.comfy.online ? (status.models.missing.length ? `faltam ${status.models.missing.length} arquivo(s)` : 'pronto') : ''}</span></div>
              <div className="status-line"><span className={`dot ${status?.ollama.online ? (status.ollama.hasModel ? 'ok' : 'warn') : 'bad'}`} />
                <span className="grow">Visão (Ollama) {status?.ollama.online ? (status.ollama.hasModel ? 'pronto' : `falta o modelo ${state?.config.global.ollama.model}`) : 'opcional, desligado'}</span></div>
              {status?.gpu && <div className="muted small">GPU: {status.gpu.name.replace(/^cuda:\d+\s*/, '')}, {(status.gpu.vramTotal / 1073741824).toFixed(1)} GB</div>}
            </div>
            {status && !ready && <Setup status={status} onPickModels={pickModelsDir} />}
          </div>

          <div className="panel">
            <h3>Saída</h3>
            <div className="stack">
              <div className="field">
                <span className="label">Duração: {seconds} s ({frames} quadros gerados a 24 fps)</span>
                <input type="range" min={2} max={5} step={1} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} />
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="label small" style={{ fontWeight: 650 }}>Fluidez final</span>
                <Segmented value={fps} onChange={setFps} options={[{ value: '24', label: '24 fps' }, { value: '30', label: '30' }, { value: '60', label: '60' }]} />
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="label small" style={{ fontWeight: 650 }}>Qualidade</span>
                <Segmented value={quality} onChange={setQuality} options={[{ value: 'hd', label: '720p' }, { value: 'fast', label: 'Rápida' }]} />
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="label small" style={{ fontWeight: 650 }}>Loop</span>
                <Segmented value={loop} onChange={setLoop} options={[{ value: 'crossfade', label: 'Perfeito' }, { value: 'pingpong', label: 'Vai e volta' }, { value: 'none', label: 'Sem' }]} />
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="small" style={{ fontWeight: 650 }}>Upscale do vídeo 2x (1440p)</span>
                <Toggle on={upscale} onChange={setUpscale} label="Upscale do vídeo" />
              </div>
              {upscale && <Segmented value={kind} onChange={setKind} options={[{ value: 'anime', label: 'Anime' }, { value: 'photo', label: 'Foto (mais lento)' }]} />}
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="small" style={{ fontWeight: 650 }}>Exportar também em GIF</span>
                <Toggle on={gif} onChange={setGif} label="GIF" />
              </div>
              <Btn className="ai" disabled={!image || !ready} onClick={generate} style={{ height: 46, justifyContent: 'center', fontSize: 14 }}>
                <Wand2 size={17} /> {running ? 'Adicionar à fila' : 'Gerar animação'}
              </Btn>
              <span className="muted small"><Info size={12} style={{ verticalAlign: -2 }} /> Na RTX 5070, um loop de 5 s em 720p leva alguns minutos.</span>
            </div>
          </div>
        </div>
      </div>

      <div className="page-head" style={{ marginTop: 30 }}>
        <div><h1 style={{ fontSize: 20 }}>Sua coleção</h1><p>{folder ? `Salvos em ${folderName(folder)}. Use esta pasta num monitor para girar só animados.` : ''}</p></div>
        <div className="actions">
          <Btn className="sm" onClick={async () => { const f = await api.invoke<string | null>('dialog:folder', 'Pasta dos animados'); if (f) setGlobal({ animatedFolder: f }); }}><FolderOpen size={14} /> Trocar pasta</Btn>
        </div>
      </div>
      {items.length ? (
        <div className="anim-grid">
          {items.map((it, i) => <Tile key={it.path} item={it} index={i} onOpen={() => setOpen(i)} />)}
        </div>
      ) : (
        <div className="empty-state"><Film size={34} /><h3>Nenhuma animação ainda</h3><p>As animações que você gerar (ou MP4/GIF que colocar nesta pasta) aparecem aqui.</p></div>
      )}
      <AnimatePresence>{open !== null && <Lightbox items={items} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}</AnimatePresence>
    </div>
  );
}

function Setup({ status, onPickModels }: { status: Status; onPickModels: () => void }) {
  return (
    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} style={{ marginTop: 14 }}>
      {!status.comfy.online ? (
        <ol className="steps small">
          <li>Instale o <b>ComfyUI Desktop</b> (comfy.org/download) e abra-o. Ele usa a sua RTX direto.</li>
          <li>Deixe o ComfyUI aberto e clique em <b>Verificar IA</b>.</li>
          <li>Opcional: instale o <b>Ollama</b> e rode <code>ollama pull qwen2.5vl:7b</code> para a IA entender a imagem e sugerir o movimento.</li>
        </ol>
      ) : status.models.missing.length ? (
        <div className="stack" style={{ gap: 10 }}>
          <span className="small muted">Faltam estes arquivos do modelo Wan 2.2 (oficiais da Comfy-Org):</span>
          {status.models.missing.map((m) => <div key={m.name} className="small"><code>{m.folder}/{m.name}</code> {m.size}</div>)}
          <Btn className="sm" onClick={onPickModels}><Download size={14} /> Baixar para a pasta "models" do ComfyUI</Btn>
          <span className="muted small">Depois do download, clique em Verificar IA. No ComfyUI Desktop a pasta fica em Documentos\ComfyUI\models.</span>
        </div>
      ) : null}
    </motion.div>
  );
}
