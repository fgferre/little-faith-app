# Pendências — o que está quebrado e o que falta

Lista viva do que está aberto. Leia só a seção O BASTÃO e o item da vez; o resto, por `grep`.
Item resolvido sai da lista e vira commit com o número entre parênteses; a história de cada número fica no git (`git log --all --grep="(NNN)"`).
Número é identidade, não posição: item novo entra no fim da sua seção. **Próximo número livre: 14.**

## O BASTÃO — onde a rodada parou (13/10) — PRAZO DO PRÊMIO, ENVIO COM UM TOQUE E O MODO SOMBRA DO PRIMEIRO BOLÃO DE VERDADE

**Estado:** etapas 1–6 da especificação feitas; fila 1–6 feitas em 12–13/10. Em 13/10: fila 8 feita (prazo de resgate com
contagem de dias e tom de aviso em Dividir e no cartão da pessoa; migração `20261013020000_participant_card_deadline.sql`
expõe `redemptionDeadlineDate`/`prizeRedeemed` no cartão); "Acumulou! Prêmio estimado" entra na chamada da turma (uma
leitura só, `rolloverOf`, para Sorteio e Arrecadar); "Enviar no WhatsApp" + "Copiar" em todas as mensagens prontas
(cobrança, chamada, link pessoal, repasse ao registrador, resultado), pelo link oficial `wa.me`, sem telefone por pessoa.
`main` = 4b52fea, enviado ao GitHub. **Verificado em 13/10:** `npm run done` verde duas vezes (tipos, lint, 320 testes,
SQL no PGlite, 16 da API, build, 40 fluxos no navegador); capturas em `.tmp/visual/` (apagável).

**PENDENTE DE PRODUÇÃO (ordem obrigatória):** 1) migração `20261013020000` ainda NÃO aplicada no servidor
(`npx -y supabase@2 db push --yes`); 2) app ainda NÃO republicado com os três commits de 13/10 (`gh workflow run
deploy.yml --ref main`). O classificador do modo automático barrou os dois (e alguns "Salvar" no app publicado) mesmo
depois de ele criar `.claude/settings.local.json` com as regras de allow: em modo automático a regra não vale; vale em
modo padrão (ele troca o modo na própria janela) ou ele roda os comandos à mão. Quem pegar a próxima conversa confere
`npx -y supabase@2 migration list` e `gh run list --workflow=deploy.yml --limit 1` antes de qualquer coisa.

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
1. Aplicar a migração e republicar (ver PENDENTE DE PRODUÇÃO).
2. Modo sombra do bolão "Mega 14/10 150MM" até a divisão (ver acima); cadastrar o resto do grupo; conferir o fuso.
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

## MÉDIA — afeta o produto

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
