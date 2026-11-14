import { useStore } from '../api';

/**
 * The app icon: John's mascot (the girl in the monkey hood holding a wallpaper),
 * in the version made for the current theme (light / dark / brown). The three
 * pictures live in src/public (cut from assets/icons); the Windows icon and the
 * tray use the brown one.
 */
export function Logo({ size = 24, className = '' }: { size?: number; className?: string }) {
  const { state } = useStore();
  const theme = state?.config.global.theme || 'cocoa';
  const name = theme === 'light' ? 'light' : theme === 'dark' ? 'dark' : 'cocoa';
  return <img className={`logo-mark ${className}`} src={`./logo-${name}.png`} width={size} height={size} alt="" draggable={false} />;
}
