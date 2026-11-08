# Como usar

## Monitores
- **Mapa dos monitores:** clique em um monitor para configurá-lo. Cada um tem pasta, intervalo e transição próprios.
- **Pasta e imagem atual:** troque a pasta, avance (**Próximo**), volte, ou **Fixe** uma imagem.
- **Transição:** prévia ao vivo com o shader real. Escolha **Padrão do app**, **Aleatória** (as 75), **Aleatória suave** ou **Escolher uma** (abre a lista por categoria: Suaves, Movimento, 3D, Formas, Energia). Ajuste duração e curva.
- **Profundidade 3D** (vale para todos os monitores):
  - **Preset:**
    - **Automático** (recomendado): analisa cada imagem e usa a receita certa para ela;
    - **Anime**, **Paisagem**, **Pessoas reais**: forçam a receita do tipo, sempre com o limite seguro de cada imagem;
    - **Manual**: tudo livre, sem limite automático.
  - **Intensidade:** 100% = o limite seguro, sem marcas. Acima disso o movimento fica maior, com risco de marcas atrás do cabelo.
  - **Velocidade** do loop da câmera.
  - **Movimento:** Automático, Órbita, Caminhada, Travelling, Aproximação, Flutuar, Respiração ou Balanço.
  - **A cena também segue o mouse.**
  - **Piscar dos olhos** (botão próprio, logo abaixo da chave da Profundidade 3D; funciona mesmo com a profundidade desligada): cada rosto de anime pisca no seu ritmo, a cada 2,5–7 s (às vezes piscada dupla; raramente uma piscadela). O olho fecha por inteiro: a pálpebra e os cílios de cima descem até a pálpebra de baixo. Só pisca o rosto em que o efeito fica natural: os dois olhos visíveis e de tamanhos parecidos, cabeça não muito inclinada nem virada, olhos não gigantes e não desenhados já fechados.
- **3D por imagem e "Refazer recorte"** (no cartão do wallpaper atual de cada monitor e na Galeria, ao abrir uma imagem):
  - **3D nesta imagem:** desliga a profundidade só naquele wallpaper (ele fica parado, mas ainda pisca); os outros continuam em 3D. Na Galeria, a imagem ganha a etiqueta "3D off".
  - **Refazer recorte:** se o personagem ficou mal separado do fundo, clique e a IA recorta de outro jeito; o monitor muda sozinho em alguns segundos. São 6 tentativas, em ordem: recorte justo, recorte folgado (pega fios de cabelo), só a parte mais próxima do personagem, pela profundidade, personagem + objetos próximos (armas, mãos) e sem recorte (a imagem se move inteira, suave). **Anterior** volta uma tentativa e **Automático** volta ao começo. A escolha fica guardada para aquela imagem (etiqueta "Recorte N" na Galeria).
  - **Ver o recorte na imagem** (Galeria): mostra o personagem em destaque, o fundo escurecido e o contorno do recorte em laranja, para julgar cada tentativa.
- **Troca automática:** intervalo (de 30 s a 1 dia, ou personalizado), ordem aleatória ou em sequência, subpastas.
- **Enquadramento:** Preencher, Ajustar (fundo desfocado), Esticar ou Centralizar; Ken Burns (zoom lento).

## Galeria
Veja os wallpapers das pastas do app, aplique em qualquer monitor, compare antes/depois do 4K e mande para o Editor. Ao abrir uma imagem: **Profundidade 3D nesta imagem**, **Refazer recorte** e **Ver o recorte na imagem**.

## Upscale 4K
1. **Escolher da galeria** (padrão), **Do computador** ou **Pasta inteira**.
2. Confira a **confirmação**: tipo de imagem, tamanho final e formato. Clique **Iniciar upscale**.
3. Acompanhe na **Fila**. O original nunca muda: a versão nova vai para a subpasta `_4K` e passa a ser usada nos monitores.

