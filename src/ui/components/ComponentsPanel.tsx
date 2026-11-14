import { useEffect, useState } from 'react';
import { Check, Download, Trash2, Cpu } from 'lucide-react';
import { api, useStore } from '../api';
import { Btn } from './controls';

interface Comp { id: string; label: string; desc: string; size: number; installed: boolean; bundled: boolean; job: { progress?: number; stage?: string; error?: string } | null }

/** Optional AI packages: what is installed, download (with progress) or remove each one. */
export function ComponentsPanel() {
  const { toast } = useStore();
  const [list, setList] = useState<Comp[]>([]);
  useEffect(() => {
    api.invoke<Comp[]>('components:list').then(setList).catch(() => {});
    return api.on('components', (l: Comp[]) => setList(l));
  }, []);
  const mb = (b: number) => (b ? `${Math.round(b / 1048576)} MB` : '');
  const install = async (c: Comp) => {
    try { await api.invoke('components:install', c.id); } catch (e: any) {
      toast({ kind: 'error', title: 'O download falhou', message: String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') + ' Tente de novo: ele continua de onde parou.' });
    }
  };
  return (
    <div className="panel">
      <h3><Cpu size={16} /> Recursos de IA <span className="sub">baixados pelo app, ficam no seu PC</span></h3>
      <div className="stack" style={{ gap: 10 }}>
        {list.map((c) => (
          <div key={c.id} className={`comp ${c.installed ? 'on' : ''}`}>
            <div className="grow" style={{ minWidth: 0 }}>
              <b>{c.label}</b>
              <span className="small muted" style={{ display: 'block' }}>{c.desc}</span>
              {c.job && c.job.stage && <div className="comp-bar"><i style={{ width: `${Math.round((c.job.progress || 0) * 100)}%` }} /><span>{c.job.stage}</span></div>}
              {c.job && c.job.error && <span className="small" style={{ color: 'var(--danger)' }}>{c.job.error}</span>}
            </div>
            {c.installed
              ? (c.bundled ? <span className="chip-ok"><Check size={13} /> Instalado</span>
                : <><span className="chip-ok"><Check size={13} /> Instalado</span><Btn className="sm ghost icon" title="Remover (libera espaço; dá para baixar de novo)" onClick={() => api.invoke('components:remove', c.id)}><Trash2 size={13} /></Btn></>)
              : <Btn className="sm primary" disabled={!!(c.job && c.job.stage && !c.job.error)} onClick={() => install(c)}><Download size={13} /> Baixar {mb(c.size)}</Btn>}
          </div>
        ))}
        <span className="small muted">A IA local de expansão (FLUX.3 klein, cerca de 12 GB) é baixada no Editor, em Expandir → IA local.</span>
      </div>
    </div>
  );
}
