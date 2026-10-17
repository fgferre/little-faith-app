# Pendências — o que está quebrado e o que falta

Lista viva do que está aberto. Leia só a seção O BASTÃO e o item da vez; o resto, por `grep`.
Item resolvido sai da lista e vira commit com o número entre parênteses; a história de cada número fica no git (`git log --all --grep="(NNN)"`).
Número é identidade, não posição: item novo entra no fim da sua seção. **Próximo número livre: 16.**

## O BASTÃO — onde a rodada parou (17/10, manhã) — CARTÃO, ARRECADAR, DOAÇÃO E PRÓXIMO SORTEIO FEITOS, NÃO PUBLICADOS; PRÓXIMO: PUBLICAR COM O SIM DELE

**Para quem pega agora:** o plano do cartão (`PLAN-cartao.md`, apagado em 17/10; git guarda) terminou: responder pelo cartão
(44c678a, e3005ed, 8f3cc85), doação (808121c) e próximo sorteio automático (a5afbad, desenho aprovado por ele em 17/10 depois de ver as
imagens), mais o ajuste dos testes (4403fc2). `PLAN.md` é o quadro https://claude.ai/artifact/AfAkydz8o4DtoQjhmRVWFU (versão 16).
Produção: em dia até 34a56cc (16/10 à noite). O que veio depois NÃO está publicado e sobe junto, com o sim dele, nesta ordem:
(1) `npx -y supabase@2 db push --yes` com a migração nova `20261016060000_participant_responses.sql` (tabelas de respostas, comprovantes
e lembretes, bucket privado `participant-proofs`, cartão com convite); (2) `npx -y supabase@2 functions deploy api` (5 rotas novas:
responder, comprovante, baixar comprovante, respostas do grupo, lembrete); (3) as 3 variáveis da doação no GitHub (Settings > Variables):
`VITE_DONATION_PIX_KEY` = fgferre@gmail.com, `VITE_DONATION_PIX_NAME` = Felipe Ferreira, `VITE_DONATION_PIX_CITY` = Rio de Janeiro
(sem elas o botão fica escondido); (4) push e `gh workflow run deploy.yml --ref main`. `npm run done` verde em 17/10 (343 unitários,
20 da API, SQL no PGlite, 52 fluxos; os fluxos do cartão rodam depois dos financeiros, projeto "cartão" do Playwright, porque os dois
reiniciam o mesmo cenário; a consulta à CAIXA é simulada em todos os fluxos por `tests/e2e/caixa.ts`). Esperando ele: o sim para
publicar; ler a política de privacidade (https://fgferre.github.io/little-faith-app/privacidade.html) para destravar o item 10;
pipo-labs.com (compra dele).

**O que mudou no uso (16 e 17/10), para contar a ele:**
- Cartão: lista também os bolões abertos em que a pessoa ainda não tem cota ("Vai entrar nesta rodada?"), com "Estou dentro",
  "Desta vez estou fora" e "Já paguei" (valor; comprovante opcional, foto ou PDF até 10 MiB). A resposta é registro só de acréscimo no
  servidor, presa ao link e ao PIN, com chave de idempotência do aparelho (a nova tentativa repete a mesma); vale a última; só entra
  enquanto o bolão é rascunho e o sorteio não passou; nunca cria cota nem move dinheiro. Sem conexão o cartão diz que não enviou.
- Arrecadar: selos Dentro, Pix avisado, Fora (e Pago e Pagamento em conferência, como antes); seções Conferir pagamento, Lembrar, Fora
  desta rodada e Já pagaram (rótulos só quando há mais de uma); "Conferir" cria a proposta de pagamento de sempre, com a observação
  "Avisado pelo cartão em …", e abre a Revisão; "Ver comprovante" abre o arquivo em outra aba; quem disse "dentro" sem cota aparece na
  Chamada com "Entrou" (1 cota); quem disse "fora" fica à parte; reenviar o link (WhatsApp ou Copiar) anota "lembrado <quando>" no
  servidor. O convite do grupo diz "Responda no seu cartão: dentro ou fora.". Sem conta, sem conexão ou na demonstração as respostas
  não carregam e a lista fica como antes (sem dizer que ninguém respondeu).
- Doação: "Manter o Little Faith" em Dados (QR Code e copia e cola sem valor fixo: o código Pix sai sem o campo do valor) e uma linha
  depois de encerrar um bolão ("Apoiar o app" / "Agora não", some para sempre no aparelho).
- Próximo sorteio: o aparelho lê a API da CAIXA (o servidor leva 403) uma vez para a modalidade do bolão da vez (Mega-Sena sem bolão),
  guarda por 3 h com a hora da coleta e, se a busca falha, mantém o último dado dizendo de quando é (espera que cresce a cada falha);
  sem dado, "Estimativa indisponível". Início: cartão com prêmio estimado em destaque, concurso e dia (data sem hora fica data),
  "Acumulou", os valores especiais num detalhe "Acumulado para concursos especiais" (nunca somados), "Abrir a rodada" e "Fonte: CAIXA ·
  atualizado …". Barra lateral: "Acumulou. Dia de fezinha." com o prêmio, ou "Vai uma fezinha?". Convite do grupo começa com
  "Mega-Sena 3071 · domingo, 18/10. Acumulou. Prêmio estimado: R$ 170 milhões." quando o concurso do bolão é o próximo (ou não tem
  número). Cartão: "R$ 170 mi estimado · acumulou" e o dia, no bolão em rascunho sem resultado. Conferido ao vivo em 17/10.
- Decidido por mim, sem ele (dizer): "Já paguei" aceita sem comprovante; o comprovante vai para um bucket próprio, só o organizador lê,
  nada é apagado; quando já existe proposta pendente, a linha mostra "Pix avisado" e o "Conferir" não aparece (o resto se resolve na
  Revisão); o botão "Ver comprovante" do descasamento de valor virou "Ver na Revisão"; os selos entraram na lista atual de Arrecadar,
  sem redesenhar a linha com avatar como no mock.
- Não feito, de propósito: prazo do Pix em destaque no cartão (Astra, item c); limite de taxa nas rotas públicas (BACKLOG); cota criada
  pelo servidor (fora do escopo do plano).

**Contexto que não está no código:**
- No app publicado o bolão real "Mega 14/10 150MM" (concurso 3070) está completo: 10 pessoas pagas, 17 bilhetes conferidos, travado,
  resultado manual, sem prêmio, sobra R$ 2; o prazo foi mudado para 15/10 23h só para o ensaio. Links pessoais foram só ao grupo "Teste".
- Modo sombra (decisão dele, 13/10): a turma não sabe do app; nada vai ao grupo pela nossa mão. Ensaios vão para o grupo
  "Teste" dele. Fatos da Confraria, bilhetes lidos, fotos e links com token em `.tmp/bastao/` (fora do git de propósito:
  nomes de terceiros; nunca CPF, chave Pix ou id de transação no repositório). Pipo = ele; peri = Rodrigo Vieira.
- Decidido por ele em 16/10: o app é o organizador, a pessoa do dinheiro e do bilhete é o tesoureiro, o app lembra e nunca cobra,
  "little faith" brinca com "fezinha", os apps dele assinam "um app da Pipo Labs" (pipolabs.com está à venda por US$ 10.595;
  sugerido pipo-labs.com, livre, compra dele). Nada de API oficial do WhatsApp nem robô não oficial (13/10).
- O WhatsApp Web ficou ligado no Chrome dele (código por telefone): dá para ler o grupo pelo Claude in Chrome. O acesso
  ao WhatsApp do Mac pede a janela de permissão, que ele só aprova estando no Mac.
- O CLI do Supabase trava quando ele está remoto (chaveiro do Mac); aí a migração vai pelo SQL Editor no Chrome dele (texto
  da migração mais o `insert` em `supabase_migrations.schema_migrations`). Com ele no Mac (16/10), `npx -y supabase@2 migration list`,
  `db push --yes` e `functions deploy api` funcionaram. O app só republica à mão: `gh workflow run deploy.yml --ref main` depois do push.
- Trabalho no navegador sai caro na conversa principal: preencher telas com um comando de página por lote, ler a área de
  transferência com `pbpaste` (o app só copia com clique de verdade), e o Claude in Chrome esconde saídas com base64 ou
  query string. Na tela do organizador só dá para ver respostas pelo Playwright com as rotas simuladas (`SHOTS=1` no fluxo de
  Arrecadar gera `.tmp/cartao/arrecadar-<largura>.png`); a demonstração não tem servidor.
- `origin` = github.com/fgferre/little-faith-app (público); app em https://fgferre.github.io/little-faith-app/ ligado ao
  Supabase real; login Google só para o e-mail dele. Régua de layout em `styles.css :root` (quadro
  https://claude.ai/artifact/NRJqXNXzy6aaSC7YC9nroT); nunca px solto. Da rodada de layout ainda esperam o sim dele: o teste
  "`#/p/demo` mostra o cartão da Isabela sem chamar o servidor" e as regras de lint "sem px fora da régua" e
  "sem prefers-reduced-motion: reduce".

**A FILA (uma lista só, nesta ordem; quem pegar começa pelo primeiro aberto):**
16. Publicar a rodada de 16 e 17/10 (ordem acima no bastão), com o sim dele.
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
