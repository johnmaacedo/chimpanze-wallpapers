import { motion } from 'motion/react';
import { GLIDE, SNAP } from '../motion';
import { useId, type ReactNode } from 'react';

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button className={`toggle ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
      <motion.span className="knob" initial={false} animate={{ x: on ? 18 : 0 }} transition={SNAP} />
    </button>
  );
}

export function SwitchRow({ title, desc, on, onChange }: { title: string; desc?: ReactNode; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="switch-row">
      <div className="txt"><b>{title}</b>{desc && <span>{desc}</span>}</div>
      <Toggle on={on} onChange={onChange} label={title} />
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  const id = useId();
  return (
    <div className="seg" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'on' : ''} role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}>
          {o.value === value && <motion.span layoutId={`seg-${id}`} className="seg-pill" transition={GLIDE} />}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Btn({ children, className = '', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <motion.button whileHover={{ y: -1, scale: 1.015 }} whileTap={{ scale: 0.95, y: 0 }} transition={SNAP}
      className={`btn ${className}`} {...(rest as any)}>
      {children}
    </motion.button>
  );
}

export function Ring({ fraction, label, size = 38 }: { fraction: number; label: string; size?: number }) {
  const r = size / 2 - 3;
  const c = 2 * Math.PI * r;
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <defs>
          <linearGradient id="ringg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffcf6e" /><stop offset="1" stopColor="#ff6f61" />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} style={{ fill: "rgb(from var(--cocoa-0) r g b / 0.7)", stroke: "rgb(from var(--tint) r g b / 0.15)" }} strokeWidth="3" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="url(#ringg)" strokeWidth="3" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0, Math.min(1, fraction)))} />
      </svg>
      <div className="lbl">{label}</div>
    </div>
  );
}
