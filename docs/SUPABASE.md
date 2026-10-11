# Configuração do Supabase

O repositório contém cinco migrations, uma função Hono chamada `api`, um ponto de entrada separado para coleta agendada de resultados (`results-collector`) e testes de rascunhos, finanças, planejamento, registro e resultados e divisão do prêmio. O passo a passo, em português simples, para ligar um projeto real, o Google e a publicação está em [PILOTO.md](PILOTO.md). Foram implementados estatutos, aceites, recebimentos, alocações, cotas, estornos, planos aplicados e trava com manifesto privado versionado, além da divisão do prêmio (despesas, prêmio confirmado, resgates e pagamentos). Nenhum projeto Supabase remoto foi criado, conectado ou alterado durante esta implementação. Convites e OAuth de agentes permanecem etapas futuras; o encerramento e a reabertura do bolão são recusados pelo servidor.

## Ambiente local

Requisitos para executar a plataforma completa: Supabase CLI, Docker e `psql`. Deno permite validar/testar a função sem subir a plataforma. Execute os comandos na raiz do projeto; `db reset` apaga somente o banco da instalação local e deve ser usado em um ambiente de desenvolvimento dedicado.

```sh
supabase start
supabase db reset --local
cp supabase/functions/.env.example supabase/functions/.env.local
supabase functions serve api --env-file supabase/functions/.env.local
```

`supabase/config.toml` usa PostgreSQL 17, proíbe login anônimo e deixa Google desabilitado até que o responsável forneça suas credenciais. O arquivo `.env.local` da função é privado. `SUPABASE_URL` e a chave pública são normalmente fornecidos pelo runtime local. A função usa `SUPABASE_PUBLISHABLE_KEY` ou `SUPABASE_ANON_KEY`, junto com o JWT humano enviado pelo cliente. Lê `SUPABASE_SERVICE_ROLE_KEY` somente quando existe, apenas no servidor, para selar originais (`evidence_upload`) e coletar resultados oficiais (`results_collect`); sem ela essas duas operações respondem 503 e as demais seguem normais. Essa chave nunca vai para o navegador nem para o repositório. `RESULTS_JOB_SECRET` (aleatório, 32 caracteres ou mais) só é necessário para a coleta agendada.

Na raiz do monorepo, o Vite lê `.env` ou `.env.local`. Configure as variáveis do frontend:

```dotenv
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=chave-publica-da-instalacao-local
```

Configure `API_ALLOWED_ORIGINS` na função com uma lista de origens separadas por vírgula. O padrão do arquivo de exemplo permite somente `http://localhost:5173`. Se abrir o Vite pelo endereço `http://127.0.0.1:5173`, inclua essa origem explicitamente. A função exige uma lista configurada e não aceita `*`. CORS não substitui autenticação nem RLS: clientes sem o cabeçalho `Origin` continuam exigindo sessão e permissão.

## Google e endereço de retorno

