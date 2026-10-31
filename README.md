# Chimpanzé Wallpapers — v1.5.0

Wallpapers independentes por monitor, com transições em GPU estilo motion design, profundidade 3D (parallax), upscale 4K com IA na GPU e um editor de imagem estática. Sucessor do script "WallpaperPorMonitor V5".

## O que a 1.5.0 faz
- Pasta, timer e transição por monitor; detecção ao iniciar, pelo botão e ao vivo (hot-plug), com ID do monitor por EDID.
- 75 transições WebGL2 (`src/wallpaper/shaders.ts`, catálogo em `electron/transitions.json`), com borrão de movimento automático nas que deslizam/giram, curvas de mola/Apple e compilação dos shaders em segundo plano (sem engasgo no início). Ken Burns, modo compacto/transparente.
- **Profundidade 3D (parallax)**: Depth Anything V2 Small (ONNX, Apache-2.0) calcula a profundidade de cada imagem uma vez (GPU via DirectML, CPU de reserva) e o motor desloca as camadas com oclusão, seguindo uma deriva lenta e o mouse. Chave geral na página Monitores. Código em `electron/ai/depth*.js` e no motor (`src/wallpaper/engine.ts`).
- Upscale 4K/5K/8K (Real-ESRGAN ncnn-Vulkan) com modelos de anime e foto, zoom e comparação antes/depois.
- Editor: exposição, contraste, brancos, claridade, balanço de branco, nitidez, debanding etc.
- Borracha de marca d'água rápida: LaMa em ONNX (`electron/ai/lama*.js`, `onnxruntime-node`).
- Edição por IA via **app desktop do ChatGPT** (conta grátis) com macros (`electron/chatgpt.js`), nunca pelo navegador. Avisa na tela quando o app não está instalado.
- Foco em pouca RAM/VRAM: as IAs locais rodam em processos separados que fecham sozinhos quando ficam ociosos. A parte de wallpapers animados e a IA generativa local (ComfyUI/Wan, Ollama) foram **removidas**.

## Estrutura
```
electron/              processo principal
src/                   interface React/TypeScript e motor das transições/parallax
referencia-1.4.0-ui/   interface 1.4.0 compilada (minificada), só para consulta
build/, resources/, assets/   ícones e logo
```

## Compilar
```
npm install
npm run dist:win
```
Binários fora do Git (copie da instalação em `%LOCALAPPDATA%\Programs\ChimpanzeWallpapers\resources\`):
`bin/upscaler/` (realesrgan-ncnn-vulkan + modelos), `models/lama.onnx` e `models/depth-anything-v2-small.onnx`
(este último também em huggingface.co/onnx-community/depth-anything-v2-small, arquivo `onnx/model_fp16.onnx`).

## Arquivos do usuário
- Configuração: `%APPDATA%\Chimpanzé Wallpapers\config.json` · Logs: `%APPDATA%\Chimpanzé Wallpapers\logs\`
- Mapas de profundidade (cache, até 600): `%APPDATA%\Chimpanzé Wallpapers\depth\`
