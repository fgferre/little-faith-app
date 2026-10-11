# PLAN — direção visual, etapa 6 enxuta e o primeiro bolão real · 10/10/2026

Pedido dele (10/10): seguir as etapas da entrega A sem parar a cada fase; trabalho em paralelo autorizado, com núcleo,
persistência e backend divididos por arquivos e contratos, e a integração no frontend coordenada pela sessão principal.
Decisões dele depois da revisão de 10/10: o piloto vem antes do agente e do backup completo, sem data fixa; o estilo
das telas é escolhido primeiro, por imagem, e as telas novas já nascem nele.
Especificação: `docs/ESPECIFICACAO.md` › "Apuração e rateio" e "Ordem de implementação". Invariantes: `docs/ARCHITECTURE.md`.

## Etapas

- [x] E0. Direção visual: três direções em imagem; ele escolheu a C, "Noite do sorteio" (10/10).
- [x] E1. `npm run done` volta a passar (10/10: tipos e lint corrigidos, testes no schema v5, cópia de emergência v5).
- [x] E2. Testes próprios de settlement no core (10/10: 29 casos; o código já concordava com as regras): caixa/direitos, centavos, parcial, oficial, compensação, conflito,
  encerramento e reabertura.
- [x] E3. Sync v5 em `packages/local` (11/10: a sincronização baixa a divisão; a gravação no aparelho nunca tinha rodado e falhava — consertado e testado); repetir os cenários integrados afetados da etapa 5 (o E2E de
  resultados já passou sozinho em 10/10).
- [x] E4. Backend (10/10: seis ações; encerrar/reabrir ficam rejeitados com aviso): migration, RPCs e família HTTP de settlement, com validação SQL↔core, autorização humana, locks,
  revisão e idempotência.
- [ ] E5. Frontend, já na direção escolhida, em três rodadas com arquivos separados:
  - [ ] E5a. Kit do estilo em `apps/web/src/ui/` (bolas, faixa de etapas, botões, cartões, selos, estados, contagem),
    Sora embutida, tema noite aplicado ao app inteiro (as telas antigas ficam coerentes, não refeitas), Início refeito
    com a contagem para o sorteio e quem falta pagar; `scripts/visual/medir.mjs` e `foto.mjs` para conferir as telas.
  - [x] E5b. Tela do bolão sobre o kit (11/10, duas metades): a faixa de etapas substitui as abas; antes/depois do sorteio, vitória e "não foi
    dessa vez", Lotofácil em 5×3; o planejador em linguagem simples ("1 em 834 mil"), o que também resolve o item 13;
    os fluxos de navegador seguem a tela nova.
  - [ ] E5c. Etapa "Dividir": prêmio confirmado, resgate, a parte de cada pessoa e "já paguei", ligados ao transporte e
    à sincronização; a fila de settlement entra na proteção de revisão de **todas** as famílias de comandos; o caixa
    exibido passa a ser a projeção conciliada; cartão do WhatsApp (item 7, parte da imagem).
- [ ] E6. E2E completo da etapa 6 e `npm run done`; documentação com os números que passarem de verdade (item 3).
- [ ] E7. Piloto: Supabase real, Google, publicação e um bolão real do começo ao fim (cada passo pede a palavra dele).

Etapa 6 enxuta para o piloto: na tela, prêmio confirmado, resgate, a parte de cada pessoa e "já paguei"; despesas,
compensações, encerramento e reabertura ficam no núcleo e no backend, sem tela própria até o piloto pedir.

## Arquivos

- Core: `packages/core/src/settlement-types.ts` e `settlement.ts` — contratos e primeira implementação de despesas,
  prêmio confirmado, resgate, distribuição, compensações, encerramento/reabertura e projeção de caixa. Não compila.
- Local: `packages/local/src/settlement.ts` e `settlement-sources.ts` — snapshots e decisões persistentes com fontes
  coerentes; tabelas aditivas Dexie v5 já declaradas em `database.ts`. Faltam exports, sync e validação.
- Web: `apps/web/src/settlement.tsx` e `settlement-decision.tsx` — telas e revisão iniciais, ainda fora de `App.tsx`;
  o transporte em `auth.ts` ainda não oferece settlement.
- Backend: não existe migration nem família HTTP/RPC de settlement.

## Decisões já tomadas

Contrato:

- Snapshot autossuficiente: `financial`, `registration` e `results` no mesmo corte de `groupRevision`, além de
  `expenses`, `prizes`, `redemptions`, `distributions`, `closures`.
- Fatos com UUID/recibo gerados no servidor, `version`, `groupRevision`, `poolVersion` observada e horário confirmado;
  ordens históricas não dependem só de timestamps.
- Ações: `expense_confirm`, `prize_confirm`, `redemption_record/reverse`, `distribution_record/reverse`,
  `pool_settle/reopen`.
- Core: `computeSettlement(snapshot)`, `createSettlementView(snapshot)`, `settlementStatement(snapshot,poolId)`,
  `validateSettlementActionContext(snapshot,action,confirmedAt)` e validadores de comando/snapshot/recibo.
- Local: `apply/getSettlementSnapshot`, `prepare/execute/recoverSettlementCommand`.
- Transporte: `settlementPull`, `settlementDecide`, `settlementCommandStatus`.

Regras:

- Prêmio calculado, confirmado, resgatado e distribuído são fatos distintos.
- Caixa do organizador = contribuições líquidas + resgates internos − despesas confirmadas − pagamentos/devoluções
  líquidos. Reserva de plano não é despesa confirmada.
- Interno: maiores restos com desempate pelo `personId` congelado. Oficial: direitos e valores explícitos dos recibos
  observados; resgate individual fica fora do caixa do organizador.
- Distribuição não pode exceder caixa resgatado nem direitos; compensações referenciam o original, sem apagar fatos.
  Encerramento reconcilia gastos, sobras, devoluções e pendências explicadas, sem marcar dívida como quitada.
- Prazos de resgate e alertas de 30/15/7/1 dias preparados sem enviar mensagens. A regra geral de 90 dias foi conferida
  nas páginas oficiais das modalidades em 08/10/2026 e admite exceção com fonte e motivo; o link genérico
  `receba-seu-premio.aspx` não informa esse prazo no HTML atual.

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

## Fora do escopo

Etapa 7 (OAuth do agente, MCP/CLI, importação do WhatsApp), etapa 8 (backup criptografado e restauração), cron do
coletor e qualquer mensagem enviada para fora. Os achados da revisão de 10/10 (itens 6 a 12) entram só quando uma
etapa acima tocar na mesma tela.
