# Pendências — o que está quebrado e o que falta

Lista viva do que está aberto. Leia só a seção O BASTÃO e o item da vez; o resto, por `grep`.
Item resolvido sai da lista e vira commit com o número entre parênteses; a história de cada número fica no git (`git log --all --grep="(NNN)"`).
Número é identidade, não posição: item novo entra no fim da sua seção. **Próximo número livre: 13.**

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

**Revisão do produto e da interface (10/10, pedida por ele):** a base técnica está sólida, mas o produto foi feito
como sistema de auditoria antes de um bolão real; as telas falam a língua do sistema; o visual é limpo e parado (uma
animação no app inteiro, muita letra de 12 px ou menos). Achados nos itens 6 a 12. Decisões dele: o piloto vem antes
do agente e do backup completo, *sem data fixa*; o estilo é escolhido primeiro, por imagem.

**A próxima rodada:** `PLAN.md` a partir da E0 (direções visuais para ele escolher); depois a etapa 6 enxuta e o piloto.

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
PGlite. Conectar pede a palavra dele. O plano grátis do Supabase pausa por inatividade: um bolão mensal pode achar o
servidor dormindo no dia do prêmio.

**6. O dia do prêmio é a parte mais fraca (revisão de 10/10).**
O app não registra quem guarda o bilhete original (sem ele não se recebe o prêmio) nem trata o prêmio que cai todo no
nome de uma pessoa e é repassado aos outros (imposto e repasse pedem um contador). Antes do piloto.

**7. O participante quase não existe (revisão de 10/10).**
Quem pagou só recebe um link genérico. Falta um cartão por pessoa, sem conta e revogável: minhas cotas, se paguei, os
jogos, a foto do bilhete, o resultado e a minha parte. A imagem do bolão para o WhatsApp entra junto.

**8. Repetir o bolão com a mesma turma (revisão de 10/10).**
É a ação mais comum de quem joga toda semana e ficou na entrega B. Uma cópia simples para o próximo concurso basta.

**9. As telas falam a língua do sistema (revisão de 10/10).**
"Rascunho", "proposta", "manifesto", "SHA-256", "semente de 256 bits", "Monte Carlo", "1 cota = 100 unidades", chance
em "0,0001198%" (melhor "1 em 834 mil"), estados de sincronização em cada linha. Criar o grupo começa por um texto de
regras com cara de contrato; criar o bolão pede o número do concurso à mão, sem sugerir o próximo sorteio.

**10. Navegação no celular (revisão de 10/10).**
No Início o slogan ocupa a primeira tela e "o que pede atenção" fica embaixo; na tela do bolão a ação maior é "Novo
bolão", não o próximo passo deste; as abas somem para o lado sem mostrar a ativa; "Dados e integrações" não está na
barra de baixo. Um bolão como linha do tempo (montar → arrecadar → jogar → registrar → sorteio → dividir) resolve junto.

**11. A demonstração para antes do melhor (revisão de 10/10).**
Registro, resultado e divisão não aparecem no modo de exemplo, e a Revisão some nele. A demonstração devia mostrar um
bolão inteiro, com prêmio.

## BAIXA — dívida interna, ninguém vê

**12. A tela principal é um arquivo só (revisão de 10/10).**
`apps/web/src/App.tsx` tem ~3 mil linhas com todas as telas dentro de uma função; cada mudança de tela fica cara.
Separar por tela antes do redesenho. Junto: "Descartar proposta" sem confirmação, janela que fecha com Esc sem avisar
que perde o que foi digitado, e tamanhos de letra de 4 a 11 px espalhados no CSS.

## O que o dono ainda vai contar

O que ele reportar entra aqui, nas palavras dele e com a data, até ganhar número numa seção acima.
