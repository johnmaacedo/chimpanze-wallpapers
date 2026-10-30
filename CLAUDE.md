# Chimpanzé Wallpapers — guia para o Claude Code

App pessoal do John (Electron 44 + React 19 + Vite + TypeScript, Windows). Leia o `README.md`.

## Como o John trabalha
- Não é programador experiente: explique em português simples e faça as mudanças por ele.
- Entrega desejada: instalador `.exe`. Quer o mínimo de RAM/VRAM e tudo local na RTX 5070, exceto a edição por IA (app do ChatGPT).
- Logo: waifu loira com capuz de macaco segurando uma placa de wallpaper (`assets/`).

## ⚠️ Situação do código (importante)
- O código-fonte original da 1.4.0 se perdeu; foi recuperado do instalador.
- `electron/` **é o da 1.4.0** (JS legível, completo).
- `src/` (interface) **ainda é o da 1.0.0**: tem a página `Animated.tsx` e chamadas de API que não existem mais.
- `referencia-1.4.0-ui/` tem a interface 1.4.0 compilada e minificada.
- **Primeira tarefa sugerida:** atualizar `src/ui` para bater com a 1.4.0 — remover Animados; criar/ajustar as páginas Editor (ajustes de imagem, borracha LaMa, envio ao ChatGPT), Upscale (zoom + antes/depois) e Galeria (Estáticos/Editados), usando `electron/preload.js`/`main.js` como contrato das APIs e a interface compilada como referência visual.

## Decisões do John
- Desistiu de wallpapers animados e de IA generativa local (expandir/reconstruir não funcionou).
- Borracha: só a rápida (LaMa). Edição pesada por IA: app desktop do ChatGPT com macros.
- Quer zoom nas imagens do Editor e do Upscale e comparação antes/depois do upscale.
