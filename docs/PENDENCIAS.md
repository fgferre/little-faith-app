# Pendências — o que está quebrado e o que falta

Lista viva do que está aberto. Leia só a seção O BASTÃO e o item da vez; o resto, por `grep`.
Item resolvido sai da lista e vira commit com o número entre parênteses; a história de cada número fica no git (`git log --all --grep="(NNN)"`).
Número é identidade, não posição: item novo entra no fim da sua seção. **Próximo número livre: 6.**

## O BASTÃO — onde a rodada parou (10/10) — ETAPA 6 PELA METADE; `npm run done` NÃO PASSA; PRIMEIRO COMMIT FEITO

**Estado:** etapas 1–4 feitas e verificadas antes; etapa 5 (registro e resultado) com código integrado no núcleo, na
persistência, no frontend e no backend, faltando a rodada completa de validação; etapa 6 (apuração e rateio) pela
metade, fora do app e do backend. A rodada segue `PLAN.md`, a partir da E1.

**Verificado em 10/10:** `npm run test:db` e `npm run test:api` passaram; `npm run test` com 4 falhas, typecheck e lint
falhando (item 1); o E2E de resultados passou sozinho
(`npx playwright test tests/e2e/financial.spec.ts -g 'manual results' --workers=1`). O sucesso de `npm run done`
escrito no README e em `docs/IMPLEMENTATION.md` é antigo.

**Git:** primeiro commit em `main` a pedido dele (10/10); só local, sem remoto e sem push.

**Fora daqui:** sem Supabase real, OAuth Google, cron ou deploy (item 5); nenhum subagente ativo.
A nota de passagem anterior e a cópia original da especificação estão em `~/Github/_arquivo/little-faith-docs-2026-10-10/`.

**Textos pedidos por ele, já aplicados:** marca *"Seu bolão em boa companhia"*; início *"Faça sua fezinha, organize
suas apostas e boa sorte!"*.

**A próxima rodada:** `PLAN.md` (fechar a etapa 5 e terminar a 6); depois as etapas 7 e 8
(`docs/ESPECIFICACAO.md` › "Ordem de implementação").

## ALTA — bloqueia a entrega ou pode perder trabalho

**1. `npm run done` não passa (10/10).**
Typecheck para em `packages/core/src/settlement.ts` (inferência de união em `latest(list, poolId)` dentro de
`buildFact`); depois da primeira correção, conferir os erros seguintes em `packages/local` e nas telas de settlement.
Lint: `sourceReport` sem uso em core/settlement; non-null assertion sobre optional chain em web/settlement-decision.
Testes: `finance.test.ts`, `planning.test.ts` e `stage5-migration.test.ts` esperam `db.verno === 4`, mas o schema já é
5 — atualizar sem enfraquecer a preservação de dados; `settlement-migration.test.ts` chama `getSettlementSnapshot` pelo
index público, que ainda não o exporta (a implementação está em `src/settlement.ts`).

## MÉDIA — afeta o produto

**3. Documentação defasada (10/10).**
O README ("O que funciona" sem a etapa 5 e chamando registro e resultados de "etapas seguintes"),
`docs/ARCHITECTURE.md` (introdução e "Próximas fronteiras") e `docs/IMPLEMENTATION.md` inteiro (descreve a base
anterior à etapa 5) contam um estado antigo. Atualizar com os números que passarem de verdade (`PLAN.md` E6); o que
ainda valer de `docs/IMPLEMENTATION.md` vai para o README, e ele sai.

**4. A exportação de emergência não é backup (10/10).**
O export atual é `bolao-emergency-v4`, sem criptografia; não apresentar como backup completo. `@zip.js/zip.js@2.23.0`
já está instalado no web; codec e interface do backup (etapa 8) não foram escritos.

**5. Nada foi conferido contra o Supabase real (10/10).**
Sem projeto conectado, OAuth Google, dois aparelhos, cron do coletor (`results-collector` preparado, nenhum cron
instalado) nem deploy; as credenciais não estão neste checkout. Os testes usam Auth/Storage simulados e RPCs reais no
PGlite. Conectar pede a palavra dele.

## BAIXA — dívida interna, ninguém vê

## O que o dono ainda vai contar

O que ele reportar entra aqui, nas palavras dele e com a data, até ganhar número numa seção acima.