Para habilitar o login Google em desenvolvimento, ative `[auth.external.google]` e forneça `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` e `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET` no ambiente do Supabase local. Cadastre no Google a URL de callback do Auth local, `http://127.0.0.1:54321/auth/v1/callback`, seguindo a [configuração oficial do provedor Google](https://supabase.com/docs/guides/auth/social-login/auth-google).

Para uma futura instalação remota, configure Google no painel de Auth, a URL de callback do projeto e a lista de retornos permitidos. O endereço de retorno do frontend deve incluir o caminho real do GitHub Pages, com barra final, por exemplo `https://usuario.github.io/little-faith-app/`. Use esse mesmo endereço na configuração do frontend e em `site_url`/lista de retornos apropriada. `API_ALLOWED_ORIGINS` deve conter somente a origem, por exemplo `https://usuario.github.io`, sem o caminho do repositório. A configuração em `config.toml` se refere ao ambiente local e não configura automaticamente o projeto hospedado. O frontend envia `redirectTo` igual à origem mais o caminho da página (sem o `#`); para testar o build local com `npm run preview`, cadastre também `http://127.0.0.1:4173/` na lista de retornos e `http://127.0.0.1:4173` em `API_ALLOWED_ORIGINS`.

## Projeto hospedado: região e plano

Crie o projeto na região São Paulo (`sa-east-1`): as pessoas do grupo estão no Brasil e a latência é menor. O projeto novo recebe `SUPABASE_URL`, a chave pública e `SUPABASE_SERVICE_ROLE_KEY` no ambiente da função; o responsável só cadastra os segredos próprios (`API_ALLOWED_ORIGINS` e, se quiser coleta agendada, `RESULTS_JOB_SECRET`). O plano Free tem cotas e pausa o projeto depois de um período sem uso; um bolão mensal pode encontrar o servidor dormindo no dia do prêmio. O app continua abrindo e guardando rascunhos no aparelho, mas confirmações online só voltam depois de retomar o projeto no painel. Não apresente o plano Free como serviço ilimitado ([planos](https://supabase.com/pricing)). Os passos práticos estão em [PILOTO.md](PILOTO.md).

## API v1

Base HTTP: `${SUPABASE_URL}/functions/v1/api/v1`. Todos os endpoints, exceto `jobs/results_collect_due`, exigem `Authorization: Bearer <access_token>` da sessão humana. Uma chave pública identifica o projeto, mas não substitui esse token. O frontend também envia `apikey` quando invoca a função. A função valida o token com `auth.getUser`, verifica o escopo de sessão humana e usa o mesmo token nas chamadas SQL. A plataforma mantém `verify_jwt = true`; consulte a [autenticação das Edge Functions](https://supabase.com/docs/guides/functions/auth) para o comportamento do projeto configurado.

| Método / caminho | Entrada | Resposta |
|---|---|---|
| `GET /groups` | Nenhuma | `{ groups: [{ id, name, role, groupRevision }] }` |
| `POST /sync_push` | `{ operations: DraftOperation[] }`, 1–100 operações | `{ receipts: PushReceipt[] }` |
| `POST /sync_pull` | `{ groupId: UUID, cursor: inteiro }` | `PullResponse`, até 200 alterações |
| `GET /command_status?idempotencyKey=UUID` | Chave já enviada | `PushReceipt` original; 404 se não existe para essa conta |
| `POST /review_decide` | `{ command: FinancialCommand \| PlanningCommand \| SettlementCommand \| RegistrationCommand \| ResultCommand }` | `FinancialReceipt`, `PlanningReceipt`, `SettlementReceipt`, `RegistrationReceipt` ou `ResultReceipt`, com `accepted`, `conflict` ou `rejected` |
| `POST /finance_pull` | `{ groupId: UUID }` | `FinancialSnapshot` completo da revisão capturada |
| `GET /finance_command_status?idempotencyKey=UUID` | Chave financeira já enviada | `FinancialReceipt` original; 404 se não existe para essa conta |
| `POST /plan_pull` | `{ groupId: UUID }` | `PlanningSnapshot` completo da revisão capturada |
| `GET /plan_command_status?idempotencyKey=UUID` | Chave de planejamento já enviada | `PlanningReceipt` original; 404 se não existe para essa conta |
| `POST /settlement_pull` | `{ groupId: UUID }` | `SettlementSnapshot` completo da revisão capturada |
| `GET /settlement_command_status?idempotencyKey=UUID` | Chave de divisão já enviada | `SettlementReceipt` original; 404 se não existe para essa conta |
| `POST /evidence_upload` | `multipart/form-data` com exatamente `metadata` (JSON `EvidenceUploadMetadata`) e `original` (arquivo de até 10 MiB) | `EvidenceMetadata` selado; 503 `evidence_server_unconfigured` sem `SUPABASE_SERVICE_ROLE_KEY` |
| `GET /evidence_status?id=UUID` | Identificador do original | `EvidenceMetadata`; 404 se o original ainda não foi selado ou não é visível para a conta |
| `GET /evidence_download?id=UUID` | Identificador do original selado | Os bytes do original como anexo, após conferir tamanho, tipo e SHA-256 com o selo; 503 `original_integrity_mismatch` se divergirem |
| `POST /registration_pull` | `{ groupId: UUID }` | `RegistrationSnapshot` (manifestos, originais e relatórios de registro) da revisão capturada |
| `GET /registration_command_status?idempotencyKey=UUID` | Chave de conferência de registro já enviada | `RegistrationReceipt` original; 404 se não existe para essa conta |
| `POST /results_pull` | `{ groupId: UUID }` | `ResultSnapshot` (resultados, escolhas e calendários) da revisão capturada |
| `GET /result_command_status?idempotencyKey=UUID` | Chave de decisão de resultado já enviada | `ResultReceipt` original; 404 se não existe para essa conta |
| `POST /results_collect` | `{ groupId: UUID, poolId: UUID }` | `ResultSnapshot` depois de buscar o concurso na fonte oficial da CAIXA; 503 `results_server_unconfigured` sem `SUPABASE_SERVICE_ROLE_KEY` |
| `POST /jobs/results_collect_due` | `{ limit: 1–20 }`; `Authorization: Bearer <RESULTS_JOB_SECRET>` em vez de sessão humana | `{ outcomes: [{ poolId, status }] }`; 503 sem `RESULTS_JOB_SECRET` de 32 caracteres ou mais, 403 se a capacidade não confere |

Os tipos completos estão em `packages/core/src/types.ts`, `financial-types.ts`, `planning-types.ts` e `settlement-types.ts`. Versões e cursores são inteiros entre zero e `9007199254740991`. Dinheiro usa strings canônicas de centavos inteiros até esse limite; pagamentos e alocações são positivos, enquanto movimentos de estorno são negativos. Rascunhos e comandos financeiros têm até 64 KiB por operação; comandos de planejamento e de divisão do prêmio e o corpo HTTP têm até 1 MiB; a exceção é `evidence_upload`, que aceita o original de até 10 MiB mais 64 KiB de metadados. O SQL mede o JSONB serializado e pode recusar um comando próximo desse limite antes do formato compacto da API. Jogos manuais têm `seed: null` e `generationAlgorithmVersion: null`; jogos gerados exigem semente hexadecimal de 256 bits e `generationAlgorithmVersion: "chacha20-lexicographic-rank-v1"`. Os jogos de rascunho usam `caixa-basic-2026-10-07-v1`; o planejamento usa o catálogo completo `caixa-pools-2026-10-08-v1`.

Datas no contrato são UTC ISO, com sufixo `Z` e precisão máxima de milissegundos. O relógio do cliente é uma informação enviada, sem poder para decidir prazo, gravar auditoria ou confirmar operações. Os registros devolvidos usam criação/atualização do servidor.

Exemplo de bootstrap do grupo após login:

```json
{
  "operations": [{
    "apiVersion": "v1",
    "idempotencyKey": "20000000-0000-4000-8000-000000000001",
    "groupId": "10000000-0000-4000-8000-000000000001",
    "entityId": "10000000-0000-4000-8000-000000000001",
    "kind": "group",
    "expectedVersion": 0,
    "createdAt": "2026-10-07T12:00:00.000Z",
    "data": { "name": "Meu grupo", "statute": "Regras em preparação" }
  }]
}
```

Envie primeiro grupo, depois pessoas/bolão e finalmente suas cotas, jogos e propostas. O banco verifica a existência e o tipo das dependências no mesmo grupo. A API executa operações em ordem; cada uma tem sua própria transação. Uma operação aceita produz um registro `state: "synced"`, incrementa `serverVersion` e `groupRevision` e acrescenta recibo, alteração e auditoria. Esse recibo é de sincronização e não é um recibo de pagamento nem da Caixa.

Cotas exigem `adultDeclared: true` na pessoa e custo representável em centavos inteiros: `quotaPriceCents × units` deve ser divisível por 100. Por exemplo, preço `"3001"` e `units: 25` são recusados. Há um limite operacional de 200 pessoas com cotas por bolão; editar uma cota existente continua permitido nesse limite, mas transferi-la verifica a capacidade do destino. Mudar o preço do bolão revalida as cotas existentes antes de aceitar a edição. Rejeições mantêm as versões, dados e fluxo de alterações anteriores e acrescentam somente o recibo de rejeição.

Depois de uma resposta perdida, reenvie o mesmo payload com a mesma chave ou consulte `command_status`. O payload é comparado como JSONB, portanto a ordem das propriedades do objeto não importa; ordem de arrays, valores, versão e horário fazem parte do conteúdo. Reusar uma chave com conteúdo diferente devolve rejeição, preservando o recibo original para consultas. Corrigir uma rejeição ou conflito exige uma chave nova e a versão revista.

O envelope e os dados são validados pelo núcleo na função antes do lote. Entrada malformada retorna HTTP 400. SQL verifica as mesmas estruturas defensivamente e registra rejeições de regras/dependências, sem alteração da entidade. `conflict`/`rejected` em um recibo não são falhas de transporte. HTTP 401 indica sessão inválida, 403 indica acesso/credencial/origem recusados, 413 exige lote menor e 503 permite repetição com as chaves originais. Um erro HTTP depois de comandos aceitos pode omitir seus recibos na resposta do lote; repetir o lote inteiro é seguro.

No aparelho novo, consulte `groups`, faça `sync_pull` com cursor zero e persista o cursor somente com as alterações aplicadas. Enquanto `hasMore` for verdadeiro, consulte a próxima página. A migration não descarta o fluxo de alterações. A coluna de retenção e o erro `cursor_expired` preparam uma mudança futura; antes de usar retenção será preciso implementar uma carga completa que preserve pendências.

## Revisão financeira online

As decisões financeiras exigem a sessão humana do organizador, conexão e `expectedRevision` igual à revisão corrente do grupo. Essa revisão inclui rascunhos, finanças e planejamento. O servidor obtém o mesmo bloqueio transacional do grupo usado na sincronização; uma revisão antiga retorna conflito e exige atualização dos dados e uma nova aprovação.

O envelope HTTP para publicar o texto do estatuto já sincronizado é:

```json
{
  "command": {
    "apiVersion": "v1",
    "idempotencyKey": "20000000-0000-4000-8000-000000000002",
    "groupId": "10000000-0000-4000-8000-000000000001",
    "expectedRevision": 1,
    "action": { "type": "statute_publish", "groupVersion": 1 }
  }
}
```

Os valores de revisão e versão nesse exemplo correspondem somente ao bootstrap anterior. Consulte os dados atuais antes de enviar uma decisão. As ações implementadas são:

| `action.type` | Campos adicionais | Efeito confirmado |
|---|---|---|
| `statute_publish` | `groupVersion` | Congela texto e versão do cadastro do grupo em um novo estatuto numerado |
| `statute_accept` | `statuteId`, `personId`, `evidence` | Registra o aceite e a evidência informados pelo organizador para essa pessoa e estatuto |
| `payment_confirm` | `proposalId`, `proposalVersion`, `bankReference`, `declaredReceivedAt`, `allocations` | Registra uma transferência e suas alocações iniciais, sem confirmar cotas |
| `payment_allocate` | `paymentId`, `poolId`, `amountCents` | Aloca parte do saldo ainda disponível dessa transferência |
| `payment_reverse` | `paymentId`, `reason` | Estorna integralmente a transferência, compensa suas alocações e revoga cotas que perderem financiamento |
| `quota_confirm` | `quotaId`, `quotaVersion`, `statuteId` | Congela os direitos internos de uma cota integralmente financiada |

`bankReference` e `declaredReceivedAt` são campos obrigatórios no formato do comando, mas aceitam `null`. `allocations` é um array de `{ poolId, amountCents }`, pode estar vazio e contém no máximo 100 bolões distintos na confirmação inicial. A soma não pode exceder o recebimento. Cada alocação pertence ao mesmo grupo e pagador; dinheiro de outra pessoa não financia uma cota. Alocações posteriores continuam limitadas pelo saldo da transferência. A evidência de aceite e o motivo do estorno exigem texto não vazio de até 2.000 caracteres.

Uma proposta pode gerar somente um recebimento, inclusive se ele depois for estornado. A referência bancária opcional recebe normalização de espaços externos e não pode se repetir no grupo; outro grupo pode usar a mesma referência. O recebimento é confirmado pelo organizador após sua conferência: não existe integração automática com o banco. Recebimento e alocação não são aprovação automática de uma cota.

A cota exige sua versão corrente, financiamento integral para essa pessoa e bolão, declaração de maioridade e aceite do estatuto publicado mais recente. O bolão precisa estar em rascunho e ter um prazo definido. O servidor confirma somente antes desse prazo; `deadlineAt: null` bloqueia a aprovação com uma explicação. Uma data declarada antiga não altera essa decisão. Recebimentos tardios podem ser registrados e alocados, sem criar direitos depois do prazo. Publicar um novo estatuto preserva versões e cotas históricas; novas confirmações usam o aceite das regras atuais.

O ledger contém um movimento de recebimento por transferência e um de alocação por alocação. O estorno cria o recebimento negativo e todas as compensações negativas no mesmo recibo e horário; não modifica nem apaga os fatos anteriores. Ele exige que todos os bolões alocados ainda estejam em rascunho e que o financiamento restante respeite os orçamentos comprometidos por planos. Cotas que ficarem sem financiamento integral recebem revogação; as ainda financiadas permanecem válidas. Um recebimento estornado não aceita novas alocações. Um pagamento posterior permite uma nova confirmação explícita de cota dentro do prazo, sem reativar silenciosamente o direito revogado.

Propostas já recebidas e rascunhos de cotas ativas ficam protegidos contra edição. Cotas ativas também impedem retirada da maioridade e alteração do preço, prazo, modalidade, concurso ou tipo de participação do bolão. Somente a primeira definição de concurso ausente e de participação `undecided` para `internal`/`official` é permitida enquanto o bolão estiver em rascunho e sem plano aplicado. Essas regras existem no SQL, inclusive em guardas das tabelas. O RPC de sincronização devolve uma rejeição durável quando a edição alteraria direitos confirmados.

`finance_pull` devolve todas as listas `statutes`, `acceptances`, `payments`, `allocations`, `movements`, `quotas` e `revocations`, junto com `groupId` e `groupRevision`. Revisão e fatos são capturados em uma única consulta SQL. O núcleo valida referências, correspondência dos movimentos, compensações e financiamento antes de a função devolver o retrato. O caixa considera recebimentos e estornos; alocar a transferência não aumenta o caixa novamente.

O recibo financeiro possui `apiVersion`, `idempotencyKey`, `groupId`, `status`, `groupRevision`, `message`, `confirmedAt` e `snapshot`. Somente `accepted` possui horário de confirmação do servidor. Conflitos e rejeições preservam a revisão e, quando autorizados, incluem o retrato corrente. A reutilização de chave com conteúdo diferente devolve rejeição sem retrato e conserva o recibo original. Os UUIDs de fatos/recibos internos são gerados no servidor; `receiptId` nos fatos liga a transação e não é a chave enviada pelo cliente.

Após resposta perdida, repita o comando original ou consulte `finance_command_status`. Repetir retorna o recibo e retrato originais, que podem estar atrás de alterações posteriores; obtenha um `finance_pull` atual antes da próxima aprovação. Cada decisão aceita avança a revisão do grupo, acrescenta auditoria encadeada e um marcador canônico do grupo em `group_changes`, sem alterar a versão do rascunho do grupo. Esse marcador mantém o cursor completo e sinaliza que o retrato financeiro precisa ser atualizado.

## Aplicação e trava online

O endpoint `review_decide` encaminha `PlanningCommand` ao RPC `planning_decide`. `plan_apply` recebe `{ type: "plan_apply", plan: PreparedPlan }`; `pool_lock` recebe `{ type: "pool_lock", poolId, poolVersion, appliedPlanId, responsible: { registrarPersonId, ticketHolderPersonId } }`. O organizador precisa revisar online sobre `expectedRevision`. O plano preparado deve ter essa mesma revisão e versões de servidor positivas; atualizar apenas o envelope de uma decisão antiga não a torna válida.

O SQL verifica orçamento igual à soma dos direitos ativos, financiamento líquido do bolão, maioridade, aceites, custo de cada jogo, regras por quantidade de números e proporções das cotas oficiais. Todos os jogos de rascunho atuais aparecem em `sourceBets` e permanecem idênticos, com suas versões, dezenas, autores e sementes. Cotas elegíveis sem confirmação e propostas pendentes bloqueiam a decisão. Pendências ainda exclusivas do aparelho devem ser resolvidas pelo cliente antes da revisão; o servidor não consegue observar dados nunca enviados.

Uma aplicação cria um `AppliedPlan` imutável com versão sequencial por bolão. Jogos gerados ficam em `plan.bets`, sem novos rascunhos fixos. O compromisso protege todo o orçamento, inclusive a sobra identificada, contra estorno que o deixaria sem financiamento; não aumenta o caixa nem cria movimentos de reserva fictícios. Taxas externas declaradas precisam caber no orçamento e ter descrição quando positivas. O limite de tarifa lotérica do catálogo é informativo, sem limitar genericamente todas as taxas externas.

O catálogo completo contém 32 regras de Mega-Sena, Lotofácil e Quina, com preços e limites oficiais por quantidade de números. Cartelas `official` exigem quantidade e valor de cotas em centavos exatos e repartição proporcional às unidades dos direitos, sem arredondamento não verificado. Em `internal`, cada cartela contém um jogo e não emite cotas oficiais. Alterar preços/regras exige nova versão do catálogo no núcleo e no SQL.

A trava exige o último plano aplicado, fontes e direitos ainda atuais, sobra com destino autorizado e relógio do servidor estritamente anterior ao prazo obrigatório. O registrador é uma pessoa adulta do grupo. No acordo `internal`, o titular do bilhete também é adulto e escolhido explicitamente; em `official`, `ticketHolderPersonId` é `null`. O UUID do organizador vem do Auth. A confirmação incrementa a versão do bolão, define `locked` e congela dados, pessoas relacionadas, direitos, jogos, catálogo, responsáveis e referências financeiras.

`PoolManifest` guarda `content`, `canonical`, `sha256`, `lockedAt` e `receiptId`. O conteúdo é JSON canônico compacto: chaves ASCII ordenadas, arrays preservados, números inteiros seguros e bytes UTF-8. SHA-256 é calculado pelo SQL e conferido pelo núcleo; as datas de fatos são UTC com milissegundos. O documento é privado porque inclui o retrato financeiro completo do grupo, inclusive outros bolões. Hash e horário não constituem recibo CAIXA nem prova absoluta contra alterações do administrador da infraestrutura.

Uma nova aplicação e trava podem criar versões antes do prazo e do registro, mantendo `locked`. A revisão preserva os direitos, orçamento, pessoas, responsáveis e retrato financeiro do primeiro manifesto; plano, jogos e taxas podem mudar dentro desse compromisso. Todas as versões anteriores ficam preservadas. O destino da sobra `refund-pro-rata`/`group-credit` registra autorização pendente: não devolve dinheiro nem cria saldo em carteira. Depois do registro externo, os estados `registered`/`settled` impedem revisão; `settled` só será alcançado quando o encerramento do bolão existir.

`plan_pull` captura a revisão e todas as listas `appliedPlans`/`manifests` em uma consulta SQL. O `PlanningReceipt` inclui `receiptId` UUID gerado no servidor somente em `accepted`; conflitos e rejeições usam `null`. Um recibo aceito liga exatamente um plano ou manifesto e seu horário. A chave de idempotência é independente desse UUID. Repetições devolvem o recibo original, sem reaplicar a ação; `plan_command_status` permite recuperar resposta perdida.

Finanças, planejamento e rascunhos têm namespaces próprios de idempotência e compartilham a revisão do grupo. Aplicação/trava acrescentam auditoria e marcador canônico do bolão em `group_changes`; a trava também avança a versão da entidade. Ao consumir todas as páginas de `sync_pull`, `nextCursor` chega à revisão capturada incluindo esses marcadores. Combine rascunhos, finanças e planejamento somente com revisões iguais e sem pendências locais antes da aprovação.

## Divisão do prêmio online

O endpoint `review_decide` encaminha `SettlementCommand` ao RPC `settlement_decide`. O organizador precisa revisar online sobre `expectedRevision`, como nas demais decisões. As ações implementadas são `expense_confirm`, `prize_confirm`, `redemption_record`, `redemption_reverse`, `distribution_record` e `distribution_reverse`. As ações `pool_settle` e `pool_reopen` existem no contrato, mas o servidor as recusa com a mensagem de que encerramento e reabertura ainda não estão disponíveis.

Cada comando traz `poolId` e a `poolVersion` observada, que precisa ser maior que a de qualquer decisão anterior do bolão. Exige originais privados já enviados ao mesmo bolão, salvo na confirmação de um prêmio de valor zero. Os UUIDs dos fatos e do recibo são gerados no servidor, e cada fato recebe `version` sequencial por família e bolão. Correções de despesa e prêmio apontam a confirmação que substituem (`supersedesId`); resgates e pagamentos só se desfazem por um lançamento compensatório (`redemption_reverse`, `distribution_reverse`). `settlement_pull` captura, na mesma consulta, o retrato financeiro, o de registro, o de resultados e as listas `expenses`, `prizes`, `redemptions`, `distributions` e `closures`; o núcleo reconstrói cada fato antes de a função devolver o retrato. `settlement_command_status` recupera o recibo original de uma resposta perdida.

## Registro e resultado online

`review_decide` também encaminha `RegistrationCommand` ao RPC `registration_decide` e `ResultCommand` ao RPC `result_decide`, com as mesmas regras de sessão humana, `expectedRevision` e idempotência. A ação `registration_confirm` traz `poolId`, `poolVersion`, `manifestId`, o checklist completo `items` (cada item com `plannedTicketKey`, `evidenceIds`, o que foi observado ou `null`, e `reason`) e `reason`; o servidor compara com o manifesto travado e guarda um relatório versionado, sem tratar a conferência como recibo da CAIXA. As ações de resultado são `result_manual` (resultado informado com fonte e motivo), `result_resolve` (escolhe qual versão vale quando há resultados divergentes) e `calendar_confirm` (confirma datas do concurso). `registration_pull` e `results_pull` capturam revisão e listas na mesma consulta; os `*_command_status` recuperam o recibo original após resposta perdida.

`results_collect` busca o concurso na fonte oficial da CAIXA (endereços fixos no núcleo, sem credenciais, tempo limite de 12 s, até 1 MiB), valida o formato e grava uma nova versão de resultado; toda tentativa, boa ou ruim, fica registrada à parte e não vira recibo nem prêmio. Se a fonte falha, o último resultado válido é preservado.

## Coleta agendada: `results-collector`

`supabase/functions/results-collector` é um ponto de entrada separado, com `verify_jwt = false` em `config.toml`, porque quem o chama é um agendador e não uma pessoa. Ele aceita somente `POST` em `/functions/v1/results-collector/v1/run`, valida a própria capacidade privada (`Authorization: Bearer <RESULTS_JOB_SECRET>`, comparada sem expor o valor) e repassa para `jobs/results_collect_due`. Exige `SUPABASE_SERVICE_ROLE_KEY` e `RESULTS_JOB_SECRET` de 32 caracteres ou mais; sem eles a função nem inicia. Nenhum agendamento (cron) é instalado por este repositório: ligar a coleta automática é decisão do responsável, fora do navegador. O mesmo caminho na função `api` não serve a agendadores, pois ali o gateway exige JWT.

## Banco e permissões

`20261007000000_foundation.sql` cria `groups`, `group_memberships`, `draft_records`, `group_changes`, `command_receipts`, `audit_events` e o Storage privado. Essa migration foi preservada. `20261007010000_financial.sql` acrescenta `financial_command_receipts`, `statute_versions`, `statute_acceptances`, `received_payments`, `payment_allocations`, `financial_movements`, `confirmed_quotas` e `quota_revocations`, além de reforçar a validação dos rascunhos. A tabela original `confirmed_payments` continua reservada e sem uso no fluxo financeiro atual.

`20261008000000_planning.sql` acrescenta `planning_command_receipts`, `pool_plan_versions`, `pool_manifests` e `lottery_pool_catalog_rules`. As migrations anteriores foram preservadas. Guardas adicionais congelam todos os dados do bolão fechado, jogos/cotas/propostas de origem e destino, pessoas do manifesto e financiamento; a sincronização não reabre o bolão nem move suas fontes.

`20261008010000_registration_results.sql` acrescenta `evidence_originals`, `registration_command_receipts`, `registration_reports`, `result_command_receipts`, `contest_result_versions`, `result_selections`, `contest_calendar_versions`, `result_collection_jobs` e `result_collection_attempts`. `20261010000000_settlement.sql` acrescenta `settlement_command_receipts`, `settlement_expenses`, `settlement_prizes`, `settlement_redemptions`, `settlement_distributions` e `settlement_closures`, todas protegidas por gatilhos contra alteração e exclusão, e os RPCs `settlement_pull`, `settlement_command_status` e `settlement_decide`. As migrations anteriores foram preservadas.

`groups` guarda a revisão compartilhada; os conjuntos de recibos preservam o resultado por conta/chave; `audit_events` encadeia as classes de ação. Fatos e recibos financeiros e de planejamento são imutáveis, com vínculos por grupo, pessoa e recibo. Valores são `bigint` internamente e strings de centavos no contrato. Os RPCs de decisão e consulta são separados dos RPCs de rascunho.

As políticas RLS não concedem gravação direta nessas tabelas. Os RPCs têm `SECURITY DEFINER`, `search_path` vazio e verificam identidade, papel e grupo explicitamente. Seu privilégio de execução público/anônimo foi removido. Membership e papel não podem ser elevados pelo JSON de rascunho. Os papéis participante e registrador não leem todos os dados privados; suas visões individuais ainda precisam ser implementadas.

O identificador `client_id` de um token OAuth delegado é um sinal verificável separado de uma sessão humana. Essa distinção está documentada pelo [Supabase OAuth / RLS](https://supabase.com/docs/guides/auth/oauth-server/token-security). A aplicação recusa esses tokens e contas cuja classificação confiável `app_metadata.actor_type` não seja `human`. O SQL consulta também a classificação atual em `auth.users.raw_app_meta_data`; uma conta depois marcada como agente não consegue usar um token humano antigo para contornar a função HTTP. Dados de `user_metadata` editáveis pelo usuário não concedem essa identidade. O servidor OAuth do agente não está habilitado e suas permissões por grupo ainda não existem. Não entregue uma sessão humana ao agente, pois o uso por outra pessoa/software não é distinguível quando o token é idêntico.

## Evidências privadas

O bucket `evidence` é privado, aceita JPEG, PNG, WebP e PDF de até 10 MiB. A chave do objeto usa `<group UUID>/<file UUID>.<extensão>` (`jpg`, `png`, `webp` ou `pdf`), sem nomes de pessoas nem caminhos fornecidos pela importação. RLS concede leitura e criação ao organizador do grupo. Políticas restritivas e um gatilho em `storage.objects` recusam alteração e exclusão de originais, inclusive antes do selo; um arquivo corrigido deve receber outro identificador.

`evidence_upload` é o caminho de envio do app; um objeto gravado direto no bucket, sem passar por ele, não recebe selo. A função confere tamanho, assinatura do arquivo (`%PDF-`, PNG, JPEG ou WebP) e SHA-256 contra os metadados; pede ao RPC `evidence_upload_context`, com o token humano, o destino do original (organizador do grupo, bolão do mesmo grupo); grava o objeto com a sessão humana, sem sobrescrever; baixa o que foi gravado e confere tudo de novo; e só então chama `evidence_seal` com a chave `service_role`, que insere o selo em `evidence_originals` (somente anexação, até 10.000 por grupo). Repetir o envio com o mesmo identificador e o mesmo arquivo é seguro e conclui um envio interrompido; outro arquivo no mesmo identificador devolve 409 `stored_original_mismatch`. `evidence_status` devolve o selo. `evidence_download` devolve os bytes pela própria função, depois de reconferir tamanho, tipo e SHA-256 com o selo, em vez de URLs assinadas; o navegador nunca recebe um link direto do Storage.

Os `evidenceIds` de uma conferência de registro (`registration_confirm`) ligam cada item aos originais selados do mesmo bolão. Ainda falta o backup dos arquivos fora do Supabase. Selar um original não confirma pagamento nem registro: uma foto só vale depois da conferência humana. Os limites de MIME/tamanho são aplicados pelo serviço Storage, não por uma inserção SQL feita pelo administrador.

## Verificação

Depois de `npm ci`, `npm run test:db` executa o runner PGlite e `npm run test:api` executa Deno pelo binário local do projeto. Ambos também fazem parte de `npm run done`. Os comandos diretos abaixo são uma alternativa quando os runtimes já estão no PATH.

```sh
deno check --config supabase/functions/api/deno.json supabase/functions/api/index.ts
deno test --allow-env --config supabase/functions/api/deno.json supabase/functions/api/api_test.ts
psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' -v ON_ERROR_STOP=1 -f supabase/tests/foundation.sql
psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' -v ON_ERROR_STOP=1 -f supabase/tests/financial.sql
psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' -v ON_ERROR_STOP=1 -f supabase/tests/planning.sql
psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' -v ON_ERROR_STOP=1 -f supabase/tests/registration_results.sql
psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' -v ON_ERROR_STOP=1 -f supabase/tests/settlement.sql
```

Cada arquivo SQL abre uma transação e faz rollback no final. Execute em banco de testes, com todas as migrations aplicadas. As fixtures usam o papel administrativo; os cenários da aplicação trocam para `authenticated`/`anon` e testam as políticas. Estados administrativos temporários exercitam limites de prazo e registro; as travas do teste de planejamento passam pelo RPC real. Os arquivos usam asserções SQL e não o formato TAP de `supabase test db`.

Existe um runner alternativo para um ambiente sem Docker/CLI. Instale PGlite em um diretório temporário e execute:

```sh
npm install --prefix /tmp/little-faith-backend-validation --no-audit --no-fund @electric-sql/pglite@0.5.8 typescript@5.9.3
BACKEND_TEST_MODULE_ROOT=/tmp/little-faith-backend-validation node supabase/tests/run-pglite.mjs
```

Em 11/10/2026 passaram `npm run test:api` com tipos, lint e 15 testes Deno, e o runner PGlite com as cinco migrations e suítes SQL. Ele verifica pagamentos parciais, alocações, prazos, estatutos, estornos, revogações, idempotência, isolamento, proteção de registros, aplicação/trava/revisão, responsáveis e pendências. Também valida 15 respostas financeiras, 8 de planejamento, 21 de registro e resultado e 17 da divisão do prêmio pelo núcleo TypeScript real, compilado temporariamente, que reconstrói 10 fatos da divisão; compara as 32 regras do catálogo e confere SHA-256 dos manifestos com Node crypto, inclusive conteúdo Unicode.

PGlite verifica PostgreSQL/RLS com schemas mínimos de Auth/Storage; os testes dos endpoints financeiros, de planejamento e da divisão do prêmio usam transporte Auth/RPC simulado para conferir encaminhamento e rejeição de respostas inválidas. Esses testes não comprovam integração da plataforma real. Supabase CLI, Docker e `psql` não estavam disponíveis na validação: login Google real, HTTP Edge↔PostgREST, upload HTTP e concorrência entre duas conexões ainda não foram verificados. Nenhum projeto Supabase remoto está conectado e nenhum deploy foi executado.

Antes de uma publicação autorizada, valide a plataforma local/ambiente de teste com duas contas e dois aparelhos, configure retorno do Google/CORS para o endereço real, verifique RLS no Storage, teste resposta perdida e conflitos concorrentes e confirme que os segredos permanecem somente no backend. A integração real de Auth, Edge, PostgREST e Storage precisa ser verificada nesse ambiente. Convites e OAuth de agentes continuam fora desta etapa.
