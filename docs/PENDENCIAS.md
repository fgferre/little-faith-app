# Pendências — o que está quebrado e o que falta

Lista viva do que está aberto. Leia só a seção O BASTÃO e o item da vez; o resto, por `grep`.
Item resolvido sai da lista e vira commit com o número entre parênteses; a história de cada número fica no git (`git log --all --grep="(NNN)"`).
Número é identidade, não posição: item novo entra no fim da sua seção. **Próximo número livre: 16.**

## O BASTÃO — onde a rodada parou (16/10, noite) — RODADA DE 15 E 16/10 PUBLICADA; PRÓXIMO: RESPONDER PELO CARTÃO

**Para quem pega agora:** leia este bastão e o `PLAN-cartao.md` (próxima tarefa, nesta ordem: responder pelo cartão, próximo
sorteio automático, botão de doação com QR; decisões fechadas lá, inclusive chave, nome e cidade do Pix da doação). Antes de começar,
leia `.tmp/critica/astra-2.md` (crítica do GPT-6 Astra com leitura do repositório: cuidados do cartão e do próximo sorteio). `PLAN.md`
é o quadro https://claude.ai/artifact/AfAkydz8o4DtoQjhmRVWFU (versão 16, conceito novo; falta ele escolher a versão da linha, A
recomendada). Produção em dia desde 16/10 à noite, com o sim dele: as 7 migrações de 15 e 16/10 aplicadas (`db push --yes`), função
`api` republicada (cartão, PIN e telefones conferidos no ar) e app republicado a partir de `main` 34a56cc. `npm run done` verde
(339 unitários, 48 fluxos). Decidido por ele em 16/10: o app é o organizador, a pessoa do dinheiro e do bilhete é o tesoureiro, o app
lembra e nunca cobra, "little faith" brinca com "fezinha", os apps dele assinam "um app da Pipo Labs" (pipolabs.com está à venda por
US$ 10.595; sugerido pipo-labs.com, livre, compra dele). Esperando ele: ler a política de privacidade, que já está no ar em
https://fgferre.github.io/little-faith-app/privacidade.html com o texto ainda não aprovado; o sim dele destrava o item 10 da fila.

**Revisão de 16/10 sobre tudo o que não estava publicado:** 14 achados, consertados em 34a56cc a pedido dele. O que muda no uso:
passada a hora do sorteio (quando o app tem o calendário do concurso), não entra cota, plano nem trava, então um ensaio retroativo
como o de 15/10 não dá mais; trocar ou tirar o PIN sempre pede o atual (o aparelho onde ele foi digitado continua abrindo o cartão
sozinho, como ele decidiu); colar jogos ignora "1)", "2.", "Jogo 3 -" e "15/10:" e deixa de fora, com aviso, o que já está no bolão
("1 - 05…" com traço solto ainda conta o 1); a data do pagamento volta a começar vazia; o cartão não conta duas vezes o prêmio que fica
no caixa. A migração da reserva do grupo para sozinha se houver devolução de sobra paga em bolão com sobra no caixa do grupo; em
produção não havia nenhuma.

**Rodada de 15/10:** ensaio retroativo do bolão real "Mega 14/10 150MM" (concurso 3070) até a divisão, com o resultado, a
mensagem da surpresa e os 10 links pessoais mandados só para o grupo "Teste" dele (só ele está lá); nada foi ao grupo da
turma. No app publicado esse bolão está completo: 10 pessoas pagas, 17 bilhetes conferidos, travado, resultado manual,
sem prêmio, sobra R$ 2; o prazo foi mudado para 15/10 23h só para o ensaio (o real era 14/10 18h Brasília). Depois, as
correções que o ensaio pediu (commits 1b59ae2 a d5699a5): revisão do registro clara, colar bilhetes, cartão com resultado
no topo e faixa de boas-vindas, resultado oficial buscado pelo aparelho (a proteção do site da CAIXA barra o servidor com
403), telefone de cada pessoa guardado à parte no servidor e link pessoal abrindo direto na conversa. Quadro da revelação:
https://claude.ai/artifact/6iCZS5eDry2cGmwcGWR1an (as três novidades dele estão feitas). O que continua aberto: item 15.

**Contexto que não está no código:**
- Modo sombra (decisão dele, 13/10): a turma não sabe do app; nada vai ao grupo pela nossa mão. Ensaios vão para o grupo
  "Teste" dele. Fatos da Confraria, bilhetes lidos, fotos e links com token em `.tmp/bastao/` (fora do git de propósito:
  nomes de terceiros; nunca CPF, chave Pix ou id de transação no repositório). Pipo = ele; peri = Rodrigo Vieira.
- O WhatsApp Web ficou ligado no Chrome dele (código por telefone): dá para ler o grupo pelo Claude in Chrome. O acesso
  ao WhatsApp do Mac pede a janela de permissão, que ele só aprova estando no Mac.
