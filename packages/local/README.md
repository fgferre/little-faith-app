# @bolao/local

Dados locais da fundação do Bolão. Cada banco usa nomes distintos por instalação e conta; `accountId: 'demo'` mantém a demonstração separada da conta autenticada.

```ts
import { createLocalStore, saveDraft, sync } from '@bolao/local';

const db = createLocalStore({ installationId, accountId });
const groupId = crypto.randomUUID();
await saveDraft(db, {
  groupId,
  kind: 'group',
  data: { name: 'Amigos', statute: 'Regra inicial do grupo' },
});
await sync(db, transport);
```

`saveDraft` valida o comando com `@bolao/core` e grava registro, operação e sequência em uma transação IndexedDB. Cada edição recebe uma chave de idempotência. Edições da mesma entidade aguardam o recibo anterior; a versão esperada é atualizada antes da primeira tentativa. Depois do envio, chave e conteúdo permanecem iguais mesmo que a resposta se perca.

`sync` recebe o `SyncTransport` do núcleo e métodos opcionais:

- `listGroupIds(): Promise<string[]>`, para recuperar os grupos autorizados em um aparelho novo. Sem ele, `trackGroup` registra o grupo a buscar.
- `commandStatus(key): Promise<PushReceipt | null>`, para recuperar recibos perdidos. Sem ele, a fila reenvia o comando com a mesma chave e conteúdo.
- `financialPull(groupId): Promise<FinancialSnapshot>`, para buscar fatos financeiros confirmados após o pull dos rascunhos. Não executa aprovações.
- `planningPull(groupId): Promise<PlanningSnapshot>`, para buscar planos aplicados e manifestos após a leitura financeira. Não envia decisões salvas.
- `registrationPull(groupId): Promise<RegistrationSnapshot>`, para buscar manifestos, metadados privados e relatórios após o planejamento. Não envia originais nem confirma checklists.
- `resultsPull(groupId): Promise<ResultSnapshot>`, para buscar resultados, calendários e escolhas humanas depois do registro. Não coleta fontes externas nem decide conflitos.
- `settlementPull(groupId): Promise<SettlementSnapshot>`, para buscar despesas, prêmios, resgates, pagamentos e encerramentos depois dos resultados. Não envia nem decide nada.

Web Locks serializam a sincronização entre abas quando disponíveis. Chamadas simultâneas no mesmo contexto compartilham uma execução. O fallback entre contextos depende da idempotência transacional do servidor. Falhas de rede preservam as operações; o chamador controla o intervalo e a repetição. O envio processa no máximo 100 lotes de 100 entidades por execução.

`records` contém a versão local visível e `serverRecords` conserva a cópia remota. O pull atualiza cursores e registros em uma transação, sem sobrescrever pendências. `resetSyncCursor` permite recarregar um grupo sem apagar rascunhos. Enviar ou receber `payment-proposal` nunca grava dinheiro confirmado.

`getSyncSummary` conta operações `queued`/`in-flight` como pendentes e entidades em revisão, incluindo rejeições, como conflitos. Os recibos ficam em `receipts`. `resolveConflict` exige escolher `keep-local` ou `use-server`, arquiva as versões e operações em `metadata` e usa uma nova chave para reenviar a proposta escolhida. Adotar o servidor exige uma cópia atual disponível.

## Finanças confirmadas

A versão 2 do IndexedDB acrescenta `statutes`, `statuteAcceptances`, `receivedPayments`, `paymentAllocations`, `financialMovements`, `confirmedQuotas`, `quotaRevocations`, `financialSnapshots`, `financialCommands` e `financialReceipts`. A migração conserva rascunhos, fila, cursores e `confirmedPayments` da versão 1. O saldo real usa os fatos novos; registros demonstrativos antigos não são convertidos em recebimentos.

`applyFinancialSnapshot` valida o retrato completo com o núcleo e grava todos os fatos e a revisão em uma transação. Um fato existente é imutável. Snapshots posteriores precisam conservar o histórico completo; snapshots antigos não apagam estornos ou outros fatos posteriores. `getFinancialSnapshot(db, groupId)` retorna os fatos da última revisão completa ou `null`.

`prepareFinancialCommand` persiste uma decisão que pode ser preparada offline. Preserva a revisão aprovada, a chave e o conteúdo. Essa tabela fica fora da fila de rascunhos; sincronização e reconexão não executam comandos financeiros.

`executeFinancialCommand(db, transport, key)` deve ser chamado por uma ação humana explícita com conexão. O envio marca `sending`, e fatos só são gravados junto do recibo validado do servidor. Resposta perdida ou erro ao gravar localmente deixa `unknown`. Não há repetição automática. Recibos de conflito e rejeição ficam disponíveis no comando, sem converter a proposta em dinheiro.

