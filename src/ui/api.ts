import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import TRANSITIONS from '../../electron/transitions.json';

export interface Rect { x: number; y: number; width: number; height: number }
export interface Monitor {
  id: string; rect: Rect; index: number; name: string; primary: boolean; scaleFactor: number;
  refreshRate: number; brand: string; model: string; label: string; displayId: number | null;
}
export interface OfflineMonitor { id: string; name: string; rect: Rect | null; lastSeen: number; offline: true }
export interface MonitorCfg {
  id: string; name: string; alias: string; folder: string; includeSubfolders: boolean; intervalSec: number;
  auto: boolean; order: 'random' | 'sequential'; transition: string; transitionMs: number; easing: string;
  fit: 'cover' | 'contain' | 'stretch' | 'center'; kenBurns: boolean; fixed: string; current: string; enabled: boolean;
  lastRect: Rect | null; lastSeen: number;
}
export interface GlobalCfg {
  startWithWindows: boolean; pauseOnFullscreen: boolean; pauseOnMaximized: boolean; syncWindows: 'onExit' | 'always' | 'never';
  uiOpacity: number; reduceMotion: boolean; defaultTransition: string; transitionMs: number; easing: string; preferUpscaled: boolean;
  /** 0.2–2: how much zoom/blur/spin the transitions use. */
  transitionIntensity: number;
  /** Transitions left out of the random modes. */
  transitionsOff: string[];
  chatgpt: { autoType?: boolean; autoSend?: boolean; newChat?: boolean };
  upscale: { mode: string; animeModel: string; photoModel: string; artModel: string; target: string; format: string; gpu: string; skipIfLarger: boolean };
  editPresets: { name: string; adj: any }[];
  compactCorner: string; firstRunDone: boolean;
}
export interface SchedState { monitors: Record<string, { nextAt: number; occluded: boolean; error: string; busy: boolean; historySize: number }>; globalPaused: boolean; now: number }
export interface AppState {
  version: string; platform: string; raisedDesktop: boolean; monitors: Monitor[]; offline: OfflineMonitor[];
  config: { global: GlobalCfg; monitors: Record<string, MonitorCfg>; migratedFrom?: string };
  scheduler: SchedState; compact: boolean; tools: { upscaler: boolean; models: string[] };
  logFile: string | null; migratedFrom: string | null;
}
export interface MediaItem { path: string; name: string; type: 'image' | 'gif' | 'video'; size?: number; mtime?: number; upscaled?: string; edited?: string }
export interface Job {
  id: string; kind: 'upscale'; title: string; status: 'queued' | 'running' | 'done' | 'error' | 'canceled';
  progress: number; stage: string; result: any; error: string; createdAt: number; meta: any;
}
export interface Toast { id: number; kind: 'ok' | 'warn' | 'error' | 'info'; title: string; message?: string; action?: { label: string; run: () => void } }

declare global {
  interface Window {
    cw: {
      invoke: (c: string, ...a: any[]) => Promise<any>;
      send: (c: string, ...a: any[]) => void;
      on: (c: string, cb: (p: any) => void) => () => void;
      platform: string;
    };
  }
}

const hasBridge = typeof window !== 'undefined' && !!window.cw;
export const api = {
  invoke: <T = any>(c: string, ...a: any[]): Promise<T> => (hasBridge ? window.cw.invoke(c, ...a) : Promise.reject(new Error('sem ponte'))),
  on: (c: string, cb: (p: any) => void) => (hasBridge ? window.cw.on(c, cb) : () => {}),
};

// --- thumbnails (memoised) --------------------------------------------------
const thumbCache = new Map<string, Promise<string | null>>();
export function thumbUrl(path: string): Promise<string | null> {
  let p = thumbCache.get(path);
  if (!p) {
    p = api.invoke<string | null>('media:thumb', path).catch(() => null);
    thumbCache.set(path, p);
  }
  return p;
}
export function useThumb(path: string | null | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (path) thumbUrl(path).then((u) => alive && setUrl(u));
    return () => { alive = false; };
  }, [path]);
  return url;
}
export function mediaUrl(path: string) { return 'cwp://media/' + encodeURIComponent(path); }

// --- store -------------------------------------------------------------------
interface Store {
  state: AppState | null;
  sched: SchedState | null;
  jobs: Job[];
  toasts: Toast[];
  newMonitor: { id: string; name: string; rect: Rect } | null;
  mediaVersion: number;
  toast: (t: Omit<Toast, 'id'>) => void;
  dismiss: (id: number) => void;
  refresh: () => Promise<void>;
  setGlobal: (patch: Partial<GlobalCfg> | any) => Promise<void>;
  setMonitor: (id: string, patch: Partial<MonitorCfg>) => Promise<void>;
  clearNewMonitor: () => void;
}
export const StoreCtx = createContext<Store>(null as any);
export const useStore = () => useContext(StoreCtx);

