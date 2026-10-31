# Chimpanzé Wallpapers — v1.5.2

Wallpapers independentes por monitor, com transições em GPU estilo motion design, profundidade 3D (parallax), upscale 4K com IA na GPU e um editor de imagem estática. Sucessor do script "WallpaperPorMonitor V5".

## O que a 1.5.2 faz
- Pasta, timer e transição por monitor; detecção ao iniciar, pelo botão e ao vivo (hot-plug), com ID do monitor por EDID.
- 75 transições WebGL2 (`src/wallpaper/shaders.ts`, catálogo em `electron/transitions.json`), com borrão de movimento automático nas que deslizam/giram, curvas de mola/Apple e compilação dos shaders em segundo plano (sem engasgo no início). Ken Burns, modo compacto/transparente.
- **Profundidade 3D (parallax)**, ligada por padrão: Depth Anything V2 Small (ONNX, Apache-2.0) calcula a profundidade de cada imagem uma vez (GPU via DirectML, CPU de reserva). A imagem vira duas camadas: os personagens (máscara suave que segue o cabelo) e o fundo, refeito onde eles estavam (LaMa quando o personagem é pequeno, preenchimento suave quando é grande), então nada fica borrado quando a câmera anda. A câmera passeia em loop (Órbita, Caminhada, Travelling, Aproximação, Flutuar), com intensidade, velocidade, aproximação, ponto de foco, desfoque do fundo e mouse ajustáveis na página Monitores. Código em `electron/ai/depth*.js` e no motor (`src/wallpaper/engine.ts`).
- 1.5.2: recorte dos personagens pelo modelo de anime (SkyTNT anime-segmentation, ISNet, Apache-2.0, `resources/models/anime-seg-isnetis.onnx`) e análise de cada imagem (anime / foto / paisagem, quantos personagens, cabelo solto, fundo detalhado, distância entre personagem e fundo). Presets Automático, Anime, Paisagem, Pessoas reais e Personalizado: nos presets, a câmera é limitada para que a faixa revelada atrás dos personagens não passe do limite seguro medido em cada imagem (Intensidade 100% = esse limite). Calibrado numa bancada de 26 wallpapers (14 anime, 5 paisagens, 7 pessoas reais/realistas).
- Upscale escolhe imagens da própria galeria do app (ou do computador / pasta inteira) e sempre pede confirmação antes de começar.
- Interface 1.5.1: visual mais moderno (camada "premium skin" no fim de `src/ui/styles.css`), página Monitores reorganizada e miniaturas dos monitores proporcionais em qualquer tamanho de janela.
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
`bin/upscaler/` (realesrgan-ncnn-vulkan + modelos), `models/lama.onnx`, `models/anime-seg-isnetis.onnx`
(huggingface.co/skytnt/anime-seg, `isnetis.onnx`) e `models/depth-anything-v2-small.onnx`
(este último também em huggingface.co/onnx-community/depth-anything-v2-small, arquivo `onnx/model_fp16.onnx`).

## Arquivos do usuário
- Configuração: `%APPDATA%\Chimpanzé Wallpapers\config.json` · Logs: `%APPDATA%\Chimpanzé Wallpapers\logs\`
- Mapas de profundidade + fundos refeitos (cache, até 1200 arquivos): `%APPDATA%\Chimpanzé Wallpapers\depth\`