## Editor
Ajustes (exposição, contraste, cor, nitidez…), recorte, **borracha** de marca d'água por IA e **edição pelo ChatGPT** (Expandir para o formato do monitor, Remover objeto, Melhorar, Livre). Essa última exige o app do ChatGPT instalado; o Chimpanzé cola a imagem e o pedido e pega o resultado quando você baixar ou copiar a imagem.

- **Abrir:** do computador (**Abrir**) ou da galeria do app (**Da galeria**).
- **Colar** (aba nova): coloca outra imagem por cima da que está aberta. Serve, por exemplo, para pôr o original de volta no centro de uma expansão do ChatGPT (quando você escondeu o centro para o ChatGPT não censurar):
  1. Abra a imagem expandida.
  2. Na aba **Colar**, importe o original **do computador**, **da galeria** ou **colando** uma imagem copiada (Ctrl+V).
  3. Ela já entra no centro, com a altura toda. Ajuste se precisar:
     - **Encaixes prontos:** Centro com altura toda, Centro com largura toda, Centralizar (sem mudar o tamanho), Tamanho real (1 pixel = 1 pixel) e Cobrir tudo;
     - **Alinhar:** encostar à esquerda, à direita, em cima ou embaixo, centro na horizontal ou na vertical, espelhar e endireitar;
     - **Com o mouse:** arraste para mover (gruda no centro e nas bordas; Alt solta o ímã), puxe os cantos para o tamanho e a bolinha de cima para girar (Shift = de 15 em 15°);
     - **Pelo teclado e pelos controles:** setas movem 1 px (Shift = 10 px); Tamanho e Rotação também têm controle deslizante;
     - **Ver através:** deixa a imagem colada transparente só para alinhar (o resultado sai sem transparência);
     - **Bordas suaves:** a beirada da imagem colada se mistura com a de baixo.
  4. **Aplicar** (Enter) junta as duas em resolução total. **Desfazer** (Ctrl+Z) volta; **Cancelar** (Esc) descarta.

## Ajustes
Iniciar com o Windows, pausar em tela cheia ou atrás de janela maximizada, wallpaper oficial do Windows ao sair, transição padrão e intensidade dos efeitos, transições usadas no modo aleatório, "Reduzir movimento", opções do ChatGPT e **Atalhos**.

### Atalhos de teclado
Funcionam em qualquer programa, mesmo com o app minimizado ou só na bandeja. Agem no monitor onde está o **mouse**; o mesmo atalho com **Alt** junto vale para **todos os monitores** (ex.: Ctrl+Shift+Alt+N).

| Ação | Padrão |
|---|---|
| Próximo wallpaper (se estiver fixado, solta e troca) | Ctrl+Shift+N |
| Wallpaper anterior | Ctrl+Shift+B |
| Fixar / soltar o wallpaper atual | Ctrl+Shift+F |
| Pausar / retomar as trocas automáticas | Ctrl+Shift+Espaço |
| Profundidade 3D liga/desliga | Ctrl+Shift+D |
| Piscar dos olhos liga/desliga | Ctrl+Shift+P |
| 3D só no wallpaper atual liga/desliga | Ctrl+Shift+3 |
| Refazer o recorte do wallpaper atual (próxima tentativa) | Ctrl+Shift+X |
| Mostrar / esconder o app | Ctrl+Alt+W |

Em **Ajustes > Atalhos** você liga/desliga cada um, troca a combinação (clique nas teclas e aperte a nova; Esc cancela, Backspace deixa sem atalho) e volta tudo com **Restaurar padrão**. Pausar, fixar e os liga/desliga mostram um aviso rápido do Windows (dá para desligar em "Mostrar aviso"). Se outro programa já usa uma combinação, o atalho fica marcado em vermelho com o aviso: grave outra.

Observação: enquanto o app está aberto, essas combinações deixam de chegar aos outros programas (ex.: Ctrl+Shift+N do Chrome abre aba anônima). Se precisar de alguma delas em outro programa, troque ou desligue aqui.
