# Pendências — o que está quebrado e o que falta

Lista viva do que está aberto. Leia só a seção O BASTÃO e o item da vez; o resto, por `grep`.
Item resolvido sai da lista e vira commit com o número entre parênteses; a história de cada número fica no git (`git log --all --grep="(NNN)"`).
Número é identidade, não posição: item novo entra no fim da sua seção. **Próximo número livre: 14.**

## O BASTÃO — onde a rodada parou (15/10) — ENSAIO RETROATIVO DO BOLÃO 3070 FEITO, TUDO SÓ NO GRUPO TESTE DELE; FALTA CORRIGIR O QUE O ENSAIO MOSTROU

**Rodada de 15/10 (ensaio da revelação, pedido dele):** "Vamos tentar fazer, emular isso, mas sem mandar no grupo [...] Eu quero chegar
com tudo funcionando muito bem lá no grupo." Feito no bolão real "Mega 14/10 150MM" (escolha dele): 10 pessoas (4 novas, maioridade
declarada por ele), 10 pagamentos de R$ 50 confirmados com a hora em que cada nome entrou na lista "Pagos" do grupo, combinados v1
publicados com aceite "sem aceite escrito; quem paga entra" (escolha dele), prazo mudado para 15/10 23h só para o ensaio (o real era
14/10 18h Brasília; ele: "A gente está rodando só um teste que é retroativo. Não tem problema nisso."), 17 bilhetes digitados e conferidos
com as 4 fotos do grupo, plano e trava confirmados, resultado 3070 informado à mão (19 27 29 43 54 60, acumulou), sem prêmio, custo
R$ 498 confirmado, sobra R$ 2 como reserva do grupo. Os 10 links pessoais, o resultado e a mensagem da surpresa foram só para o grupo
"Teste" dele (só ele está lá); nada foi ao grupo da turma (conferido). O WhatsApp Web ficou ligado no Chrome dele por código de telefone;
ele desliga em Aparelhos conectados quando quiser. Desenho da revelação: https://claude.ai/artifact/6iCZS5eDry2cGmwcGWR1an (três
novidades esperam o sim dele). Notas, bilhetes lidos, fotos e links com token em `.tmp/bastao/` (fora do git). O que o ensaio mostrou:
itens 14 e 15. Próximo: ele avalia os cartões no Teste; corrigir o 14 antes de qualquer revelação.


**Para quem pega agora:** `main` = 81d522f, igual ao GitHub, app publicado com ele e banco com todas as migrações. O
próximo item aberto da fila é o 2 (modo sombra do "Mega 14/10 150MM"; o sorteio é na noite de 14/10). Da rodada de
layout ficaram só decisões para o dono, não código: aprovar o teste "`#/p/demo` mostra o cartão da Isabela sem chamar o
servidor" e duas regras de lint ("sem px fora da régua", "sem prefers-reduced-motion: reduce"); dois apontamentos
baixos deixados de propósito ("Novo bolão" com contorno na Início e cheio em Bolões; selo "Demonstração" dentro do
cartão de Dados). A régua está em `styles.css :root` e explicada no quadro
https://claude.ai/artifact/NRJqXNXzy6aaSC7YC9nroT (antes e depois de 7 telas × 3 larguras); qualquer tela nova segue
a régua, nunca px solto.

**Estado:** etapas 1–6 da especificação feitas; fila 1–6 feitas em 12–13/10. Em 13/10: fila 8 feita (prazo de resgate com
contagem de dias e tom de aviso em Dividir e no cartão da pessoa; migração `20261013020000_participant_card_deadline.sql`
expõe `redemptionDeadlineDate`/`prizeRedeemed` no cartão); "Acumulou! Prêmio estimado" entra na chamada da turma (uma
leitura só, `rolloverOf`, para Sorteio e Arrecadar); "Enviar no WhatsApp" + "Copiar" em todas as mensagens prontas
(cobrança, chamada, link pessoal, repasse ao registrador, resultado), pelo link oficial `wa.me`, sem telefone por pessoa.
`main` = 4b52fea, enviado ao GitHub. **Verificado em 13/10:** `npm run done` verde duas vezes (tipos, lint, 320 testes,
SQL no PGlite, 16 da API, build, 40 fluxos no navegador); capturas em `.tmp/visual/` (apagável).

