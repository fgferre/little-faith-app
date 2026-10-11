# Pendências — o que está quebrado e o que falta

Lista viva do que está aberto. Leia só a seção O BASTÃO e o item da vez; o resto, por `grep`.
Item resolvido sai da lista e vira commit com o número entre parênteses; a história de cada número fica no git (`git log --all --grep="(NNN)"`).
Número é identidade, não posição: item novo entra no fim da sua seção. **Próximo número livre: 13.**

## O BASTÃO — onde a rodada parou (10/10) — `npm run done` VERDE; ESTILO ESCOLHIDO; PRÓXIMO: ETAPA 6 ENXUTA

**Estado:** etapas 1–5 com código integrado e verificado. Etapa 6 (divisão do prêmio): núcleo e persistência escritos,
sem testes próprios; telas escritas, fora do app; o transporte do app já chama `settlement_pull`,
`settlement_command_status` e `review_decide`, que o backend ainda não tem; não há migration nem RPC. A cópia de
emergência passou a `bolao-emergency-v5` e inclui a fila da divisão.

**Verificado em 10/10, nesta sessão:** `npm run done` verde — tipos, lint, 282 testes, SQL no PGlite, 13 testes da
API, build e 33 fluxos no navegador.

**Decisões dele (10–11/10):** pediu a revisão do produto e da interface (achados nos itens 6 a 12); o piloto vem antes
do agente e do backup completo, *sem data fixa*; estilo: *"gostei da C, noite do sorteio"*, depois a versão afinada
("Sim, adotar a afinada"), bolas que *"deveriam lembrar metais"*, acabamento polido — referência em `docs/estilo/`,
descrita no `PLAN.md`; telas novas nascem nela, as antigas migram aos poucos.

**Git:** commits só locais em `main`, sem remoto e sem push. **Fora daqui:** sem Supabase real, OAuth Google, cron ou
deploy (item 5); nenhum subagente ativo. A nota de passagem anterior e a cópia original da especificação estão em
`~/Github/_arquivo/little-faith-docs-2026-10-10/`.

**Textos pedidos por ele, já aplicados:** marca *"Seu bolão em boa companhia"*; início *"Faça sua fezinha, organize
suas apostas e boa sorte!"*.

**A próxima rodada:** `PLAN.md` a partir da E2 (testes do núcleo da divisão) e da E4 (backend), que podem andar em
paralelo com arquivos separados; depois a E5, já no estilo novo. Começar numa conversa nova, lendo só este bastão e o
plano.

## ALTA — bloqueia a entrega ou pode perder trabalho

## MÉDIA — afeta o produto

**3. Documentação defasada (10/10).**
O README ("O que funciona" sem a etapa 5 e chamando registro e resultados de "etapas seguintes"),
`docs/ARCHITECTURE.md` (introdução e "Próximas fronteiras") e `docs/IMPLEMENTATION.md` inteiro (descreve a base
anterior à etapa 5) contam um estado antigo. Atualizar com os números que passarem de verdade (`PLAN.md` E6); o que
ainda valer de `docs/IMPLEMENTATION.md` vai para o README, e ele sai.

**4. A exportação de emergência não é backup (10/10).**
O export atual é `bolao-emergency-v5`, sem criptografia; não apresentar como backup completo. `@zip.js/zip.js@2.23.0`
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
