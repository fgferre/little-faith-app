# Pendências — o que está quebrado e o que falta

Lista viva do que está aberto. Leia só a seção O BASTÃO e o item da vez; o resto, por `grep`.
Item resolvido sai da lista e vira commit com o número entre parênteses; a história de cada número fica no git (`git log --all --grep="(NNN)"`).
Número é identidade, não posição: item novo entra no fim da sua seção. **Próximo número livre: 14.**

## O BASTÃO — onde a rodada parou (12/10) — DIA DO PRÊMIO, CARTÃO, REPETIR E A DEMONSTRAÇÃO INTEIRA; `npm run done` VERDE

**Estado:** etapas 1–6 da especificação feitas; app inteiro no estilo "Noite do sorteio" afinado. Itens 6 e 7
resolvidos nesta rodada: o titular dos bilhetes aparece em Registrar, Sorteio e Dividir, e Dividir avisa que
imposto e repasse pedem um contador; cada pessoa tem um link pessoal, sem conta e revogável, que abre o cartão
(`#/p/<token>`): cotas e pagamento, jogos com acertos, registro e quem guarda o bilhete, resultado, prêmio e a parte
dela. Servidor: tabela `participant_links` (token só por hash SHA-256), 4 RPCs e a rota pública
`POST /v1/participant_card`; `verify_jwt=false` na função `api` (ela valida a sessão no próprio middleware). O
organizador cria e cancela o link por pessoa em Arrecadar. Item 8 resolvido em 12/10: "Repetir com a mesma turma"
(em Sorteio, quando não houve prêmio, e agora também no fim de Dividir) leva as pessoas com suas cotas e os jogos
(só na mesma modalidade), sugere o concurso seguinte e copia a forma de participação; pagamentos começam do zero;
a cópia não é atômica (uma falha avisa no formulário e não cria segundo bolão). Item 11 resolvido em 12/10: a
demonstração ganhou o bolão "Mega da sexta" (Mega-Sena 2999), travado, registrado com comprovante, com quadra
premiada (R$ 1.287,20), prêmio confirmado e resgatado e 6 de 8 repasses feitos; semeado em `demo-sorteado.ts` com as
funções do núcleo e validado pelo núcleo; quem já tinha a demo recebe só o bolão novo. Bolões, Histórico e a tela do
bolão passam a ler a liquidação também na demo. Encerrar/reabrir ficam para depois.

**Verificado em 12/10, nesta sessão:** `npm run done` verde — tipos, lint, 313 testes, SQL no PGlite (o cartão é
conferido contra `computeSettlement` do núcleo), 16 testes da API, build e 39 fluxos no navegador (2 do
participante com rotas simuladas, 1 da chamada ao repetir, 1 do acumulado, 1 da demonstração inteira; a API real do link só é
coberta pelos testes Deno e SQL). Capturas em
`.tmp/b/` (apagável).

**Decisões dele (11/10):** frente (b) antes do piloto; primeiro push autorizado. **Decisões tomadas aqui, que ele
pode virar:** o cartão não mostra a foto do bilhete (spec: imagem original fora de página compartilhada); cancelar o
link não pede confirmação; um link por pessoa serve a todos os bolões da turma.

**Git:** remoto `origin` = github.com/fgferre/little-faith-app, **privado**, criado com o primeiro push em 11/10;
a rodada foi enviada com a palavra dele (11/10, tarde); visual do cartão aprovado por ele. GitHub Pages grátis exige repositório
público (passo 7 do piloto): decisão dele. **Fora daqui:** sem Supabase real, OAuth Google, cron ou deploy
(item 5). **Mudou em 12/10:** piloto feito até o passo 7 com ele presente; app publicado em
https://fgferre.github.io/little-faith-app/ ligado ao Supabase real; o que falta está no item 5. Repositório agora
**público** por decisão dele (12/10). O redesign visual ("Noite em boa companhia") já está em `main` desde 12/10 (aprovado por ele na sessão do
redesign, juntado por fast-forward com suíte verde) e **publicado** em 12/10 à noite no GitHub Pages (main 5bb6678);
quem tinha o app aberto antes vê o visual novo ao fechar e reabrir a aba (o service worker troca na reabertura). Nenhum subagente ativo. Não há `PLAN.md`.

**Textos pedidos por ele, já aplicados:** marca *"Seu bolão em boa companhia"*; início *"Faça sua fezinha, organize
suas apostas e boa sorte!"*.

