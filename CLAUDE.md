# Chimpanzé Wallpapers — guia para o Claude Code

App pessoal do John (Electron 44 + React 19 + Vite + TypeScript, Windows). Leia o `README.md`.

## Como o John trabalha
- Não é programador experiente: explique em português simples e faça as mudanças por ele.
- Entrega desejada: instalador `.exe`. Quer o mínimo de RAM/VRAM e tudo local na RTX 5070, exceto a edição por IA (app do ChatGPT).
- Logo: waifu loira com capuz de macaco segurando uma placa de wallpaper (`assets/`).

## Situação do código
- O código-fonte original da 1.4.0 se perdeu; foi recuperado do instalador.
- `electron/` é o da 1.4.0 (JS legível, completo).
- `src/` foi reconstruído a partir da interface 1.4.0 compilada (`referencia-1.4.0-ui/`, só para consulta): páginas Monitores, Galeria, Editor, Upscale e Ajustes; motor de transições (`src/wallpaper/`), hoje com 75 transições (1.5.0); `src/hub.html` (página escondida que abre as janelas de wallpaper). O CSS gerado é idêntico ao da 1.4.0.
- Editor: pipeline WebGL em `src/ui/editor/gl.ts`; página em `src/ui/pages/Editor.tsx`.
- 1.5.9: Colar limpa os restos de tinta em volta da pintura (`halo` em `PasteOpts`: perto da tinta, pixel mais próximo da cor da tinta que o original conta como tinta). Salvar do Editor: imagem da galeria (`inGallery` em main.js) é atualizada no lugar (+ versão _4K; original guardado em `_Backup`, ignorado pela biblioteca); fora da galeria abre "Salvar como"; o lote "aplicar na pasta" continua em _Editado (`mode: edited`).
- 1.5.8: Colar refeito. `electron/align-worker.js` (worker_threads, IPC `editor:autoAlign`) acha escala/posição/esticado vertical por NCC em pirâmide e refina só onde as imagens concordam (~4 s). `src/ui/editor/composite.ts` faz prévia e resultado iguais: perspectiva por homografia (cantos), cor local (campo suave da diferença onde concordam), modo "Só a parte pintada" (cor do pincel `PAINT_RGB` ou área lisa, colorida e diferente). Aba **Pintar** (pincel de cor única, 4–2000 px, apagar, desfazer traço). Teste real: expansão do ChatGPT da Ada, encaixe 718×1072 em 489,-72, sem emenda.
- 1.5.7: Editor abre da galeria (`GalleryPicker` com `single`) e ganhou a aba **Colar** (`src/ui/editor/PasteLayer.tsx`): camada por cima com posição normalizada (`Layer`), encaixes `placeLayer` (entra como `fitH`/`fitW` por `initialLayer`), ímã no centro/bordas, girar, espelhar, ver através, bordas suaves; `bakeLayer` junta em resolução total num arquivo de trabalho (`editor:writeTemp`) e entra no desfazer. Ctrl+V cola da área de transferência (`editor:clipboardImage`).
- 1.5.6: 3D por imagem e "Refazer recorte". `config.data.images[caminho minúsculo] = { depth: false, cut: n }` (`config.image/setImage`); variantes de recorte 0–6 em `estimate(img, out, variant)` (`CUTS` em `electron/ai/depth.js`, cache separado por variante); `scheduler.recut/redisplayFile/imgDepth`; IPC `image:depth`, `image:depth:set`, `image:recut`, `image:cutPreview`; `parOff` por mídia no `Engine`. UI em `src/ui/components/DepthImage.tsx` (cartão do monitor, Lightbox da Galeria, etiquetas no Tile). Atalhos Ctrl+Shift+3 e Ctrl+Shift+X.
- 1.5.5: atalhos globais (`electron/shortcuts.js`, `globalShortcut`; config `global.shortcuts` = enabled/notify/allWithAlt/keys/off). Agem no monitor sob o mouse (`cursorMonitor()`), +Alt = todos; avisos por `feedback()` (toast no app se ele está em foco, senão notificação do Windows). `setGlobal`/`setMonitor`/`setPaused` em `main.js` servem o IPC e os atalhos. Seção Atalhos em Ajustes (`src/ui/components/ShortcutsPanel.tsx`) grava teclas com `shortcuts:suspend`. Padrões evitam Ctrl+N/Ctrl+V/Ctrl+Shift+O (o app digita no ChatGPT).
- 1.5.4: piscar com botão próprio ("Piscar dos olhos", `parallaxBlink`) que funciona com a profundidade desligada (`scheduler.depthOn()` busca os mapas para parallax OU piscar; o `Engine` dorme entre piscadas com `blinkWake`). Moldura do olho maior (cílio de cima dentro), faixa dos cílios = banda mais escura na metade de cima, desce até 80% da moldura; o que não é cílio (claro ou colorido) vira pele. Rostos com olhos de tamanhos > 1,5x não piscam. Cache da profundidade VERSION 5.
- 1.5.3: rostos de anime detectados (deepghs, `anime-face-v1.4n.onnx`) ficam rígidos no parallax; olhos (`anime-eye-v1.0n.onnx`) piscam com pálpebras geradas pela LaMa, só em rostos validados (2 olhos, inclinação ≤ 35°, tamanhos/aberturas parecidos, olho não gigante); estilos de movimento nos presets (`parallaxMotion`) incluindo Respiração e Balanço. Guias em `docs/`. Validação feita numa bancada (página Vite com o `Engine` + quadros capturados nos extremos da câmera e com o piscar forçado).
- 1.5.2: recorte por IA de anime (`anime-seg-isnetis.onnx`, fora do Git) + análise por imagem (`analyse()` em `electron/ai/depth-core.js`, salva em `.json` no cache) + presets (receitas `RECIPES` e limite `safeBand` em `src/wallpaper/engine.ts`). Para testar o efeito sem abrir o app: gerar mapas com `electron/ai/depth` e renderizar o `Engine` numa página do Vite capturando quadros nas fases extremas da câmera.
- 1.5.1: parallax em duas camadas (personagem + fundo refeito) com câmera em loop; página Monitores reorganizada; Upscale com seletor da galeria e confirmação; camada visual premium.
- 1.5.0: parallax 2.5D (Depth Anything V2 Small em `electron/ai/depth*.js`, mapas em cache em `%APPDATA%\Chimpanzé Wallpapers\depth`), chave geral na página Monitores; shaders compilam em segundo plano (KHR_parallel_shader_compile).
- Binários grandes (`resources/bin/upscaler`, `resources/models/lama.onnx`, `resources/models/depth-anything-v2-small.onnx`, `resources/models/anime-seg-isnetis.onnx`, `resources/models/anime-face-v1.4n.onnx`, `resources/models/anime-eye-v1.0n.onnx`) ficam fora do Git; copie da instalação (`%LOCALAPPDATA%\Programs\ChimpanzeWallpapers\resources\`).
- O npm 11+ bloqueia scripts de instalação: depois de `npm install`, rode `node node_modules/electron/install.js` se o Electron não tiver baixado.

## Decisões do John
- Desistiu de wallpapers animados e de IA generativa local (expandir/reconstruir não funcionou).
- Borracha: só a rápida (LaMa). Edição pesada por IA: app desktop do ChatGPT com macros (o app novo é o pacote "OpenAI.Codex"; novo chat = Ctrl+N).
- Parallax: efeito permanente, ligado por padrão, com uma chave geral para todos os monitores na página Monitores (não em Ajustes). Quer movimento forte e dinâmico (câmera em loop), com o máximo de opções, e nada de borrado em volta do cabelo.
- Upscale: escolher da galeria do app por padrão e sempre confirmar antes de começar.
- Visual: quer a interface moderna, dinâmica e com cara premium.
- Rosto dos personagens nunca pode deformar; piscar só onde fica natural. Ideia futura: música-tema ambiente por anime (pediu diagnóstico antes de implementar).
- Quer zoom nas imagens do Editor e do Upscale e comparação antes/depois do upscale.
