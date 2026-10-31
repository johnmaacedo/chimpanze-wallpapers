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
- 1.5.1: parallax em duas camadas (personagem + fundo refeito) com câmera em loop; página Monitores reorganizada; Upscale com seletor da galeria e confirmação; camada visual premium.
- 1.5.0: parallax 2.5D (Depth Anything V2 Small em `electron/ai/depth*.js`, mapas em cache em `%APPDATA%\Chimpanzé Wallpapers\depth`), chave geral na página Monitores; shaders compilam em segundo plano (KHR_parallel_shader_compile).
- Binários grandes (`resources/bin/upscaler`, `resources/models/lama.onnx`, `resources/models/depth-anything-v2-small.onnx`) ficam fora do Git; copie da instalação (`%LOCALAPPDATA%\Programs\ChimpanzeWallpapers\resources\`).
- O npm 11+ bloqueia scripts de instalação: depois de `npm install`, rode `node node_modules/electron/install.js` se o Electron não tiver baixado.

## Decisões do John
- Desistiu de wallpapers animados e de IA generativa local (expandir/reconstruir não funcionou).
- Borracha: só a rápida (LaMa). Edição pesada por IA: app desktop do ChatGPT com macros (o app novo é o pacote "OpenAI.Codex"; novo chat = Ctrl+N).
- Parallax: efeito permanente, ligado por padrão, com uma chave geral para todos os monitores na página Monitores (não em Ajustes). Quer movimento forte e dinâmico (câmera em loop), com o máximo de opções, e nada de borrado em volta do cabelo.
- Upscale: escolher da galeria do app por padrão e sempre confirmar antes de começar.
- Visual: quer a interface moderna, dinâmica e com cara premium.
- Quer zoom nas imagens do Editor e do Upscale e comparação antes/depois do upscale.
