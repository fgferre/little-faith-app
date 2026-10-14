# Régua única de layout — 13/10/2026

Tarefa: aplicar ao app a conferência de layout aprovada pelo dono em 13/10 (quadro "Conferência de layout", medições em
`.tmp/layout/`: fotos de 17 telas × 3 larguras, `medidas.json`, `RESUMO.md`, script `auditar.mjs`). Decisão dele:
"consertar todos os problemas". Suposição declarada: no tablet (700–999) a barra lateral some, a barra de baixo fica e
os cartões vão a duas colunas; ele aprova olhando o app rodando antes do commit.

## A régua (decidida aqui; nenhuma regra escreve px por conta própria)

- Letra (variáveis em `styles.css :root`): `--t-rotulo` 12 (rótulos em caixa alta, iniciais, bolas pequenas) · `--t-selo` 13
  (selos/chips e bolas, Sora 700) · `--t-apoio` 13 (legendas, ajuda, datas, Inter 400) · `--t-corpo` 15 · `--t-cartao` 17
  (título de cartão, Sora 600) · `--t-secao` 20 (Sora 700) · `--t-tela` 24, 28 a partir de 1000 (Sora 700) · `--t-numero` 28,
  36 a partir de 1000 (Sora 800: dinheiro, contagem) · `--t-capa` clamp(32px, 8.6vw, 44px) (capa e palco do sorteio; 34 no celular, para "boa companhia." caber numa linha).
- Pesos: Inter só 400/500/600 (700/800/900 viram 600, ou o elemento passa a Sora 700 se for inicial, selo, contador ou
  número); Sora 600/700/800, 500 só na capa; 650 vira 700. `strong, b { font-weight: 600 }`.
- Entrelinha: `--lh-texto` 1.5 (corpo, apoio) · `--lh-titulo` 1.2 (títulos a partir de 17) · `--lh-justo` 1 (números,
  dinheiro, bolas, selos, botões, rótulos).
- Espaço (padding, margin, gap): `--e2` fio · `--e4` · `--e8` · `--e12` · `--e16` · `--e24` · `--e32` · `--e48`.
  Mapa: 1–3→e2 · 4–5→e4 · 6–9→e8 · 10–13→e12 · 14–19→e16 · 20–26→e24 · 28–32→e32 · 40–48→e48. Larguras de layout
  (232, 264, 96 em calc) não são espaço e ficam.
- Raios: `--r-campo` 8 (campos, chips, botões pequenos) · `--r-cartao` 14 (cartões, botões) · `--r-folha` 20 (gavetas,
  janelas, capa) · `--r-pilula` 999; círculo continua 50%.
- Margem da tela: `--margem` 16 (até 699) · 24 (700–999) · 32 (1000+); conteúdo até `--conteudo-max` 1120, centrado.
  Vale para todas as telas, inclusive Início (capa) e Bolão (etapas), que hoje têm as suas.
- Quebras: 359 (celular estreito) · 700 (tablet: duas colunas, barra de baixo) · 1000 (computador: barra lateral) · 1200
  (barra lateral larga). Somem 370, 389, 480, 550, 600, 760, 761, 1100.
- Movimento: toda animação/transição só dentro de `@media (prefers-reduced-motion: no-preference)`; a regra "reduce" some.

## Passos

1. [x] Régua em `styles.css` (worker A, opus): tokens, substituição de todos os literais, quebras, margem, tablet
   (barra lateral só a partir de 1000; grades em duas colunas a partir de 700), pesos falsos, movimento.
2. [x] Régua em `ui.css`, `planning.css`, `registration.css`, `sorteio.css` (worker B, opus, em paralelo com 1): mesmos
   mapas; faixa de etapas com esmaecido de 40 px e a etapa atual centrada; gaveta vira janela a partir de 700;
   pílula das etapas a partir de 1000.
3. [x] Aqui: `npm run build`, `npx vitest run`, fotos e medidas de novo com `.tmp/layout/auditar.mjs`; olhar as três larguras
   (combinações de letra 47 → 28; capa encolhida no celular; raio dos campos = `--r-campo`).
4. [x] Telas (worker C, opus, depois de 1–3): Início (rodapé em uma linha; "Pede atenção" vira linha compacta; capa na
   margem), Bolões (botão "Novo bolão" na linha do título; cartão de bolão único com a bola, igual ao da Início; rodapé
   colado embaixo em todas as telas), Dados (dupla de botões vira pilha quando o nome não cabe; valor-frase vai embaixo
   do rótulo; título do aviso curto).
5. [x] Telas (worker D, opus, depois de C; mais: palco em uma coluna sem resultado, grade de bolas até 420 px, selos da mesma altura): Arrecadar (resumo acompanha a rolagem no computador; uma fileira de ações
   só; "Ver comprovante" pequeno na linha da pessoa), Sorteio (cabeçalho do palco em quatro papéis; explicação junto
   do botão apagado; ação principal primeiro e cheia; nome no botão de calendário), Histórico (só o conciliado em
   número grande; um jeito de abrir detalhe; selos da mesma altura; no tablet os três caixas em faixa).
6. [ ] Aqui: `npm run done` rodado uma vez (verde, menos o teste de navegação que esperava a barra lateral a 768:
   ajustado para a quebra 1000 e rodado de novo, 4 de 4 verdes); fotos finais em `.tmp/layout/fotos` (antes em
   `fotos-antes`, só régua em `fotos-regua`); quadro atualizado com a fila "Depois" e a quebra 700. Dono mandou gravar
   (13/10, à noite): um commit para a rodada toda, porque régua e telas mexem nos mesmos arquivos de estilo.
7. [ ] Pedidos dele ao ver o resultado (13/10): (a) tela do participante entra na conferência: a demonstração precisa
   mostrá-la; (b) marcador do menu lateral deslocado na foto com movimento reduzido: reproduzir e corrigir;
   (c) botão com ícone e nome longo quebra texto em celular estreito (320): corrigir; (d) ele mostrou a Revisão no
   tablet com problemas: olhar TODAS as dezessete telas nas três larguras, com olhos, não só medição; Revisão primeiro.

## Fora de escopo

Tela do participante (a demonstração não a mostra), cores, textos, cartão do WhatsApp (`ui/cartao.ts`), testes novos
(lista para o dono aprovar no fim: regra de lint "sem px fora da régua", "sem prefers-reduced-motion: reduce").
