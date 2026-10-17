import { betSignature, quotaCost } from "@bolao/core";
import type { EntityDataMap, EntityKind } from "@bolao/core";
import { listRecords, saveDraft } from "@bolao/local";
import type { BolaoDatabase, SaveDraftInput } from "@bolao/local";

/** Cross-record draft checks run in the same local transaction as the outbox write. */
export function saveLocalDraft<K extends EntityKind>(
  db: BolaoDatabase,
  input: SaveDraftInput<K>,
) {
  const tables = [
    db.records,
    db.operations,
    db.metadata,
    db.poolManifests,
    ...(input.kind === "pool"
      ? [db.appliedPlans, db.contestResults, db.contestCalendars]
      : []),
  ];
  // Bet generation already has its own draft transaction and does not alter rights.
  const financialTables = input.kind === "bet"
    ? []
    : [db.confirmedQuotas, db.quotaRevocations, db.receivedPayments];
  return db.transaction(
    "rw",
    [...tables, ...financialTables],
    async () => {
      const manifests = await db.poolManifests.where("groupId").equals(
        input.groupId,
      ).toArray();
      const frozenPools = new Set(manifests.map((manifest) => manifest.poolId));
      const previous = input.id ? await db.records.get(input.id) : undefined;
      const currentPoolId = input.kind === "pool"
        ? input.id
        : (input.data as Partial<EntityDataMap["bet"]>).poolId;
      const previousPoolId =
        previous && ["bet", "quota", "payment-proposal"].includes(previous.kind)
          ? (previous.data as EntityDataMap["bet"]).poolId
          : null;
      if (
        (input.kind === "pool" || input.kind === "bet" ||
          input.kind === "quota" || input.kind === "payment-proposal") &&
        (currentPoolId && frozenPools.has(currentPoolId) ||
          previousPoolId && frozenPools.has(previousPoolId))
      ) {
        throw new Error(
          "Este bolão foi travado. Seu manifesto precisa ser preservado; revise o plano antes do registro para mudar os jogos.",
        );
      }
      if (input.kind !== "bet") {
        const [rights, revocations] = await Promise.all([
          db.confirmedQuotas.where("groupId").equals(input.groupId).toArray(),
          db.quotaRevocations.where("groupId").equals(input.groupId).toArray(),
        ]);
        const active = rights.filter((right) =>
          !revocations.some((revocation) => revocation.quotaId === right.id)
        );
        if (
          input.kind === "quota" &&
          active.some((right) =>
            right.sourceQuotaId === input.id ||
            right.poolId === (input.data as EntityDataMap["quota"]).poolId &&
              right.personId === (input.data as EntityDataMap["quota"]).personId
          )
        ) {
          throw new Error(
            "Esta participação já foi confirmada. Corrija os fatos financeiros antes de alterar a cota.",
          );
        }
        if (
          input.kind === "payment-proposal" && input.id &&
          (await db.receivedPayments.where("groupId").equals(input.groupId)
            .toArray()).some((payment) => payment.sourceProposalId === input.id)
        ) {
          throw new Error(
            "Este recebimento já foi confirmado. Use um estorno para corrigir o registro.",
          );
        }
        if (
          input.kind === "person" && active.some((right) =>
            right.personId === input.id
          ) && !(input.data as EntityDataMap["person"]).adultDeclared
        ) {
          throw new Error(
            "Uma pessoa com participação confirmada precisa manter sua declaração de maioridade.",
          );
        }
        if (
          input.kind === "pool" &&
          active.some((right) => right.poolId === input.id)
        ) {
          const previous = await db.records.get(input.id ?? "");
          const old = previous?.data as EntityDataMap["pool"] | undefined;
          const next = input.data as EntityDataMap["pool"];
          const canDefine = old?.status === "draft" &&
            !await db.appliedPlans.where("poolId").equals(input.id ?? "")
              .count();
          if (
            old &&
            (old.quotaPriceCents !== next.quotaPriceCents ||
              (old.contestCount ?? 1) !== (next.contestCount ?? 1) ||
              old.deadlineAt !== next.deadlineAt ||
              old.lotteryId !== next.lotteryId ||
              old.contestNumber !== next.contestNumber &&
                !(canDefine && old.contestNumber === null &&
                  next.contestNumber !== null) ||
              old.participationMode !== next.participationMode &&
                !(canDefine && old.participationMode === "undecided" &&
                  next.participationMode !== "undecided"))
          ) {
            throw new Error(
              "Preço, prazo, modalidade e quantidade de concursos precisam preservar as participações já confirmadas.",
            );
          }
        }
        if (input.kind === "pool" && input.id) {
          const previous = await db.records.get(input.id);
          const old = previous?.data as EntityDataMap["pool"] | undefined;
          const next = input.data as EntityDataMap["pool"];
          if (old && old.status !== "draft") {
            throw new Error("Um bolão fechado não aceita edição de rascunho.");
          }
          if (
            old &&
            (old.lotteryId !== next.lotteryId ||
              old.contestNumber !== next.contestNumber) &&
            (await db.contestResults.where("poolId").equals(input.id).count() ||
              await db.contestCalendars.where("poolId").equals(input.id)
                .count())
          ) {
            throw new Error(
              "Este bolão já possui uma fonte de resultado ou calendário. Preserve o concurso e crie outro bolão para um concurso diferente.",
            );
          }
          const quotas = (await listRecords(db, "quota", input.groupId)).filter(
            (quota) => quota.data.poolId === input.id,
          );
          for (const quota of quotas) {
            quotaCost(next.quotaPriceCents, quota.data.units);
          }
          if (
            old && old.lotteryId !== next.lotteryId &&
            (await listRecords(db, "bet", input.groupId)).some((bet) =>
              bet.data.poolId === input.id
            )
          ) {
            throw new Error(
              "Preserve a modalidade dos jogos preparados. Crie outro bolão para outra modalidade.",
            );
          }
        }
      }
      if (
        input.kind === "quota" || input.kind === "bet" ||
        input.kind === "payment-proposal"
      ) {
        const data = input.data as
          | EntityDataMap["quota"]
          | EntityDataMap["bet"]
          | EntityDataMap["payment-proposal"];
        const pool = await db.records.get(data.poolId);
        if (
          !pool || pool.kind !== "pool" || pool.groupId !== input.groupId
        ) throw new Error("O bolão não pertence ao grupo selecionado.");
        const poolData = pool.data as EntityDataMap["pool"];
        if (poolData.status !== "draft") {
          throw new Error(
            "Este bolão não aceita novos rascunhos.",
          );
        }
        if (input.kind !== "bet") {
          const personId = (data as EntityDataMap["quota"]).personId;
          const person = await db.records.get(personId);
          if (
            !person || person.kind !== "person" ||
            person.groupId !== input.groupId
          ) throw new Error("A pessoa não pertence ao grupo selecionado.");
          if (input.kind === "quota") {
            const quota = data as EntityDataMap["quota"];
            if (
              !(person.data as EntityDataMap["person"]).adultDeclared
            ) {
              throw new Error(
                "Registre a declaração de maioridade antes de preparar uma cota.",
              );
            }
            quotaCost(poolData.quotaPriceCents, quota.units);
            const quotas = (await listRecords(db, "quota", input.groupId))
              .filter((q) =>
                q.data.poolId === data.poolId && q.id !== input.id
              );
            if (
              quotas.some((q) => q.data.personId === personId)
            ) {
              throw new Error(
                "A participação desta pessoa mudou. Reabra o formulário para revisar.",
              );
            }
            if (quotas.length >= 200) {
              throw new Error(
                "Este bolão já tem 200 participantes.",
              );
            }
          }
        } else {
          const bet = data as EntityDataMap["bet"];
          if (bet.lotteryId !== poolData.lotteryId) {
            throw new Error(
              "O jogo usa outra modalidade.",
            );
          }
          const signature = betSignature(bet.lotteryId, bet.numbers);
          const bets = (await listRecords(db, "bet", input.groupId)).filter((
            b,
          ) => b.data.poolId === data.poolId && b.id !== input.id);
          if (
            bets.some((b) =>
              betSignature(b.data.lotteryId, b.data.numbers) === signature
            )
          ) {
            throw new Error(
              "Este jogo já está no bolão. A duplicata não foi adicionada.",
            );
          }
          if (bets.length >= 1_000) {
            throw new Error(
              "Este bolão já tem 1.000 jogos.",
            );
          }
        }
      }
      return saveDraft(db, input);
    },
  );
}
