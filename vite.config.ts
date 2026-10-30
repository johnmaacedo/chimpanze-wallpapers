import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  root: resolve(__dirname, 'src'),
  base: './',
  publicDir: resolve(__dirname, 'src/public'),
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'chrome130',
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/index.html'),
        wallpaper: resolve(__dirname, 'src/wallpaper.html'),
        overlay: resolve(__dirname, 'src/overlay.html'),
        // Hidden page that opens every wallpaper window (they share one renderer process).
        hub: resolve(__dirname, 'src/hub.html'),
      },
    },
  },
});