export function useStoreValue(): Store {
  const [state, setState] = useState<AppState | null>(null);
  const [sched, setSched] = useState<SchedState | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [newMonitor, setNewMonitor] = useState<Store['newMonitor']>(null);
  const [mediaVersion, setMediaVersion] = useState(0);
  const seq = useRef(1);

  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = seq.current++;
    setToasts((xs) => [...xs.slice(-4), { ...t, id }]);
    setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== id)), t.kind === 'error' ? 9000 : 5200);
  }, []);
  const dismiss = useCallback((id: number) => setToasts((xs) => xs.filter((x) => x.id !== id)), []);
  const refresh = useCallback(async () => {
    const s = await api.invoke<AppState>('state');
    setState(s);
    setSched(s.scheduler);
  }, []);

  useEffect(() => {
    refresh().catch(() => {});
    api.invoke<Job[]>('jobs:list').then(setJobs).catch(() => {});
    const offs = [
      api.on('state', (s: AppState) => { setState(s); setSched(s.scheduler); }),
      api.on('scheduler', (s: SchedState) => setSched(s)),
      api.on('toast', (t: Omit<Toast, 'id'>) => toast(t)),
      api.on('monitor-new', (m) => setNewMonitor(m)),
      api.on('media-changed', () => setMediaVersion((v) => v + 1)),
      api.on('jobs', (list: Job[]) => setJobs(list)),
      api.on('job', (j: Job) => {
        setJobs((xs) => {
          const i = xs.findIndex((x) => x.id === j.id);
          if (i < 0) return [j, ...xs];
          const c = xs.slice(); c[i] = j; return c;
        });
        if (j.status === 'done') {
          if (j.kind === 'upscale' && j.result && j.result.skipped) toast({ kind: 'info', title: 'Upscale ignorado', message: `${j.title}: ${j.result.reason}` });
          else toast({ kind: 'ok', title: j.meta && j.meta.chatgpt ? 'Imagem do ChatGPT salva' : j.kind === 'upscale' ? 'Upscale concluído' : 'Concluído', message: j.title });
        }
        if (j.status === 'error') toast({ kind: 'error', title: 'Falhou: ' + j.title, message: j.error });
      }),
    ];
    return () => offs.forEach((o) => o());
  }, [refresh, toast]);

  const setGlobal = useCallback(async (patch: any) => {
    setState((s) => (s ? { ...s, config: { ...s.config, global: deepMerge(s.config.global, patch) } } : s));
    await api.invoke('config:global', patch);
  }, []);
  const setMonitor = useCallback(async (id: string, patch: Partial<MonitorCfg>) => {
    setState((s) => {
      if (!s) return s;
      const cur = s.config.monitors[id] || ({ id } as MonitorCfg);
      return { ...s, config: { ...s.config, monitors: { ...s.config.monitors, [id]: { ...cur, ...patch } } } };
    });
    await api.invoke('config:monitor', id, patch);
  }, []);

  return useMemo(() => ({
    state, sched, jobs, toasts, newMonitor, mediaVersion, toast, dismiss, refresh, setGlobal, setMonitor,
    clearNewMonitor: () => setNewMonitor(null),
  }), [state, sched, jobs, toasts, newMonitor, mediaVersion, toast, dismiss, refresh, setGlobal, setMonitor]);
}

function deepMerge(a: any, b: any): any {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a && typeof a[k] === 'object' ? deepMerge(a[k], v) : v;
  }
  return out;
}

// --- helpers -------------------------------------------------------------------
export function fmtDuration(sec: number) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); const s = sec % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}
export function fileName(p: string) { return p.split(/[\\/]/).pop() || p; }
export function folderName(p: string) { const parts = p.split(/[\\/]/).filter(Boolean); return parts[parts.length - 1] || p; }
export function fmtBytes(n?: number) {
  if (!n) return '';
  if (n > 1e9) return (n / 1e9).toFixed(1) + ' GB';
  if (n > 1e6) return (n / 1e6).toFixed(1) + ' MB';
  return Math.round(n / 1e3) + ' KB';
}

/** Shared with the main process (electron/transitions.json). */
export interface TransitionInfo { id: string; label: string; cat: string }
export const TRANSITION_LIST: TransitionInfo[] = TRANSITIONS.list;
export const TRANSITION_CATEGORIES: { id: string; label: string }[] = TRANSITIONS.categories;
export const TRANSITION_LABELS: Record<string, string> = {
  random: 'Aleatória',
  randomSoft: 'Aleatória suave',
  ...Object.fromEntries(TRANSITION_LIST.map((t) => [t.id, t.label])),
};
export const EASING_LABELS: Record<string, string> = {
  apple: 'Apple (padrão iOS)', spring: 'Mola suave', springBounce: 'Mola com balanço',
  easeInOutCubic: 'Suave', easeInOutQuint: 'Dramática', easeInOutExpo: 'Expo (cinema)', easeOutQuart: 'Desacelerar',
  easeOutExpo: 'Rápida e macia', easeInOutSine: 'Leve', easeOutBack: 'Com quique', linear: 'Linear',
};
export const FIT_LABELS: Record<string, string> = { cover: 'Preencher', contain: 'Ajustar (fundo desfocado)', stretch: 'Esticar', center: 'Centralizar 1:1' };