`recoverFinancialCommand` (também exportado como `recoveryFinancialCommand`) consulta somente o resultado da chave. Um resultado ausente ou HTTP 404 conserva `unknown`; reenviar exige nova invocação humana de `executeFinancialCommand` com a mesma chave e conteúdo. Decisões concluídas devolvem o recibo persistido sem enviar novamente. Web Locks e o estado transacional impedem aprovações simultâneas da mesma chave.

## Planejamento e análises locais

A versão 3 acrescenta `planningCandidates`, `planningAnalyses`, `simulationCheckpoints`, `appliedPlans`, `poolManifests`, `planningSnapshots`, `planningCommands` e `planningReceipts`. A migração preserva todos os dados anteriores.

`savePlanningCandidates(db, { groupId, poolId, candidates })` valida e persiste os candidatos com seus IDs determinísticos. Não altera suas entradas nem substitui candidatos antigos. `listPlanningCandidates` e `listPlanningAnalyses` exigem grupo e bolão; cada banco já pertence à instalação e conta selecionadas.

`createPlanningAnalysis(db, { id?, groupId, poolId, candidateId, input })` grava entradas, semente e checkpoint inicial em uma transação. Os jogos precisam corresponder ao candidato salvo. Nenhuma função local calcula amostras: o Worker usa `runSimulationBatch` do núcleo.

`resumePlanningAnalysis(db, id)` retorna o checkpoint salvo e uma nova `progressVersion`. O chamador serializa os lotes do Worker e persiste cada um com `saveAnalysisProgress(db, id, { checkpoint, status, expectedProgressVersion, result? })`. O retorno contém a próxima versão. `pausePlanningAnalysis(db, id, expectedProgressVersion?)` preserva o último lote concluído e invalida callbacks com versões anteriores. Cleanup e falhas de Worker passam o token da execução: quando outra aba já retomou, a pausa antiga não altera a análise. Entradas e semente permanecem imutáveis; contagens e progresso não podem regredir. `saveSimulationCheckpoint` é um alias de `saveAnalysisProgress`.

`refinePlanningAnalysis(db, id, targetSamples)` cria outra análise pausada a partir de uma análise concluída, com a mesma carteira, semente, contadores e posição do gerador. A meta pode aumentar de 200 mil até um milhão; a assinatura do novo checkpoint corresponde à nova meta. A análise original permanece intacta.

`applyPlanningSnapshot` valida os fatos e hashes do núcleo e grava planos, manifestos e revisão de forma atômica. Os fatos aceitos são imutáveis; uma revisão posterior conserva o histórico e uma cópia antiga não apaga fatos novos. `getPlanningSnapshot(db, groupId)` retorna a última cópia completa. A ordem de planos e manifestos é determinada por suas versões por bolão, nunca por UUID ou empate de horários.

`preparePlanningCommand` conserva a decisão exata antes da rede. `executePlanningCommand(db, transport, key)` exige uma ação humana online. O recibo aceito precisa conter o fato correspondente ao UUID do recibo e ao plano ou trava aprovados. Falha de rede ou de persistência deixa `unknown`, sem aplicação ou trava otimista. `recoverPlanningCommand` (alias `recoveryPlanningCommand`) consulta somente o recibo; null/404 não reenvia. Uma decisão encerrada retorna o recibo original. A sincronização nunca chama `planningDecide` nem envia essas decisões.

## Originais, registro e resultados

A versão 4 acrescenta `evidenceUploads`, `confirmedEvidence`, `registrationManifests`, `registrationReports`, `registrationSnapshots`, `registrationCommands`, `registrationReceipts`, `contestResults`, `resultSelections`, `contestCalendars`, `resultSnapshots`, `resultCommands`, `resultReceipts` e `resultCollectionAttempts`. Preserva todas as tabelas, filas e análises anteriores.

`prepareEvidenceUpload(db, { id?, groupId, poolId, original: Blob, originalName? })` calcula o SHA-256 dos bytes originais, valida tamanho, tipo e assinatura do arquivo com o núcleo e persiste o Blob antes de indicar sucesso. Aceita PDF, JPEG, PNG e WebP até 10 MiB; o nome original é um nome de arquivo simples. Não redimensiona, recomprime ou converte a evidência. O hash exige Web Crypto em contexto seguro. Mesmo identificador só pode ser reutilizado com os mesmos metadados e bytes.

`uploadEvidence(db, transport, id)` envia somente esse original. Os estados são `prepared`, `uploading`, `unknown` e `uploaded`. O retorno precisa corresponder ao identificador, grupo, bolão, hash, tamanho, tipo, nome e conta que enviou. Metadados confirmados são imutáveis. Perda de resposta conserva o original e marca `unknown`; `recoverEvidenceUpload` consulta somente `evidenceStatus`. Null/404 conserva a pendência, permitindo outra tentativa técnica com o mesmo ID e hash. Upload não cria um relatório de registro nem confirma dinheiro, jogos ou direitos. Não há upload automático dentro de `sync`.

