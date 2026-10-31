# Instalação — Chimpanzé Wallpapers

## 1. Antes de começar
- **Windows 10 ou 11, 64 bits.**
- **Placa de vídeo com DirectX 12** (qualquer NVIDIA GTX 900 ou mais nova, AMD RX 400 ou mais nova, Intel Iris Xe/Arc). As IAs rodam na placa; sem ela, a profundidade usa o processador (mais lenta, ~1–2 s por imagem).
- **Espaço:** ~1,5 GB para o app instalado e mais um pouco para o cache de profundidade (até ~1200 arquivos pequenos).
- **Opcional:** o [aplicativo do ChatGPT para Windows](https://apps.microsoft.com/detail/9NT1R1C2HH7J) (Microsoft Store), se quiser usar a edição por IA do Editor.

## 2. Baixar
1. Abra a página **Releases** do projeto no GitHub.
2. Na versão mais recente, em **Assets**, baixe `Chimpanze-Wallpapers-Setup-<versão>.exe` (~590 MB, porque os modelos de IA vão junto).

## 3. Instalar
1. Dê dois cliques no instalador.
2. **Aviso do Windows SmartScreen** ("O Windows protegeu o computador"): o instalador não tem assinatura digital paga, por isso o aviso aparece. Clique em **Mais informações** → **Executar assim mesmo**.
3. Escolha a pasta (o padrão é `%LOCALAPPDATA%\Programs\ChimpanzeWallpapers`) e clique em **Instalar**.
4. No fim, deixe marcado **Executar Chimpanzé Wallpapers**.

Instalar uma versão nova por cima da antiga mantém todas as suas configurações, pastas e monitores. Não é preciso desinstalar antes.

## 4. Primeiro uso
1. Na página **Monitores**, clique no monitor e em **Escolher pasta de wallpapers**.
2. Pronto: o app troca o wallpaper sozinho no intervalo escolhido, com transição.
3. A **Profundidade 3D** já vem ligada. Na primeira imagem leva uns segundos até a IA carregar; depois cada imagem é preparada em ~1–5 s, antes de aparecer.
4. Para iniciar com o Windows: **Ajustes** → **Iniciar com o Windows**.

## 5. Atualizar
Baixe o instalador da versão nova e rode por cima. O app fecha sozinho, atualiza e abre de novo.

## 6. Desinstalar
**Configurações do Windows** → **Aplicativos** → **Chimpanzé Wallpapers** → **Desinstalar**. Suas configurações ficam em `%APPDATA%\Chimpanzé Wallpapers` (apague a pasta se quiser remover tudo). Ao sair, o app deixa a última imagem como wallpaper oficial do Windows.

## 7. Problemas comuns
| Sintoma | O que fazer |
|---|---|
| O wallpaper fica preto ou não aparece | Clique em **Detectar monitores** na página Monitores. Se persistir, feche o app pela bandeja e abra de novo. |
| A profundidade não liga ("Falta o modelo") | Reinstale: os modelos ficam em `resources\models` dentro da pasta do app. |
| Profundidade lenta | Confira se a placa de vídeo está com driver atualizado (o app usa DirectX 12 / DirectML). |
| Algum personagem fica estranho com a profundidade | Use o preset **Automático** com Intensidade 100% (limite seguro). Acima de 100% podem aparecer marcas atrás do cabelo. |
| Quero menos movimento | Diminua **Intensidade** ou **Velocidade**, ou escolha o movimento **Respiração**. |
| O Editor não abre o ChatGPT | Instale o aplicativo do ChatGPT pela Microsoft Store e entre na sua conta. |
| Jogo em tela cheia com queda de FPS | **Ajustes** → **Pausar em tela cheia** (vem ligado). |

Os registros ficam em `%APPDATA%\Chimpanzé Wallpapers\logs\chimpanze-wallpapers.log`. Eles ajudam a entender qualquer problema.
