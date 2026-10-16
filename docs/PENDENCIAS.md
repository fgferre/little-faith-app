# Pendências — o que está quebrado e o que falta

Lista viva do que está aberto. Leia só a seção O BASTÃO e o item da vez; o resto, por `grep`.
Item resolvido sai da lista e vira commit com o número entre parênteses; a história de cada número fica no git (`git log --all --grep="(NNN)"`).
Número é identidade, não posição: item novo entra no fim da sua seção. **Próximo número livre: 14.**

## O BASTÃO — onde a rodada parou (15/10) — CORREÇÕES DO ENSAIO FEITAS E VERIFICADAS, NADA PUBLICADO; PRÓXIMO: QUADRO DE DESENHO

**Para quem pega agora:** leia este bastão e o `PLAN.md` (a próxima tarefa: quadro com a linha da pessoa em Arrecadar e a
página de venda). `main` local = 863189c, 8 commits à frente do GitHub (`origin/main` = 4659191). No ar: app de 14/10
(85c2392) e banco até `20261013020000`. Nada de 15/10 foi publicado; ele disse "Temos oportunidades ainda que precisamos
endereçar" (15/10), então publicar só com o sim dele, na ordem do item 14. `npm run done` verde em 15/10 (327 unitários,
47 fluxos).

**Revisão externa (15/10, sobre b7baa26):** consertado e verificado no mesmo dia: o cartão mostrava e contava acertos no plano,
não no bilhete registrado (podia anunciar prêmio que não existe); o "Manter o Supabase acordado" mandava um token mal formado e
nunca chegava ao banco; o demonstrativo privado voltou a Dividir. Já resolvidos antes: colar bilhetes, busca do resultado pelo aparelho,
tela branca (bundle velho). Dependem dele: a sobra como reserva (item 15) e o reenvio do link (junto com o quadro).

**Rodada de 15/10:** ensaio retroativo do bolão real "Mega 14/10 150MM" (concurso 3070) até a divisão, com o resultado, a
mensagem da surpresa e os 10 links pessoais mandados só para o grupo "Teste" dele (só ele está lá); nada foi ao grupo da
turma. No app publicado esse bolão está completo: 10 pessoas pagas, 17 bilhetes conferidos, travado, resultado manual,
sem prêmio, sobra R$ 2; o prazo foi mudado para 15/10 23h só para o ensaio (o real era 14/10 18h Brasília). Depois, as
correções que o ensaio pediu (commits 1b59ae2 a d5699a5): revisão do registro clara, colar bilhetes, cartão com resultado
no topo e faixa de boas-vindas, resultado oficial buscado pelo aparelho (a proteção do site da CAIXA barra o servidor com
403), telefone de cada pessoa guardado à parte no servidor e link pessoal abrindo direto na conversa. Quadro da revelação:
https://claude.ai/artifact/6iCZS5eDry2cGmwcGWR1an (as três novidades dele estão feitas). O que continua aberto: itens 14 e 15.

**Contexto que não está no código:**
- Modo sombra (decisão dele, 13/10): a turma não sabe do app; nada vai ao grupo pela nossa mão. Ensaios vão para o grupo
  "Teste" dele. Fatos da Confraria, bilhetes lidos, fotos e links com token em `.tmp/bastao/` (fora do git de propósito:
  nomes de terceiros; nunca CPF, chave Pix ou id de transação no repositório). Pipo = ele; peri = Rodrigo Vieira.
- O WhatsApp Web ficou ligado no Chrome dele (código por telefone): dá para ler o grupo pelo Claude in Chrome. O acesso
  ao WhatsApp do Mac pede a janela de permissão, que ele só aprova estando no Mac.