`getEvidenceOriginal(db, id)` verifica o hash antes de devolver o Blob local. `listEvidenceUploads(db, groupId, poolId)` lista somente o escopo selecionado. Os originais permanecem no aparelho mesmo após upload; esta etapa não implementa descarte ou download de arquivos remotos. Metadados recebidos por pull podem pertencer a outros membros autorizados do grupo, sem misturar bancos de contas diferentes.

`applyRegistrationSnapshot` grava, em uma transação, o histórico completo de manifestos, evidências e relatórios versionados. Uma versão antiga não remove fatos posteriores. Cada relatório preserva checklist, divergências, calendário utilizado e vínculo ao manifesto congelado. `getRegistrationSnapshot(db, groupId)` devolve a última revisão completa. A tabela de metadados registra os IDs das evidências daquela revisão: um upload conhecido antes do próximo pull não antecipa o conteúdo do snapshot antigo.

`prepareRegistrationCommand` salva a proposta exata offline. `executeRegistrationCommand(db, transport, key)` exige uma ação humana online, o manifesto local e metadados confirmados dos arquivos referenciados. O recibo precisa confirmar exatamente o bolão, a versão observada, o manifesto, os itens e o motivo aprovados. Relatórios parciais ou divergentes permanecem visíveis. `recoverRegistrationCommand` (alias `recoveryRegistrationCommand`) faz somente GET; null/404 não reenvia nem apaga a decisão desconhecida.

`applyResultSnapshot` e `getResultSnapshot` preservam resultados brutos, hashes, calendários e seleções humanas em histórico imutável por grupo. Usam os validadores do núcleo para conferir números, valores e a fonte original. Uma fonte inválida ou indisponível não apaga a última versão válida; valores ausentes continuam nulos. As versões incompatíveis ficam disponíveis para revisão.

`collectResults(db, transport, groupId, poolId)` consulta a fonte oficial por meio do backend. É uma operação técnica online, separada de aprovação humana; seu histórico de sucesso ou falha fica em `resultCollectionAttempts`. A resposta validada e o sucesso são persistidos juntos. Uma resposta antiga devolve a revisão mais nova já armazenada no aparelho. Não envia comandos manuais salvos.

`prepareResultCommand`, `executeResultCommand` e `recoverResultCommand` (alias `recoveryResultCommand`) seguem a mesma política de decisão explícita e recuperação GET. Resultado manual, escolha entre versões e confirmação de calendário não são executados na reconexão. O recibo precisa estar vinculado ao fato correspondente e à ação original aprovada, incluindo justificativa e referências da fonte. Relatório e resultado nunca viram dinheiro recebido ou distribuição.

## Divisão do prêmio

A versão 5 acrescenta `expenseConfirmations`, `prizeConfirmations`, `prizeRedemptions`, `settlementDistributions`, `poolSettlements`, `settlementSnapshots`, `settlementCommands` e `settlementReceipts`. A migração preserva todas as tabelas anteriores.

`applySettlementSnapshot` valida o retrato com o núcleo e grava, na mesma transação, as fontes (finanças, registro e resultados do mesmo corte) e as cinco listas de fatos. Um fato existente é imutável; uma cópia antiga ou incompleta não apaga fatos posteriores. `getSettlementSnapshot(db, groupId)` devolve a última cópia completa ou `null`. Um cálculo nunca é gravado como dinheiro.

`prepareSettlementCommand` conserva a decisão exata antes da rede. `executeSettlementCommand(db, transport, key)` exige uma ação humana online com o `SettlementTransport` do núcleo; o recibo aceito precisa corresponder ao fato aprovado. `recoverSettlementCommand` (alias `recoverySettlementCommand`) faz somente GET; null/404 conserva a decisão desconhecida e não reenvia. A sincronização e a reconexão nunca executam essas decisões.

## Exportação de emergência

`exportEmergencySnapshot` devolve JSON **sem criptografia** no formato `bolao-emergency-v5`, com aviso explícito e todas as tabelas locais, inclusive decisões desconhecidas, falhas de consulta e originais pendentes ou já enviados. Blobs são representados por `{ encoding: 'base64', mimeType, byteSize, sha256, data }`; os hashes são verificados antes da exportação. A leitura das tabelas é atômica e a conversão dos bytes ocorre depois, fora da transação IndexedDB. Base64 aumenta o tamanho dos arquivos em aproximadamente um terço. A cópia não baixa originais ausentes do servidor, não autoriza reenviar pendências e não é a exportação completa criptografada especificada em `docs/ESPECIFICACAO.md`; restauração e backup completo ficam para a etapa de recuperação.