**Pesquisa de mercado (12/10):** `docs/PESQUISA-MERCADO.md` — Caixa, 14 apps, ~340 avaliações lidas, cruzamento com o
app e 12 oportunidades. **Feito em 12/10 por decisão dele:** repetir não copia cotas; leva os jogos e abre a "Chamada" em Arrecadar (quem
estava na rodada passada, "Entrou" por pessoa, "Todos entraram", "N ainda não responderam", mensagem pronta); o
Sorteio lê do resultado oficial (texto bruto da Caixa, sem campo novo) que acumulou e o prêmio estimado do próximo
concurso, e o botão vira "Chamar a turma: concurso N+1". Regra dele (12/10): "sempre que houver oportunidade para
melhorar a UX, nunca diremos não". Piloto começado em 12/10 com ele presente (passo 1, Supabase).

**A FILA (12/10, uma lista só, nesta ordem; quem pegar a próxima conversa começa pelo primeiro item aberto e
marca aqui o que fechar):**
1. ~~Testar no servidor real o comprovante e o link do participante~~ FEITO em 12/10 (ver item 5; relatório em
   `.tmp/piloto/item1.md`). O "Bolão de teste" ficou travado e registrado, sem sorteio.
2. ~~Aviso semanal automático para o Supabase não pausar~~ FEITO em 12/10 (`.github/workflows/manter-acordado.yml`,
   segunda e quinta; primeira execução à mão verde).
3. ~~Encerrar o bolão~~ FEITO em 12/10 à noite: o servidor recusava de propósito; a migração
   `20261013010000_settlement_close.sql` passa a aceitar `pool_settle`/`pool_reopen` espelhando o núcleo (testes de
   paridade em settlement.sql), e Dividir ganhou o cartão "Encerrar o bolão"/"Reabrir o bolão".
4. ~~Pix na cobrança e no cartão~~ FEITO em 12/10 à noite: `pix` opcional no grupo (migração
   `20261013000000_group_pix.sql` + núcleo `pix.ts` com BR Code e CRC conferidos contra o manual do BC), "Cobrar por
   Pix" em Arrecadar (QR + copia e cola, `uqr`), cartão "Pagar sua cota" no cartão pessoal; confirmação continua manual.
5. ~~Juntar o redesign em `main` e republicar~~ FEITO em 12/10 (main = 5bb6678 publicado). O worktree
   `…/Little Faith App-redesign` pode ser removido (`git worktree remove`), com a palavra dele.
6. Fluxos de navegador que oscilam sob carga (item 13): trocar esperas por tempo por esperas por estado (~2 h).
   (Puxado para antes do bolão real por decisão dele, 12/10: cada rodada perde ~3 reexecuções por causa disso.)
7. O primeiro bolão de verdade, pequeno, com ele presente e acompanhado de perto.
8. Avisos de prazo do prêmio (30/15/7/1 dias) de volta na tela do bolão e no cartão (~1 h).
9. Mensagens prontas para o grupo: resultado do sorteio e chamada quando acumula com "Acumulou!" (~1 h).
10. Busca automática do resultado no horário (publicar `results-collector`, segredo e agendamento) (~2 h + conta dele).
11. "Estou dentro" e "paguei" (com comprovante) pelo cartão do participante (~3 h).
12. Outros organizadores entrando com Google: publicar o app do Google "em produção" ou cadastrar e-mails (conta dele).
13. Backup completo com senha (etapa 8 da especificação) (~4 h).
14. Teimosinha e série de concursos paga adiantado (~1 dia).
15. Pesquisa, rodada 2: ele abre o Loterias Online (maioridade) e conversa com 5 organizadores; eu cruzo.
16. O assistente que lê o WhatsApp (etapa do agente, depois do piloto por decisão dele). Depois do piloto: participante com conta e convites; foto do bilhete no cartão por URL
temporária; limite de taxa na rota pública (ver BACKLOG).

## ALTA — bloqueia a entrega ou pode perder trabalho

**13. Fluxos de navegador oscilam por corridas de sincronização (11/10).**
Sob carga, `financial.spec.ts` abre diálogos antes de a sincronização terminar (linhas ~97/102, 626, 1060, 1144,
1199; em 12/10 também a linha 842, "a lock review rejects…", que espera o aviso "mesma versão"; e, relatado pela sessão do redesign em 12/10, a linha ~1335, "repeating with the
same group…", esperou 2 min pelo botão "Repetir com a mesma turma") e falha em ~1 de 4 rodadas; sozinho passa. A parte do planejador (página pulando durante a simulação) foi
resolvida na E5b-1. Resolver trocando esperas por tempo por esperas por estado ("Sincronizado" visível) nesses pontos.

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
