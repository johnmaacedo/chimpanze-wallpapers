# Chimpanzé Wallpapers — v1.4.0 (otimizada)

Wallpapers independentes por monitor, com transições em GPU estilo motion design, upscale 4K com IA na GPU e um editor de imagem estática. Sucessor do script "WallpaperPorMonitor V5".

## O que a 1.4.0 faz
- Pasta, timer e transição por monitor; detecção ao iniciar, pelo botão e ao vivo (hot-plug), com ID do monitor por EDID.
- Transições WebGL2 (Cubo 3D, Cover Flow, Glitch, Deslize parallax e outras), Ken Burns, modo compacto/transparente.
- Upscale 4K/5K/8K (Real-ESRGAN ncnn-Vulkan) com modelos de anime e foto, zoom e comparação antes/depois.
- Editor: exposição, contraste, brancos, claridade, balanço de branco, nitidez, debanding etc.
- Borracha de marca d'água rápida: LaMa em ONNX (`electron/ai/lama*.js`, `onnxruntime-node`).
- Edição por IA via **app desktop do ChatGPT** (conta grátis) com macros (`electron/chatgpt.js`), nunca pelo navegador.
- Foco em pouca RAM/VRAM. A parte de wallpapers animados e a IA generativa local (ComfyUI/Wan, Ollama) foram **removidas**.

## Estrutura
```
electron/              processo principal — código da 1.4.0 (completo)
src/                   interface React/TypeScript (reconstruída da 1.4.0) e motor das transições
referencia-1.4.0-ui/   interface 1.4.0 compilada (minificada), só para consulta
build/, resources/, assets/   ícones e logo
```

## Compilar
```
npm install
npm run dist:win
```
Binários fora do Git (copie da instalação em `%LOCALAPPDATA%\Programs\ChimpanzeWallpapers\resources\`):
`bin/upscaler/` (realesrgan-ncnn-vulkan + modelos) e `models/lama.onnx`.

## Arquivos do usuário
- Configuração: `%APPDATA%\Chimpanzé Wallpapers\config.json` · Logs: `%APPDATA%\Chimpanzé Wallpapers\logs\`