**Rodada de layout (13–14/10, dois commits locais 1e0084e e 28b9771, NÃO enviados ao GitHub):** conferência geral
pedida por ele (quadro "Conferência de layout", https://claude.ai/artifact/NRJqXNXzy6aaSC7YC9nroT, com antes e depois
de 7 telas em 3 larguras); régua única em `styles.css :root` (`--t-*`, `--lh-*`, `--e*`, `--r-*`, `--margem`,
`--conteudo-max`), quebras 359/700/1000/1200, barra lateral só a partir de 1000 (tablet com barra de baixo e duas
colunas, escolha dele), Inter nunca acima de 600, fileira de botões única (lado a lado até caber, pilha quando não, até
420 px a partir de 700), cartão do participante de exemplo em `#/p/demo`, marcador do menu corrigido. Medições e fotos
em `.tmp/layout/` (`auditar.mjs` fotografa e mede as 17 telas × 3 larguras; `RESUMO.md`). `npm run done` verde em 14/10.
Fica para a próxima: publicar junto com o pendente de produção abaixo; o teste que faltou aprovar: "`#/p/demo` mostra o
cartão da Isabela sem chamar o servidor"; ideia de lint "sem px fora da régua" e "sem prefers-reduced-motion: reduce".

**PRODUÇÃO EM DIA (14/10):** 1) migração `20261013020000` aplicada em 14/10 pelo SQL Editor do painel do Supabase (pelo
Chrome dele, logado), com o registro em `supabase_migrations.schema_migrations`; conferido na hora: as quatro últimas
migrações (participant_links, group_pix, settlement_close, participant_card_deadline) constam no servidor; 2) app
republicado em 14/10 às 17:35 UTC (run 38607963236) com `main` = 85c2392, que inclui a rodada de layout. Lição: o CLI
do Supabase (`npx -y supabase@2 …`) trava nesta máquina quando ele está remoto, porque a entrada fica no chaveiro do Mac
e cada binário novo pede permissão numa janela; em modo automático o classificador também barra. Com ele remoto, o
caminho é o SQL Editor pelo Chrome dele (texto da migração mais o `insert` no histórico; o texto usado ficou em
`.tmp/bastao/aplicar-migracao-20261013020000.sql`). Quem pegar a próxima conversa confere
`gh run list --workflow=deploy.yml --limit 1` antes de publicar de novo.

**Item 7 em andamento = MODO SOMBRA (decisão dele, 13/10):** a turma não sabe do app, é surpresa. Nada vai ao grupo
pela nossa mão; o app espelha o que acontece no grupo de WhatsApp e a revelação vem depois do sorteio, com os links
pessoais enviados por ele. No app publicado, na conta dele: grupo "Mega da Virada (Confraria)" (sem Pix), bolão
"Mega 14/10 150MM" (Mega-Sena 3070, cota R$ 50, pagar até 14/10 18h Brasília; o fuso do grupo ficou America/Chicago,
o do navegador dele — conferir), 6 pessoas da rodada passada com 1 cota prevista cada (R$ 300), nenhum pagamento.
Regra dele (13/10): todo mundo do grupo pode entrar e quem está dentro é quem paga (comprovante = confirmação); falta
cadastrar o resto do grupo sem cota (ele passa os nomes) e, se ele quiser, uma enquete nativa do WhatsApp feita por ele.
Quem é quem, papéis e o que o grupo já disse estão em `.tmp/bastao/confraria.md` (fora do git de propósito: nomes de
terceiros; nunca CPF, chave Pix ou id de transação no repositório). Próximos passos do sombra: marcar "entrou"/pago
conforme o grupo (leitura do WhatsApp do Mac dele por computer-use; imagens vêm borradas), digitar os jogos das fotos de
quem compra, travar e registrar com a foto, resultado na quarta 14/10 à noite, conferir a divisão; depois, revelar.
A passagem da conversa anterior (contas, CLI, ordem de publicar) está em `.tmp/bastao/passagem-13-10.md`.

