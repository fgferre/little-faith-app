import { History } from "lucide-react";
import { formatBRL } from "@bolao/core";
import type { LocalRecord } from "@bolao/core";
import { EmptyState, SectionTitle } from "../components";
import { FinancialHistory } from "../finance";
import { formatDate } from "../app-shared";
import type { Snapshot } from "../app-shared";

export function HistoricoScreen(
  {
    snapshot,
    group,
    isDemo,
  }: {
    snapshot: Snapshot;
    group: LocalRecord<"group"> | undefined;
    isDemo: boolean;
  },
) {
  return (
    <>
      <div className="page-heading compact">
        <div>
          <span className="eyebrow">
            CADA HISTÓRIA BEM GUARDADA
          </span>
          <h1>Histórico da turma</h1>
          <p>
            Recebimentos confirmados, sempre separados das estimativas.
          </p>
        </div>
      </div>
      {!isDemo
        ? (
          <FinancialHistory
            snapshot={snapshot.finances}
            persons={snapshot.persons}
            pools={snapshot.pools}
          />
        )
        : snapshot.confirmed.length
        ? (
          <section className="panel">
            <SectionTitle
              title={isDemo
                ? "Recebimentos demonstrativos"
                : "Recebimentos confirmados"}
              subtitle={group?.data.name ?? "Seu grupo"}
            />
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Pessoa</th>
                    <th>Bolão</th>
                    <th>Recebido</th>
                    <th>Data</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.confirmed.map((p) => (
                    <tr key={p.id}>
                      <td>
                        {snapshot.persons.find((person) =>
                          person.id === p.personId
                        )?.data.name}
                      </td>
                      <td>
                        {snapshot.pools.find((pool) => pool.id === p.poolId)
                          ?.data.title}
                      </td>
                      <td>{formatBRL(p.amountCents)}</td>
                      <td>{formatDate(p.confirmedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted">
              Resgates, distribuições e relatórios reconciliados entram na etapa
              de distribuição.
            </p>
          </section>
        )
        : (
          <EmptyState
            icon={<History size={30} />}
            title="As boas histórias vão ficar aqui"
            description="Seus rascunhos estão salvos. O histórico financeiro começa com registros confirmados no servidor."
          />
        )}
    </>
  );
}
