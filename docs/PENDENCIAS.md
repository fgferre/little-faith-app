# Pendências — o que está quebrado e o que falta

Lista viva do que está aberto. Leia só a seção O BASTÃO e o item da vez; o resto, por `grep`.
Item resolvido sai da lista e vira commit com o número entre parênteses; a história de cada número fica no git (`git log --all --grep="(NNN)"`).
Número é identidade, não posição: item novo entra no fim da sua seção. **Próximo número livre: 14.**

## O BASTÃO — onde a rodada parou (11/10) — APP INTEIRO NO ESTILO NOVO, ETAPA 6 FEITA, PILOTO PREPARADO; `npm run done` VERDE

**Estado:** etapas 1–6 da especificação feitas no núcleo, no aparelho, no servidor e nas telas. Todas as telas estão
no estilo "Noite do sorteio" afinado (`docs/estilo/DIRECAO.md`): Início com contagem, bolão por etapas (Montar,
Arrecadar, Jogar com jogos por pessoa e ampliados, Registrar, Sorteio com revelação, vitória e derrota, Dividir com
dinheiro de verdade), Revisão, Histórico, Dados, Bolões e formulários em gaveta; cartão de imagem para o WhatsApp.
Encerrar/reabrir o bolão ficam para depois (servidor responde com aviso).

**Verificado em 11/10, nesta sessão, com a máquina quieta:** `npm run done` verde — tipos, lint, 313 testes, SQL no
PGlite (17 respostas da divisão reconstruídas pelo núcleo), 15 testes da API, build e 34 fluxos no navegador. Fotos da
rodada em `.tmp/e5/` (apagável).

**Decisões dele (10–11/10):** piloto antes do agente e do backup completo, *sem data fixa*; estilo afinado, bolas de
metal polido; "os dois em paralelo" (piloto preparado + telas restantes); cada pessoa pode ter vários jogos e jogos
com mais dezenas (feito).

**Git:** commits só locais em `main`, sem remoto e sem push. **Fora daqui:** sem Supabase real, OAuth Google, cron ou
deploy (item 5); o passo a passo está em `docs/PILOTO.md` e cada passo com conta ou chave é dele. Nenhum subagente
ativo. Não há `PLAN.md`: a rodada acabou; o próximo plano nasce do item que ele escolher.

**Textos pedidos por ele, já aplicados:** marca *"Seu bolão em boa companhia"*; início *"Faça sua fezinha, organize
suas apostas e boa sorte!"*.

**A próxima rodada — a ordem é dele:** (a) o piloto (`docs/PILOTO.md`, pede a palavra dele a cada passo); (b) o dia do
prêmio e o participante (itens 6 e 7: quem guarda o bilhete, cartão por pessoa sem conta); (c) repetir bolão com a
mesma turma (8); (d) a demonstração com um bolão inteiro, com prêmio (11); (e) os fluxos que oscilam sob carga (13).

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

**6. O dia do prêmio é a parte mais fraca (revisão de 10/10).**
O app não registra quem guarda o bilhete original (sem ele não se recebe o prêmio) nem trata o prêmio que cai todo no
nome de uma pessoa e é repassado aos outros (imposto e repasse pedem um contador). Antes do piloto.

**7. O participante quase não existe (revisão de 10/10).**
Quem pagou só recebe um link genérico. Falta um cartão por pessoa, sem conta e revogável: minhas cotas, se paguei, os
jogos, a foto do bilhete, o resultado e a minha parte. (A imagem do bolão para o WhatsApp já existe, 11/10.)

**8. Repetir o bolão com a mesma turma (revisão de 10/10).**
É a ação mais comum de quem joga toda semana e ficou na entrega B. Uma cópia simples para o próximo concurso basta.

**11. A demonstração para antes do melhor (revisão de 10/10).**
Registro, resultado e divisão não aparecem no modo de exemplo, e a Revisão some nele. A demonstração devia mostrar um
bolão inteiro, com prêmio.

## BAIXA — dívida interna, ninguém vê

## O que o dono ainda vai contar

O que ele reportar entra aqui, nas palavras dele e com a data, até ganhar número numa seção acima.
