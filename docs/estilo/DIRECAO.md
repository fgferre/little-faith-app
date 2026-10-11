# Direção visual — Noite do sorteio, versão afinada

Direção visual "Noite do sorteio", versão afinada (escolhas dele em 10 e 11/10) — referência viva em
`docs/estilo/direcao-visual.html` (configuração `estilo` do navegador), imagens `docs/estilo/noite-*.png`, ferramentas
`captura.mjs` (fotos) e `medir.mjs` (contraste, bordas, tamanhos, transbordo em 320/360/390):

- Fundo noturno em gradiente violeta-escuro; cartões com preenchimento branco a 6 % e borda a 10 % (14 % quando
  tocáveis), sem desfoque. Um efeito herói por tela: o brilho fica só no ouro. Botão principal chapado #5b43d6; botão
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
- Movimento: barra enchendo, bolas sorteadas caindo uma a uma, acertos pulsando, prêmio contando até o valor; nada
  ocioso; tudo desligado com movimento reduzido.
- Linguagem simples do item 9 em toda tela nova.

Como foi escolhida: três direções em imagem (10/10), a afinada adotada e as bolas de metal polido (11/10), tudo por
escolha dele. A referência viva é `direcao-visual.html`; `captura.mjs` e `medir.mjs` fotografam e medem a referência;
`scripts/visual/foto.mjs` e `medir.mjs` fazem o mesmo com o app de verdade.