- O CLI do Supabase trava quando ele está remoto (chaveiro do Mac); aí a migração vai pelo SQL Editor no Chrome dele (texto
  da migração mais o `insert` em `supabase_migrations.schema_migrations`). Com ele no Mac (16/10), `npx -y supabase@2 migration list`,
  `db push --yes` e `functions deploy api` funcionaram. O app só republica à mão: `gh workflow run deploy.yml --ref main` depois do push.
- Trabalho no navegador sai caro na conversa principal: preencher telas com um comando de página por lote, ler a área de
  transferência com `pbpaste` (o app só copia com clique de verdade), e o Claude in Chrome esconde saídas com base64 ou
  query string.
- Decisões dele (13/10): nada de API oficial do WhatsApp nem robô não oficial; o caminho é tirar trabalho do organizador.
- `origin` = github.com/fgferre/little-faith-app (público); app em https://fgferre.github.io/little-faith-app/ ligado ao
  Supabase real; login Google só para o e-mail dele. Régua de layout em `styles.css :root` (quadro
  https://claude.ai/artifact/NRJqXNXzy6aaSC7YC9nroT); nunca px solto. Da rodada de layout ainda esperam o sim dele: o teste
  "`#/p/demo` mostra o cartão da Isabela sem chamar o servidor" e as regras de lint "sem px fora da régua" e
  "sem prefers-reduced-motion: reduce".

**A FILA (uma lista só, nesta ordem; quem pegar começa pelo primeiro aberto):**
1. Responder pelo cartão: "Estou dentro", "Já paguei" (com comprovante) e "Desta vez estou fora"; o tesoureiro vê selos e confirma
o Pix. Decisão dele em 16/10; cuidados de produto e dados na resposta do Astra em `.tmp/critica/astra-2.md` (item c).
2. Próximo sorteio automático (prêmio estimado, acumulou, data) pela API da CAIXA no aparelho: Início, convite, cartão e barra
lateral; desenho no quadro (`PLAN.md`), riscos no item d da mesma resposta. Esperando o sim dele ao desenho.
3. Doação: o app é grátis e aceita doação; falta ele dizer o canal (chave Pix ou link). Lugares sugeridos: rodapé da página, depois de
encerrar a rodada (raro) e em Dados.
4. Quadro: escolher a versão da linha da pessoa (A recomendada). Página de venda só vai ao ar com o app do Google em produção (item 10).
5. Revelação de verdade para a Confraria (rodada nova), agora que está publicado; anotar o que a turma estranhar.
6. Pagamento confirmado sozinho por provedor de Pix (provedor e conta são dele; tarifa por transação) (~1 dia).
7. Jogos lidos da foto do bilhete, para o organizador só conferir (~1 dia).
8. Busca automática do resultado no horário: o servidor é barrado pela CAIXA (403); repensar antes de agendar.
9. Teimosinha e série de concursos (a Confraria pediu para "repetir os números") (~1 dia).
10. (16/10) O Google só tira do modo de teste com página inicial e política de privacidade públicas no domínio do app. Texto em
`apps/web/public/privacidade.html`, no ar desde 16/10 (https://fgferre.github.io/little-faith-app/privacidade.html), esperando ele
aprovar; depois do sim, ajustar o que ele pedir, republicar e preencher no console a página inicial, a política e o
domínio autorizado fgferre.github.io, e publicar. Antes: publicar o app do Google "em produção" ou cadastrar e-mails (conta dele).
11. Backup completo com senha (etapa 8 da especificação) (~4 h).
12. Pesquisa, rodada 2: ele abre o Loterias Online (maioridade) e conversa com 5 organizadores; eu cruzo.
13. O assistente que lê o WhatsApp (etapa do agente). Depois: participante com conta e convites; foto do bilhete no
cartão por URL temporária; limite de taxa na rota pública (ver BACKLOG).

## ALTA — bloqueia a entrega ou pode perder trabalho

## MÉDIA — afeta o produto

**15. O que o ensaio de 15/10 mostrou (detalhes em `.tmp/bastao/confraria.md`).** Feito em 15/10, a pedido dele: colar bilhetes,
cartão com resultado no topo e jogos do melhor para o pior com faixa de boas-vindas, hora de Brasília nas revisões, cartela divergente
pede explicação antes de confirmar e a recusa fica na janela, números com " · ", resultado oficial buscado pelo aparelho quando a CAIXA
barra o servidor (403 da proteção Azion), telefone por pessoa com o link abrindo direto na conversa. Continua aberto:
- O aceite dos combinados por pessoa, com prova, não existe na vida do grupo (lá "quem paga entra").
- Pagamentos: 2 janelas e ~10 s de espera cada; confirmações às vezes ficam em "Consultar recibo" mesmo aceitas pelo servidor.
- O cartão mostra "Registro com diferença" quando a aposta foi feita antes da trava (caso do ensaio retroativo).
- Quem deixa o app aberto pode ficar numa versão velha até fechar todas as abas (service worker); foi o que causou a tela em branco.
- No celular, com WhatsApp salvo, o número fica numa linha e "Enviar link pessoal" na de baixo; ele decide pela imagem.
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
