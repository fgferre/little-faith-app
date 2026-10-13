# Piloto: do zero ao primeiro bolão de verdade

Roteiro para ligar o app a um Supabase real, ao login do Google e ao GitHub Pages. Siga na ordem. Cada passo diz o que fazer, o que colar onde, o que **não** compartilhar e como conferir.

**Legenda.** [SUA CONTA] marca o passo que pede uma conta ou chave sua; ninguém faz isso por você. Troque `<ref>` pelo código do projeto Supabase, `<usuario>` pelo seu usuário do GitHub e `<repo>` pelo nome do repositório (sugestão: `little-faith-app`).

**Nunca vai para o navegador, para o repositório nem para o chat:** a chave `service_role`, a senha do banco, o "Client secret" do Google e o `RESULTS_JOB_SECRET`. A URL do projeto e a chave `anon` são públicas por desenho e podem ir no app.

## 1. Criar o projeto no Supabase [SUA CONTA]
- **Fazer:** em supabase.com, crie conta, depois **New project**. Escolha a região **South America (São Paulo)**: o grupo está no Brasil. Defina uma senha do banco e guarde-a num gerenciador de senhas.
- **Colar:** nada ainda. Anote o código do projeto (`<ref>`, aparece na URL do painel) e, em **Project Settings > API**, a URL (`https://<ref>.supabase.co`) e a chave pública `anon` (ou `publishable`).
- **Não compartilhar:** a senha do banco e a chave `service_role`, que aparece na mesma tela.
- **Conferir:** o painel abre sem aviso de "provisioning" e a URL acima responde no navegador (mostra uma resposta curta de erro pedindo chave; isso é normal).

## 2. Aplicar as migrations (o banco) [SUA CONTA]
São seis arquivos em `supabase/migrations/`, **nesta ordem** (a do nome mais novo é a última): `20261007000000_foundation.sql`, `20261007010000_financial.sql`, `20261008000000_planning.sql`, `20261008010000_registration_results.sql`, `20261010000000_settlement.sql`, `20261011000000_participant_links.sql`.
- **Fazer (jeito A, sem instalar nada):** no painel, **SQL Editor > New query**. Abra o primeiro arquivo, copie tudo, cole e toque em **Run**. Repita para cada arquivo, um de cada vez, na ordem. Não rode o mesmo arquivo duas vezes.
- **Fazer (jeito B, com a CLI):** instale a CLI do Supabase e, na pasta do projeto, rode `supabase login`, `supabase link --project-ref <ref>` e `supabase db push` (pede a senha do banco; digite só no terminal).
- **Se der erro:** pare, copie a mensagem inteira e traga para a conversa. Não pule arquivo.
- **Conferir:** em **Table Editor** aparecem `groups`, `draft_records`, `received_payments` e outras; em **Storage** existe o bucket privado `evidence`.

## 3. Segredos e a função `api` [SUA CONTA]
- **Fazer:** em **Edge Functions > Secrets** (ou `supabase secrets set ...`), crie `API_ALLOWED_ORIGINS` com as origens do app separadas por vírgula, **sem caminho e sem barra no fim**: `https://<usuario>.github.io,http://127.0.0.1:4173`. Depois publique a função: `supabase functions deploy api` (a CLI usa o `config.toml`, que desliga a verificação de login do gateway: a função valida a sessão sozinha e o cartão do participante é público por desenho).
- **Já vêm prontos:** a URL, a chave `anon` e a `service_role` chegam à função sozinhas pelo Supabase. Não cole a `service_role` em lugar nenhum.
- **Só se quiser resultados automáticos (pode pular no piloto):** crie o segredo `RESULTS_JOB_SECRET` (texto aleatório de 32+ caracteres, por exemplo `openssl rand -hex 32`) e rode `supabase functions deploy results-collector --no-verify-jwt`. Isso **não** liga agendamento nenhum: sem ele, o resultado continua sendo buscado dentro do app ou informado à mão.
- **Se o deploy reclamar de arquivo não encontrado em `packages/core`:** pare e traga a mensagem; a função importa código de fora da pasta `supabase/`.
- **Conferir:** em **Edge Functions**, `api` aparece ativa. Teste opcional (a chave `anon` é pública): `curl -i -H "apikey: <anon>" -H "Authorization: Bearer <anon>" https://<ref>.supabase.co/functions/v1/api/v1/groups` deve dar **401** com a mensagem em português "Sua sessão precisa ser renovada".

## 4. Login com Google [SUA CONTA]
- **Fazer no Google:** em console.cloud.google.com crie um projeto. Em **Google Auth Platform** (ou **APIs e serviços > Tela de consentimento OAuth**) preencha o nome do app e seu e-mail, público **Externo**. Em **Clientes > Criar cliente**, tipo **Aplicativo da Web**. Em **URIs de redirecionamento autorizados**, cole a URL de retorno do Supabase: `https://<ref>.supabase.co/auth/v1/callback` (aparece em **Authentication > Sign In / Providers > Google**).
- **Colar no Supabase:** ainda em **Providers > Google**, ligue o provedor e cole o **Client ID** e o **Client secret** gerados pelo Google. Em **Authentication > URL Configuration**, ponha em **Site URL** `https://<usuario>.github.io/<repo>/` (com a barra final) e inclua em **Redirect URLs** esse mesmo endereço e `http://127.0.0.1:4173/`.
- **Não compartilhar:** o Client secret só entra no painel do Supabase.
- **Pessoas de teste:** enquanto o app do Google estiver em "Teste", só entram os e-mails cadastrados como usuários de teste. Para a turma toda, publique o app do Google ("Em produção"); com só nome e e-mail ele não pede verificação. Decisão sua.
- **Conferir:** o provedor Google aparece ligado. A prova real é o passo 5.

