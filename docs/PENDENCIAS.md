# Pendências — o que está quebrado e o que falta

Lista viva do que está aberto. Leia só a seção O BASTÃO e o item da vez; o resto, por `grep`.
Item resolvido sai da lista e vira commit com o número entre parênteses; a história de cada número fica no git (`git log --all --grep="(NNN)"`).
Número é identidade, não posição: item novo entra no fim da sua seção. **Próximo número livre: 14.**

## O BASTÃO — onde a rodada parou (12/10) — DIA DO PRÊMIO, CARTÃO DO PARTICIPANTE E REPETIR COM A MESMA TURMA; `npm run done` VERDE

**Estado:** etapas 1–6 da especificação feitas; app inteiro no estilo "Noite do sorteio" afinado. Itens 6 e 7
resolvidos nesta rodada: o titular dos bilhetes aparece em Registrar, Sorteio e Dividir, e Dividir avisa que
imposto e repasse pedem um contador; cada pessoa tem um link pessoal, sem conta e revogável, que abre o cartão
(`#/p/<token>`): cotas e pagamento, jogos com acertos, registro e quem guarda o bilhete, resultado, prêmio e a parte
dela. Servidor: tabela `participant_links` (token só por hash SHA-256), 4 RPCs e a rota pública
`POST /v1/participant_card`; `verify_jwt=false` na função `api` (ela valida a sessão no próprio middleware). O
organizador cria e cancela o link por pessoa em Arrecadar. Item 8 resolvido em 12/10: "Repetir com a mesma turma"
(em Sorteio, quando não houve prêmio, e agora também no fim de Dividir) leva as pessoas com suas cotas e os jogos
(só na mesma modalidade), sugere o concurso seguinte e copia a forma de participação; pagamentos começam do zero;
a cópia não é atômica (uma falha avisa no formulário e não cria segundo bolão). Encerrar/reabrir ficam para depois.

**Verificado em 12/10, nesta sessão:** `npm run done` verde — tipos, lint, 313 testes, SQL no PGlite (o cartão é
conferido contra `computeSettlement` do núcleo), 16 testes da API, build e 37 fluxos no navegador (2 do
participante com rotas simuladas, 1 do repetir pela interface; a API real do link só é coberta pelos testes Deno e SQL). Capturas em
`.tmp/b/` (apagável).

**Decisões dele (11/10):** frente (b) antes do piloto; primeiro push autorizado. **Decisões tomadas aqui, que ele
pode virar:** o cartão não mostra a foto do bilhete (spec: imagem original fora de página compartilhada); cancelar o
link não pede confirmação; um link por pessoa serve a todos os bolões da turma.

**Git:** remoto `origin` = github.com/fgferre/little-faith-app, **privado**, criado com o primeiro push em 11/10;
a rodada foi enviada com a palavra dele (11/10, tarde); visual do cartão aprovado por ele. GitHub Pages grátis exige repositório
público (passo 7 do piloto): decisão dele. **Fora daqui:** sem Supabase real, OAuth Google, cron ou deploy
(item 5). Nenhum subagente ativo. Não há `PLAN.md`.

**Textos pedidos por ele, já aplicados:** marca *"Seu bolão em boa companhia"*; início *"Faça sua fezinha, organize
suas apostas e boa sorte!"*.

**A próxima rodada — a ordem é dele:** (a) o piloto (`docs/PILOTO.md`; cada passo com conta ou chave é dele);
(d) a demonstração com um bolão inteiro, com prêmio (11); (e) os fluxos que oscilam sob carga (13). Depois do piloto: participante com conta e convites; foto do bilhete no cartão por URL
temporária; limite de taxa na rota pública (ver BACKLOG).

## ALTA — bloqueia a entrega ou pode perder trabalho

**13. Fluxos de navegador oscilam por corridas de sincronização (11/10).**
Sob carga, `financial.spec.ts` abre diálogos antes de a sincronização terminar (linhas ~97/102, 626, 1060, 1144,
1199) e falha em ~1 de 4 rodadas; sozinho passa. A parte do planejador (página pulando durante a simulação) foi
resolvida na E5b-1. Resolver trocando esperas por tempo por esperas por estado ("Sincronizado" visível) nesses pontos.

## MÉDIA — afeta o produto

**4. A exportação de emergência não é backup (10/10).**
O export atual é `bolao-emergency-v5`, sem criptografia; não apresentar como backup completo. `@zip.js/zip.js@2.23.0`
já está instalado no web; codec e interface do backup (etapa 8) não foram escritos.

**5. Nada foi conferido contra o Supabase real (10/10).**
Sem projeto conectado, OAuth Google, dois aparelhos, cron do coletor (`results-collector` preparado, nenhum cron
instalado) nem deploy; as credenciais não estão neste checkout. Os testes usam Auth/Storage simulados e RPCs reais no
PGlite. Conectar pede a palavra dele; o passo a passo está em `docs/PILOTO.md` (11/10). O plano grátis do Supabase
pausa por inatividade: um bolão mensal pode achar o servidor dormindo no dia do prêmio. Risco a conferir no primeiro
`supabase functions deploy`: a função importa `packages/core` de fora de `supabase/`; se o empacotador recusar, mover
o núcleo usado pela função para `supabase/functions/_shared` ou mapear no `deno.json`.

**11. A demonstração para antes do melhor (revisão de 10/10).**
Registro, resultado e divisão não aparecem no modo de exemplo, e a Revisão some nele. A demonstração devia mostrar um
bolão inteiro, com prêmio.

## BAIXA — dívida interna, ninguém vê

## O que o dono ainda vai contar

O que ele reportar entra aqui, nas palavras dele e com a data, até ganhar número numa seção acima.
