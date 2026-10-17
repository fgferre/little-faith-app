Teimosinha de verdade: um bolão só com vários concursos seguidos, pagamento único e conferência de cada sorteio — decisão do dono em 17/10 ("a Confraria pediu para repetir os números"). Plano escrito em 17/10 a partir do inventário de tudo que hoje assume um concurso por bolão.

Estado em 17/10 (noite): passos 1 a 5 feitos e commitados (113a7c1, 17fc468, dcb5368, 8b3ea25 e o commit do passo 5); nada publicado
(4 migrações novas: 20261017000000, 20261017010000, 20261017020000, 20261017030000, mais a função api e o app). `npm run done` verde
depois do passo 5 (352 unitários, 53 fluxos). Falta o passo 6 (publicar, com o sim dele). Decisões do passo 5: o Sorteio trabalha num
concurso de cada vez, escolhido numa fileira de botões (o próximo pendente vem marcado e selecionado; um bolão de um concurso não tem
fileira); Dividir mostra um bloco por concurso com o próprio "Confirmar prêmio" e uma linha com a soma da série; a etapa do bolão só vira
"Dividir" quando todos os concursos têm resultado, e a contagem do Início segue o próximo concurso pendente; o cartão do participante lista
um sorteio por concurso; o convite diz "2 concursos seguidos, 3072 a 3073"; a demonstração tem a Quina da turma como teimosinha de 3;
o formulário do bolão já perguntava "Teimosinha" desde o passo 1 e ficou como estava. Corrigido de passagem: o "Informar resultado"
abrir sozinho só funcionava quando o grupo ainda não tinha resultado nenhum (a condição olhava a visão inteira, não o resultado do
concurso). Na tela Registrar o campo "Concursos cobertos" começa em 1 e aparece sempre (perguntar a ele se fica só na teimosinha).

## O que é (nas palavras dele e da especificação)

- Dono, 17/10: "um bolão só com vários concursos, pagamento único e conferência de cada sorteio".
- Especificação (linha "Teimosinha"): lista explícita dos concursos cobertos e comprovante correspondente; direitos congelados na compra;
  conferência separada de cada concurso. "Recorrência" (um bolão por concurso) é outra coisa e fica de fora.
- Na CAIXA, a teimosinha é o mesmo jogo em N concursos seguidos, num bilhete só, pago de uma vez (N vezes o preço do jogo).

## Decisões já tomadas (não reabrir)

1. O bolão ganha `contestCount` (1 a 12; ausente nos registros antigos = 1). Os concursos cobertos são `contestNumber` até
   `contestNumber + contestCount - 1`, sempre seguidos, todos da mesma modalidade. Um bolão normal é uma teimosinha de 1.
2. Dinheiro: a cota é uma só para a série inteira (o organizador define o valor da cota já contando os N concursos). O custo de cada
   jogo no plano é `preço do jogo × contestCount`; o orçamento, a sobra e a taxa seguem a regra de hoje sobre esse custo.
3. A entrada de cota e a trava têm o corte de hoje, no primeiro sorteio: depois dele ninguém entra (o bilhete já foi comprado).
   `pool_draw_passed` e `participant_pool_open` olham o primeiro concurso.
4. Registro: o recibo da teimosinha traz o primeiro concurso e a quantidade; o bilhete observado ganha `contestCount` (ausente = 1);
   divergência quando o primeiro concurso ou a quantidade não batem com o plano congelado. Um recibo cobre todos os concursos; a
   regra da taxa (35 % do custo do recibo) continua por recibo.
5. Resultado e calendário por concurso dentro do bolão: `currentResult(poolId, contestNumber)` e `currentCalendar(poolId,
   contestNumber)`; conflito só entre versões do mesmo concurso; a busca pela CAIXA e o informar manual recebem o concurso; o job de
   coleta é por (bolão, concurso). No banco, `contest_result_versions` ganha a coluna `contest_number` (preenchida a partir do `data`
   nas linhas existentes) e as funções de resultado aceitam qualquer concurso da faixa do bolão.
6. Prêmio por concurso: uma confirmação de prêmio por concurso (`settlement_prizes.contest_number`), resgate por prêmio como hoje, e a
   divisão sobre a soma dos prêmios confirmados da série; prêmio calculado por concurso e no total. O núcleo (`computeSettlement`) e o
   SQL (`settlement_pool_balance`) mudam juntos, com fixture de 2 concursos conferida pela paridade SQL↔núcleo.
7. Cartão: cada bolão passa a trazer `draws` (um por concurso: número, data, resultado, acertos e prêmio calculado); `result` e
   `drawAt` continuam valendo para o próximo concurso pendente (ou o último), para o cartão antigo não quebrar.
