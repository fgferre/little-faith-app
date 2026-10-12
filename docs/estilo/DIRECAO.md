# Direção visual — Noite do sorteio, versão afinada

Direção visual "Noite do sorteio", versão afinada (escolhas dele em 10 e 11/10) — referência viva em
`docs/estilo/direcao-visual.html` (configuração `estilo` do navegador), imagens `docs/estilo/noite-*.png`, ferramentas
`captura.mjs` (fotos) e `medir.mjs` (contraste, bordas, tamanhos, transbordo em 320/360/390):

- Fundo violeta quase preto (#130d20, com um brilho #2a1b3e só no alto), tinta branca quente #fff6ea, cartões em
  painel #1f172e com borda #3b2d4d (camadas, não transparência), navegação ativa em ouro #f6d7a3 com filete #d9b478
  (paleta da proposta "Noite em boa companhia", escolha dele em 12/10 com antes/depois); sem desfoque. Um efeito herói por tela: o brilho fica só no ouro. Botão principal chapado #5b43d6; botão
  secundário só com borda #7a74a8; barra de arrecadação chapada em verde-menta #3ee6a0.
- Bolas de metal polido (escolha dele, 11/10): prata para os números dos jogos, ouro para os sorteados e para os
  acertos de jogos premiados; jogo sem prêmio marca os acertos com um anel fino de ouro e a contagem apagada ("3
  acertos"). 32 px; 28 px abaixo de 360 px; o nome vai acima das bolas quando a fileira não cabe.
- Letras (escolha dele em 12/10, à noite, depois de ver o app lado a lado com a proposta do ChatGPT e achar o
  resultado "pobre"): Inter 400/500/600 no texto corrido e nos botões; Sora 500–800 em títulos, rótulos pequenos em
  caixa alta, números, dinheiro e bolas; Fraunces 600 (e itálico 500/600) só na marca ("little *faith*"), na frase da
  barra lateral e nas frases de emoção (capa: "boa companhia."; Sorteio: "Uma pequena dose de fé."; títulos do
  resultado). Tudo empacotado (`@fontsource`), funciona offline. Rótulos pequenos 12 px; corpo 15; nada abaixo de 12.
- O bolão como etapas tocáveis (montar → arrecadar → jogar → registrar → sorteio → dividir): a atual preenchida na cor
  da modalidade; feitas com ✓ apagado; a faixa rola com esmaecido nas bordas. Substitui as abas.
- Cores: a da modalidade só no selo e na etapa atual (Mega verde, Lotofácil rosa, Quina azul-céu). Estados: confirmado
  = ✓ menta com texto; pendência = âmbar #ff9f4a tracejado com relógio; problema = vermelho #ff8a97 em caixa tingida
  com alerta. Feito nunca é verde da modalidade.
- Telas desenhadas: Início com contagem para o sorteio e quem falta pagar; bolão antes (pendência e problema); vitória;
  sem prêmio ("Não foi dessa vez.", melhor jogo, próximo sorteio, "Repetir com a mesma turma"); Lotofácil (5×3) e
  Quina; cartão 4:5 para o WhatsApp sem dados de pagamento; formulário em gaveta; computador com barra lateral,
  faixa de etapas no topo e lista da divisão com chave Pix.
- Marca (12/10, escolha dele entre três, com imagem): o Laço da turma — quatro fitas (ouro, lavanda, lavanda-clara,
  ametista) amarradas num nó de ouro, em diagonal; pequeno vira um trevo de quatro folhas. Nas telas, a marca é a imagem 3D feita pelo
  ChatGPT (`src/assets/laco-3d-{120,240}.png`, 40 px, com sombra e giro leve ao passar o mouse); o vetor fica no
  favicon `apps/web/public/laco.svg`, nos ícones e na constante `LACO` (usada pelo cartão); ícones 192/512/maskable/apple em `apps/web/public`;
  o cartão do WhatsApp desenha o mesmo laço (`ui/cartao.ts`). Nome em Sora, sem letra serifada (escolha dele, 12/10). A
  comparação das três marcas fica em `.tmp/marca/comparacao.html` (apagável; os símbolos em `.tmp/marca/marcas.js`).
- Capa do Início (como a proposta, escolha dele em 12/10): "Seu bolão em / *boa companhia.*" em duas linhas (Sora
  500 29–43 px + Fraunces itálica dourada #f1cc89), linha "Os jogos, os pagamentos e a torcida. Tudo no mesmo lugar.",
  botão dourado "Acompanhar sorteio" (único botão de ouro do app; leva ao bolão da vez) e a cena 3D do ChatGPT
  (`src/assets/inicio-companhia-{900,1536}.jpg`) à direita no computador (capa de 332 px) e embaixo do texto no celular
  (faixa de 240 px; capa de ~480 px). Paralaxe de até 6 px só com mouse. "Faça sua fezinha…" vira a linha de rodapé
  da Início. A faixa de demonstração é uma linha leve no rodapé do conteúdo (texto e botão iguais), para a
  capa vir logo abaixo do cabeçalho; a barra lateral diz "Um pouco de fé. / Um cuidado de cada vez." em serifada; o
  cartão do WhatsApp desenha o laço 3D e o nome em Fraunces; o cartão "Sorteio em" ganhou o valor
  recebido, a barra menta e "N de M pessoas já pagaram"; a lista de bolões tem uma bola numerada por modalidade
  (dezenas de um jogo: 06, 15, 05).
- Palco do Sorteio: o cartão das dezenas tem fundo quente em degradê, arco de luz dourada, rótulo "A torcida é de
  todo mundo." e "Uma pequena dose de fé." em Fraunces; bolas de 56 px (44 no celular) centradas; esperando o
  resultado, a linha "Vamos conferir a sorte da turma?". Nada fica escondido atrás de clique (`src/sorteio.css`).
- Movimento: barra enchendo, bolas sorteadas caindo uma a uma, acertos pulsando, prêmio contando até o valor; nada
  ocioso; tudo desligado com movimento reduzido.
- Linguagem simples do item 9 em toda tela nova.

Como foi escolhida: três direções em imagem (10/10), a afinada adotada e as bolas de metal polido (11/10), tudo por
escolha dele. A referência viva é `direcao-visual.html`; `captura.mjs` e `medir.mjs` fotografam e medem a referência;
`scripts/visual/foto.mjs` e `medir.mjs` fazem o mesmo com o app de verdade.