**Decisões dele (13/10):** "não quero esse trabalho, quero automático" — envio por WhatsApp sem mão humana só existe
pela API oficial (empresa verificada, grupos só criados pelo robô, 8 pessoas) ou por robô não oficial (risco de
bloqueio); nenhum dos dois entra. O caminho é tirar trabalho do organizador no app: envio com um toque (feito),
pagamento confirmado por provedor de Pix, jogos lidos da foto. **Git:** `origin` = github.com/fgferre/little-faith-app,
público; app em https://fgferre.github.io/little-faith-app/ ligado ao Supabase real; login Google só para o e-mail dele.

**A FILA (13/10, uma lista só, nesta ordem; quem pegar a próxima conversa começa pelo primeiro item aberto e marca
aqui o que fechar):**
1. Aplicar a migração e republicar: FEITO em 14/10 (ver PRODUÇÃO EM DIA).
2. Modo sombra do bolão "Mega 14/10 150MM": ENSAIO RETROATIVO FEITO em 15/10 até a divisão e os links (ver a rodada de 15/10).
3. ~~Avisos de prazo do prêmio~~ FEITO em 13/10.
4. ~~Enviar no WhatsApp com um toque~~ FEITO em 13/10.
5. Telefone por pessoa (cadastro e servidor, nunca no cartão) para o link pessoal abrir direto na conversa (~3 h).
6. Pagamento confirmado sozinho por provedor de Pix (provedor e conta são dele; tarifa por transação) (~1 dia).
7. Jogos lidos da foto do bilhete, para o organizador só conferir (~1 dia).
8. Revelação: depois do sorteio, links pessoais e a mensagem do resultado; anotar o que a turma estranhar.
9. Busca automática do resultado no horário (publicar `results-collector`, segredo e agendamento) (~2 h + conta dele).
10. "Estou dentro" e "paguei" (com comprovante) pelo cartão do participante (~3 h).
11. Outros organizadores entrando com Google: publicar o app do Google "em produção" ou cadastrar e-mails (conta dele).
12. Backup completo com senha (etapa 8 da especificação) (~4 h).
13. Teimosinha e série de concursos paga adiantado (~1 dia).
14. Pesquisa, rodada 2: ele abre o Loterias Online (maioridade) e conversa com 5 organizadores; eu cruzo.
15. O assistente que lê o WhatsApp (etapa do agente). Depois: participante com conta e convites; foto do bilhete no
cartão por URL temporária; limite de taxa na rota pública (ver BACKLOG).

## ALTA — bloqueia a entrega ou pode perder trabalho

**14. A tela do Sorteio fica em branco entre o resultado e a conferência do registro (15/10).**
`bolao-sorteio.tsx` lê `assessment.skippedTicketKeys` no ramo "Não foi dessa vez" sem checar `assessment`, que é null enquanto o
registro não foi conferido; o app inteiro para até recarregar. Visto no bolão real 3070 com resultado manual e registro ainda não
conferido; depois da conferência a tela abriu. Com a busca automática, o resultado costuma chegar antes da conferência.

## MÉDIA — afeta o produto