8. Tudo é compatível para trás: bolões e registros sem `contestCount` continuam valendo como 1; nenhuma migração reescreve dados
   além de preencher a coluna nova; o app no ar continua funcionando com as migrações aplicadas antes do app.
9. Fora do escopo: concursos não seguidos; mudar a quantidade depois da trava; jogos diferentes por concurso; recorrência (série de
   bolões separados); teimosinha parcial (metade dos jogos em teimosinha).

## Passos (um commit por passo; `npm run done` no fim de cada um)

1. [x] Núcleo e banco do plano: `contestCount` no bolão (tipos, validação, formulário aceita 1 a 12), custo do jogo × concursos no
   plano e no catálogo (`prepared-plans.ts`, `planning.ts`, `planning.sql`), manifesto congela a quantidade; `sync_push` valida;
   testes do núcleo e SQL; cabeçalho do bolão mostra "Concursos 3072 a 3075 · teimosinha de 4".
2. [x] Resultado e calendário por concurso: `results.ts` (snapshot por faixa, atual por concurso, conflito só no mesmo concurso),
   `caixa-results.ts` (busca com o concurso pedido), migração `contest_number` em `contest_result_versions` e job por concurso,
   `result_decide`/`result_collect`/`result_jobs_due` por concurso, cortes no primeiro concurso; testes núcleo, SQL e API.
3. [x] Prêmio por concurso (feito em 17/10, `npm run done` verde): `settlement.ts` e `settlement.sql` (prêmio por concurso, soma na divisão, `prize_confirm` com concurso),
   `settlement_pool_balance`, cartão com `draws`; fixture de 2 concursos na paridade SQL↔núcleo; testes.
4. [x] Registro (feito em 17/10, `npm run done` verde): `contestCount` no bilhete observado, comparação e divergências, tela Registrar com "Concursos cobertos"; o calendário
   usado no registro e no corte da cota passa a ser o do primeiro concurso (hoje é o último calendário do bolão); a guarda do bolão
   recusa diminuir `contestCount` abaixo de um concurso que já tem resultado ou calendário; testes.
5. [x] Telas (feito em 17/10, `npm run done` verde): formulário do bolão ("Concursos seguidos"), Sorteio com uma seção por concurso (busca, manual, calendário, resultado e
   acertos de cada um; o próximo pendente em destaque), Dividir com um prêmio por concurso, Início e contagem pelo próximo concurso
   pendente, cartão com os sorteios da série, convite em Arrecadar ("4 concursos seguidos, 3072 a 3075"), demonstração com uma
   teimosinha; fluxo Playwright de ponta a ponta (planejar, travar, registrar, dois resultados, dois prêmios, dividir); olhar em três
   larguras.
6. [ ] Publicar com o sim dele: migrações novas na ordem, `functions deploy api`, app.

## Onde cada coisa está (do inventário de 17/10)

- Núcleo: `packages/core/src/types.ts` (PoolData), `validation.ts`, `prepared-plans.ts` (custo, linhas ~113-181), `planning.ts:66`
  (manifesto), `registration.ts` (bilhete observado e comparação, ~35-130), `results.ts` (~198-272), `caixa-results.ts`,
  `registered-prizes.ts`, `settlement.ts` (~121-265, 330, 432), `participant-types.ts`.
- Banco: `20261007000000_foundation.sql` (validação do bolão), `20261008000000_planning.sql` (custo, guarda do concurso, trava),
  `20261008010000_registration_results.sql` (resultados, calendários, jobs, registro), `20261010000000_settlement.sql` (prêmios,
  resultado atual, balanço), `20261016020000_quota_after_deadline.sql` (`pool_draw_passed`), `20261016050000_settlement_group_prize.sql`
  (balanço vivo), `20261016060000_participant_responses.sql` (cartão vivo). Cada mudança é uma migração nova.
- App: `screens/bolao.tsx`, `bolao-sorteio.tsx`, `bolao-dividir.tsx`, `bolao-registrar.tsx`, `bolao-etapas.tsx`, `inicio.tsx`,
  `forms/draft-form.tsx`, `participante.tsx`, `bolao-arrecadar.tsx`, `app-shared.ts` (rolloverOf), `repository.ts` (congelamento
  do concurso), `demo.ts`.
- Avisos do inventário: o concurso do bolão aceita até 9007199254740991 mas plano e resultado só até 999999 (alinhar para 999999);
  o SQL não confere o concurso do calendário na comparação do registro (o núcleo confere); as buscas de `drawAt` ignoram o concurso
  (`participant_responses.sql:321`, `bolao-sorteio.tsx:340`) e passam a filtrar pelo concurso.