## 5. Conferir no seu computador [SUA CONTA]
- **Fazer:** na pasta do projeto, copie `.env.example` para `.env` e preencha. O `.env` nunca vai para o git (já é ignorado).
  - `VITE_SUPABASE_URL` = `https://<ref>.supabase.co`
  - `VITE_SUPABASE_ANON_KEY` = a chave `anon`
- **Rodar:** `npm run build && npm run preview` e abra `http://127.0.0.1:4173/`. Vá em **Dados e integrações > Entrar com Google**.
- **Não compartilhar:** o conteúdo do `.env` (a chave `anon` é pública, mas o arquivo não precisa circular).
- **Conferir:** depois do login aparece sua conta e o estado sincronizado. Crie um grupo de teste, recarregue a página e veja uma linha nova na tabela `groups` no painel. Se o login voltar com erro, revise as URLs do passo 4 e a origem do passo 3.

## 6. Criar o repositório e subir o código [SUA CONTA]
- **Fazer:** em github.com, **New repository** com o nome `<repo>`. Atenção: GitHub Pages em conta gratuita só funciona com repositório **público** (o código não tem dado de grupo nem chave); repositório privado pede plano pago. Decisão sua.
- **Colar (terminal, na pasta do projeto):** `git remote add origin https://github.com/<usuario>/<repo>.git` e `git push -u origin main`. **O primeiro envio é decisão sua.** Antes, confira que `git status` não lista `.env`.
- **Não compartilhar:** nenhuma chave no código. O CI ("Verificar") roda sozinho a cada envio, mas só verifica; **não publica**.
- **Conferir:** a aba **Actions** mostra a execução "Verificar".
- **Feito em 11/10:** o repositório `fgferre/little-faith-app` foi criado **privado** e `main` foi enviado. Para o passo 7 (Pages grátis) ele precisa virar público: Settings > General > Danger Zone > Change visibility. Decisão sua.

## 7. Publicar no GitHub Pages [SUA CONTA]
- **Fazer:** no repositório, **Settings > Pages > Build and deployment > Source: GitHub Actions**.
- **Colar:** em **Settings > Secrets and variables > Actions > aba Variables > New repository variable**, crie `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` com os mesmos valores do `.env`. São variáveis (não segredos) porque ficam dentro do app publicado.
- **Publicar:** aba **Actions > Publicar no GitHub Pages > Run workflow** (branch `main`). Nada publica por commit: cada publicação nova é um clique seu.
- **Não compartilhar:** não cadastre a `service_role` aqui.
- **Conferir:** o fluxo termina verde e mostra o endereço `https://<usuario>.github.io/<repo>/`. Abra, entre com Google e repita o teste do passo 5. Esse endereço precisa ser igual ao do passo 4 (retorno) e ao do passo 3 (origem).

## 8. O primeiro bolão de verdade
Entre com Google **antes** de criar o grupo (cada conta tem seu próprio espaço) e toque em **Criar meu grupo**.
1. **Montar:** escolha concurso, modalidade, preço da cota e **Pagar até**; cadastre as pessoas e as cotas; publique os combinados e registre o aceite de cada um.
2. **Arrecadar:** a cada Pix, **Registrar pagamento**, depois **Conferir recebimento** e **Confirmar no servidor**.
3. **Jogar:** veja os jogos, **Aplicar o plano** e **Travar o bolão** antes do prazo, escolhendo quem registra a aposta.
4. **Registrar:** na lotérica ou no canal oficial; fotografe os comprovantes, envie os originais e faça **Conferir o registro**.
5. **Sorteio:** com o concurso publicado, busque o resultado ou use **Informar resultado**, e confirme qual vale.
6. **Dividir:** confirme o custo das apostas e o prêmio; registre o resgate e o pagamento de cada pessoa. Erro se desfaz com lançamento contrário. Encerrar o bolão ainda não existe.

**O que vigiar:**
- **Pagamento só vale depois de confirmado online.** Sem internet ou sem login, fica só como proposto e não entra no caixa nem dá direito à cota.
- **Resultado:** se duas fontes divergirem, o app pede para você escolher; confira com o site da CAIXA.
- **Divisão:** confira os valores antes de confirmar; o app não paga ninguém sozinho.
- **Horário:** o grupo está no Brasil e você em UTC-5; confira a hora do prazo e do sorteio no horário de Brasília. O servidor decide o prazo pelo relógio dele.
- **Bilhete original:** o app ainda não registra quem o guarda; combine com o grupo. Prêmio no nome de uma pessoa e repassado pede um contador.

## 9. Projeto pausado e lembrete antes do sorteio [SUA CONTA]
- **Se pausou (plano gratuito):** o Supabase pausa projeto parado por alguns dias (hoje, cerca de uma semana). No painel aparece **Project paused**; toque em **Restore project** e espere alguns minutos. Abra o app online: o que ficou pendente no aparelho é reenviado, e uma resposta perdida é consultada antes de repetir. Confira no painel o prazo para restaurar.
- **Feito em 12/10:** o fluxo "Manter o Supabase acordado" (Actions) visita o banco segunda e quinta, para o projeto não pausar. Se o GitHub desligar o agendamento por falta de atividade (60 dias), rode-o à mão uma vez.
- **Antes do sorteio (2 a 3 dias antes):**
  - Abra o app online com seu login, para acordar o projeto e ver tudo sincronizado.
  - Confira no painel que o projeto está ativo (se o bolão for importante, considere o plano pago na semana do prêmio; decisão e custo seus).
  - Faça a exportação de emergência em **Dados e integrações** (não é backup completo) e guarde-a fora do aparelho.
  - Confirme quem guarda o bilhete original e que o bolão está travado e registrado.
