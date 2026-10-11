import type { BolaoDatabase } from "@bolao/local";

/** Read the records and their consumed server head together before human review. */
export async function readReviewSnapshot(
  db: BolaoDatabase,
  groupId: string,
  expectedRevision: number | null,
) {
  return db.transaction(
    "r",
    [
      db.cursors,
      db.serverRecords,
      db.records,
      db.financialCommands,
      db.planningCommands,
      db.registrationCommands,
      db.resultCommands,
    ],
    async () => {
      const [
        cursor,
        records,
        localRecords,
        financialCommands,
        planningCommands,
        registrationCommands,
        resultCommands,
      ] = await Promise.all([
        db.cursors.get(groupId),
        db.serverRecords.where("groupId").equals(groupId).toArray(),
        db.records.where("groupId").equals(groupId).toArray(),
        db.financialCommands.where("groupId").equals(groupId).toArray(),
        db.planningCommands.where("groupId").equals(groupId).toArray(),
        db.registrationCommands.where("groupId").equals(groupId).toArray(),
        db.resultCommands.where("groupId").equals(groupId).toArray(),
      ]);
      if (expectedRevision !== null && cursor?.cursor !== expectedRevision) {
        throw new Error(
          "Os dados do grupo mudaram durante a consulta. Atualize a revisão para conferir todos os dados da mesma versão.",
        );
      }
      return {
        records,
        localRecords,
        financialCommands,
        planningCommands,
        registrationCommands,
        resultCommands,
      };
    },
  );
}