**15. O que o ensaio de 15/10 mostrou (detalhes em `.tmp/bastao/confraria.md`).**
- "Consultar resultado da CAIXA" falhou no app publicado: "A fonte oficial está indisponível" (a API da CAIXA respondia de fora).
- O servidor recusa cota depois do prazo, mesmo com pagamento antes: espelhar uma rodada que já passou exige mudar o prazo.
- A data do pagamento vem como "agora"; é preciso digitar a hora real, senão a cota parece paga fora do prazo.
- 17 bilhetes = 113 cliques nas dezenas; não há como colar "10 20 23 33 45 50 55". Pagamentos: 2 janelas e ~10 s de espera cada.
- Aposta feita antes da trava vira "divergente": o servidor pede justificativa por cartela só num aviso pequeno, a janela fecha
  como se tivesse dado certo, e o cartão mostra "Registro com diferença: o comprovante não bate com o combinado".
- O aceite dos combinados por pessoa, com prova, não existe na vida do grupo (lá "quem paga entra").
- A mensagem do link pessoal some ao sair da tela; para reenviar é preciso cancelar e criar outro link.
- O WhatsApp transforma "19 27 29 43 54 60" em link de telefone; usar separador ("19 · 27 · ...").
- Janelas de revisão mostram hora crua ("2026-10-16T04:00:00.000Z"); confirmações às vezes ficam em "Consultar recibo" mesmo aceitas.
- No cartão: resultado no fim, depois dos 17 jogos; "Devolução R$ 0,00 de R$ 0,20" com a sobra marcada como reserva do grupo.
- Do grupo: a turma confere à mão numa planilha depois do sorteio, mantém a lista "Pagos" em corrente e pediu para repetir os números.

**4. A exportação de emergência não é backup (10/10).**
O export atual é `bolao-emergency-v5`, sem criptografia; não apresentar como backup completo. `@zip.js/zip.js@2.23.0`
já está instalado no web; codec e interface do backup (etapa 8) não foram escritos.

**5. O piloto está no ar; faltam o cron, a produção do login e o lembrete da pausa (12/10).**
Feito em 12/10 com ele presente: projeto Supabase `little-faith` (São Paulo), seis migrations aplicadas pela CLI
(`npx -y supabase@2 … db push`, sem senha), função `api` publicada importando `packages/core` sem queixa, segredo
`API_ALLOWED_ORIGINS`, login Google (projeto Google Cloud `little-faith`, cliente web, usuário de teste = ele), URLs
de retorno, `.env` local, repositório público e GitHub Pages em https://fgferre.github.io/little-faith-app/ (fluxo
"Publicar no GitHub Pages", por clique). Conferido: login no preview local e no endereço público; grupo "Turma de
teste" gravado em `groups` e lido de volta no outro aparelho; `/v1/groups` sem sessão → 401; cartão com token falso
→ 404. Falta: (a) o app do Google está em "Testando": só os e-mails cadastrados como usuário de teste entram; para
outros organizadores, publicar o app do Google ("Em produção") ou cadastrá-los; (b) nenhum cron do coletor de
resultados (`results-collector` não publicado; resultado entra à mão ou pela busca no app); (c) o plano grátis pausa
o projeto por inatividade (passo 9 do piloto, decisão dele); (d) feito em 12/10 à noite no app publicado, com o "Bolão de teste" da "Turma de teste":
link pessoal (201/200/410), cartão sem login, pagamento e cota confirmados (4 `review_decide` 200), plano e trava,
comprovante enviado (`evidence_upload` 200, "Original verificado", hash igual) e conferência "Registro completo";
só o download do original pelo servidor ficou sem teste (o aparelho usa a cópia local; precisa de outro aparelho).
Em 12/10 à noite: migrações `group_pix` e `settlement_close` aplicadas no projeto real (`db push --yes`), função `api`
republicada, app republicado (main 19f5e94) e o fluxo "Manter o Supabase acordado" rodou verde à mão.

## BAIXA — dívida interna, ninguém vê

## O que o dono ainda vai contar

O que ele reportar entra aqui, nas palavras dele e com a data, até ganhar número numa seção acima.
