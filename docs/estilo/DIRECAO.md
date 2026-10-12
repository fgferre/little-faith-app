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
- Letra Sora, empacotada no app (funciona offline): rótulos pequenos 12 px caixa alta espaçada; corpo 15; secundário
  13; título 28; dinheiro 44 tabular; prêmio 48 em ouro. Nada abaixo de 12 px.
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
  ametista) amarradas num nó de ouro, em diagonal; pequeno vira um trevo de quatro folhas. Vetor em
  `apps/web/public/laco.svg` (favicon) e no componente `BrandMark`; ícones 192/512/maskable/apple em `apps/web/public`;
  o cartão do WhatsApp desenha o mesmo laço (`ui/cartao.ts`). Nome em Sora, sem letra serifada (escolha dele, 12/10). A
  comparação das três marcas fica em `.tmp/marca/comparacao.html` (apagável; os símbolos em `.tmp/marca/marcas.js`).
- Capa do Início: a cena 3D feita pelo ChatGPT (`src/assets/inicio-companhia-{900,1536}.jpg`, ~60 e ~170 KB) no canto
  de cima à direita no celular (capa de até 280 px) e à direita no computador (280 px), esmaecida por máscara; a frase
  "Faça sua fezinha…" é o título; paralaxe de até 6 px só com mouse, nada no toque nem com movimento reduzido.
- Movimento: barra enchendo, bolas sorteadas caindo uma a uma, acertos pulsando, prêmio contando até o valor; nada
  ocioso; tudo desligado com movimento reduzido.
- Linguagem simples do item 9 em toda tela nova.

Como foi escolhida: três direções em imagem (10/10), a afinada adotada e as bolas de metal polido (11/10), tudo por
escolha dele. A referência viva é `direcao-visual.html`; `captura.mjs` e `medir.mjs` fotografam e medem a referência;
`scripts/visual/foto.mjs` e `medir.mjs` fazem o mesmo com o app de verdade.
