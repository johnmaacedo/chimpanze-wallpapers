# Compilar a partir do código

## Requisitos
- Windows 10/11 x64
- [Node.js](https://nodejs.org/) 22 ou mais novo (com npm)
- Git

## 1. Código e dependências
```
git clone <url-do-repositório>
cd chimpanze-wallpapers
npm install
```
O npm 11+ bloqueia scripts de instalação. Se o Electron não tiver sido baixado (`node_modules/electron/dist` vazio), rode:
```
node node_modules/electron/install.js
```

## 2. Arquivos grandes (fora do Git)
Coloque estes arquivos em `resources/` (o instalador os inclui):

| Caminho | Origem |
|---|---|
| `resources/models/depth-anything-v2-small.onnx` | huggingface.co/onnx-community/depth-anything-v2-small, arquivo `onnx/model_fp16.onnx` |
| `resources/models/anime-seg-isnetis.onnx` | huggingface.co/skytnt/anime-seg, arquivo `isnetis.onnx` |
| `resources/models/anime-face-v1.4n.onnx` | huggingface.co/deepghs/anime_face_detection, `face_detect_v1.4_n/model.onnx` |
| `resources/models/anime-eye-v1.0n.onnx` | huggingface.co/deepghs/anime_eye_detection, `eye_detect_v1.0_n/model.onnx` |
| `resources/models/lama.onnx` | LaMa em ONNX (borracha). Copie de uma instalação: `%LOCALAPPDATA%\Programs\ChimpanzeWallpapers\resources\models\` |
| `resources/bin/upscaler/` | realesrgan-ncnn-vulkan + modelos. Copie da instalação: `...\resources\bin\upscaler\` |

Sem um modelo, a função correspondente é desligada com aviso; o resto do app funciona.

## 3. Rodar e gerar o instalador
```
npm run build:ui        # compila a interface (Vite → dist/)
npm start               # abre o app em modo de desenvolvimento
npm run typecheck       # checagem de tipos
npm run dist:win        # gera release/Chimpanze-Wallpapers-Setup-<versão>.exe
```
Abrir com `--dev-visible` mostra as janelas de wallpaper como janelas normais, sem colar na área de trabalho (útil para testes).

## 4. Estrutura
```
electron/               processo principal (monitores, agendador, janelas de wallpaper, IA)
  ai/depth*.js          profundidade, recorte, rostos/olhos, análise e cache (processo separado)
  ai/lama*.js           borracha LaMa (processo separado)
  chatgpt.js            automação do app do ChatGPT
  transitions.json      catálogo das 75 transições
src/ui/                 interface React/TypeScript (páginas Monitores, Galeria, Editor, Upscale, Ajustes)
src/wallpaper/          motor WebGL2: transições (shaders.ts), parallax, piscar (engine.ts)
docs/                   guias
```

## 5. Como a profundidade funciona
1. **Uma vez por imagem** (processo separado que fecha sozinho quando fica ocioso):
   - Depth Anything V2 estima a profundidade;
   - o modelo de anime recorta os personagens;
   - os detectores acham rostos e olhos;
   - a LaMa refaz o fundo atrás dos personagens e a pele no lugar dos olhos (pálpebras);
   - uma análise mede o tipo da imagem e o limite seguro de movimento.
   Tudo vai para o cache em `%APPDATA%\Chimpanzé Wallpapers\depth\`.
2. **A cada quadro** (shader em `src/wallpaper/shaders.ts`):
   - o fundo e os personagens se movem em camadas, com o rosto rígido;
   - a câmera segue o caminho escolhido, limitado pela análise (`RECIPES` e `safeBand` em `engine.ts`);
   - o piscar desce a linha dos cílios na direção da inclinação do rosto.