- O CLI do Supabase trava quando ele está remoto (chaveiro do Mac); migração vai pelo SQL Editor no Chrome dele (texto
  da migração mais o `insert` em `supabase_migrations.schema_migrations`). Antes de publicar: `gh run list --workflow=deploy.yml --limit 1`.
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
1. Quadro de desenho: linha da pessoa em Arrecadar e página de venda (ver `PLAN.md`). Pedido dele em 15/10.
2. Publicar a rodada de 15/10 (item 14), quando ele disser.
3. Revelação de verdade para a Confraria (rodada nova), depois de publicar; anotar o que a turma estranhar.
4. Pagamento confirmado sozinho por provedor de Pix (provedor e conta são dele; tarifa por transação) (~1 dia).
5. Jogos lidos da foto do bilhete, para o organizador só conferir (~1 dia).
6. Busca automática do resultado no horário: o servidor é barrado pela CAIXA (403); repensar antes de agendar.
7. "Estou dentro" e "paguei" (com comprovante) pelo cartão do participante (~3 h).
8. Teimosinha e série de concursos (a Confraria pediu para "repetir os números") (~1 dia).
9. Outros organizadores entrando com Google: publicar o app do Google "em produção" ou cadastrar e-mails (conta dele).
10. Backup completo com senha (etapa 8 da especificação) (~4 h).
11. Pesquisa, rodada 2: ele abre o Loterias Online (maioridade) e conversa com 5 organizadores; eu cruzo.
12. O assistente que lê o WhatsApp (etapa do agente). Depois: participante com conta e convites; foto do bilhete no
cartão por URL temporária; limite de taxa na rota pública (ver BACKLOG).

## ALTA — bloqueia a entrega ou pode perder trabalho

**14. Publicar a rodada de 15/10 (pede o sim dele).** Ordem: 1) aplicar `20261015000000_person_phones.sql` e depois `20261016000000_participant_card_registered_games.sql` pelo SQL Editor
(texto de cada migração mais o `insert` em `supabase_migrations.schema_migrations`, como em 14/10; o app novo sem a segunda mostra todos
os jogos do cartão como "Ainda não conferido"); 2) publicar a função `api` (rotas de
telefone; o CLI trava com ele remoto, ver o bastão de 14/10); 3) enviar `main` ao GitHub e republicar o app. Sem o passo 2 o app publicado
segue funcionando e só o campo de WhatsApp avisa que não carregou. A tela em branco do Sorteio vista em 15/10 era um bundle velho
guardado no navegador (o arquivo nem existe mais no servidor); a correção já estava publicada desde 13/10.

## MÉDIA — afeta o produto

**15. O que o ensaio de 15/10 mostrou (detalhes em `.tmp/bastao/confraria.md`).** Feito em 15/10, a pedido dele: colar bilhetes,
cartão com resultado no topo e jogos do melhor para o pior com faixa de boas-vindas, hora de Brasília nas revisões, cartela divergente
pede explicação antes de confirmar e a recusa fica na janela, números com " · ", resultado oficial buscado pelo aparelho quando a CAIXA
barra o servidor (403 da proteção Azion), telefone por pessoa com o link abrindo direto na conversa. Continua aberto:
- O servidor recusa cota depois do prazo, mesmo com pagamento antes: espelhar uma rodada que já passou exige mudar o prazo.
- A data do pagamento vem como "agora"; é preciso digitar a hora real, senão a cota parece paga fora do prazo.
- O aceite dos combinados por pessoa, com prova, não existe na vida do grupo (lá "quem paga entra").
- A mensagem do link pessoal some ao sair da tela; para reenviar é preciso cancelar e criar outro link. Entra com a linha da pessoa escolhida no quadro
  (o botão Cobrar vale também para quem já foi cobrado); a revisão externa de 15/10 pede que o token continue protegido.
- Pagamentos: 2 janelas e ~10 s de espera cada; confirmações às vezes ficam em "Consultar recibo" mesmo aceitas pelo servidor.
- O cartão mostra "Registro com diferença" quando a aposta foi feita antes da trava (caso do ensaio retroativo).
- Dinheiro, decidir com ele: a sobra marcada "Reserva identificada no grupo" é ignorada pela divisão (`settlement.ts` não lê
  `leftoverPolicy`); o cartão mostra "Devolução R$ 0,00 de R$ 0,20".
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
