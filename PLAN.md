# PLAN — fechar a validação da etapa 5 e terminar a etapa 6 (apuração e rateio) · 10/10/2026

Pedido dele (10/10): seguir as etapas da entrega A sem parar a cada fase; trabalho em paralelo autorizado, com núcleo,
persistência e backend divididos por arquivos e contratos, e a integração no frontend coordenada pela sessão principal.
Especificação: `docs/ESPECIFICACAO.md` › "Apuração e rateio" e "Ordem de implementação". Invariantes: `docs/ARCHITECTURE.md`.

## Etapas

- [ ] E1. `npm run done` volta a passar (item 1 de `docs/PENDENCIAS.md`).
- [ ] E2. Testes próprios de settlement no core: caixa/direitos, centavos, parcial, oficial, compensação, conflito,
  encerramento e reabertura.
- [ ] E3. Exports públicos e sync v5 em `packages/local`; repetir os cenários integrados afetados da etapa 5 (o E2E de
  resultados já passou sozinho em 10/10).
- [ ] E4. Backend: migration, RPCs e família HTTP de settlement, com validação SQL↔core, autorização humana, locks,
  revisão e idempotência.
- [ ] E5. Frontend: tela, transporte, pendências e histórico; a fila de settlement entra na proteção de revisão de
  **todas** as famílias de comandos; o caixa exibido passa a ser a projeção conciliada.
- [ ] E6. E2E completo da etapa 6 e `npm run done`; documentação com os números que passarem de verdade (item 3).

## Arquivos

- Core: `packages/core/src/settlement-types.ts` e `settlement.ts` — contratos e primeira implementação de despesas,
  prêmio confirmado, resgate, distribuição, compensações, encerramento/reabertura e projeção de caixa. Não compila.
- Local: `packages/local/src/settlement.ts` e `settlement-sources.ts` — snapshots e decisões persistentes com fontes
  coerentes; tabelas aditivas Dexie v5 já declaradas em `database.ts`. Faltam exports, sync e validação.
- Web: `apps/web/src/settlement.tsx` e `settlement-decision.tsx` — telas e revisão iniciais, ainda fora de `App.tsx`;
  o transporte em `auth.ts` ainda não oferece settlement.
- Backend: não existe migration nem família HTTP/RPC de settlement.

## Decisões já tomadas

Contrato:

- Snapshot autossuficiente: `financial`, `registration` e `results` no mesmo corte de `groupRevision`, além de
  `expenses`, `prizes`, `redemptions`, `distributions`, `closures`.
- Fatos com UUID/recibo gerados no servidor, `version`, `groupRevision`, `poolVersion` observada e horário confirmado;
  ordens históricas não dependem só de timestamps.
- Ações: `expense_confirm`, `prize_confirm`, `redemption_record/reverse`, `distribution_record/reverse`,
  `pool_settle/reopen`.
- Core: `computeSettlement(snapshot)`, `createSettlementView(snapshot)`, `settlementStatement(snapshot,poolId)`,
  `validateSettlementActionContext(snapshot,action,confirmedAt)` e validadores de comando/snapshot/recibo.
- Local: `apply/getSettlementSnapshot`, `prepare/execute/recoverSettlementCommand`.
- Transporte: `settlementPull`, `settlementDecide`, `settlementCommandStatus`.

Regras:

- Prêmio calculado, confirmado, resgatado e distribuído são fatos distintos.
- Caixa do organizador = contribuições líquidas + resgates internos − despesas confirmadas − pagamentos/devoluções
  líquidos. Reserva de plano não é despesa confirmada.
- Interno: maiores restos com desempate pelo `personId` congelado. Oficial: direitos e valores explícitos dos recibos
  observados; resgate individual fica fora do caixa do organizador.
- Distribuição não pode exceder caixa resgatado nem direitos; compensações referenciam o original, sem apagar fatos.
  Encerramento reconcilia gastos, sobras, devoluções e pendências explicadas, sem marcar dívida como quitada.
- Prazos de resgate e alertas de 30/15/7/1 dias preparados sem enviar mensagens. A regra geral de 90 dias foi conferida
  nas páginas oficiais das modalidades em 08/10/2026 e admite exceção com fonte e motivo; o link genérico
  `receba-seu-premio.aspx` não informa esse prazo no HTML atual.

## Fora do escopo

Etapa 7 (OAuth do agente, MCP/CLI, importação do WhatsApp), etapa 8 (backup criptografado, restauração, piloto),
Supabase real, OAuth Google, cron do coletor, deploy e qualquer mensagem enviada para fora.
