import { Plus, Users } from "lucide-react";
import { formatBRL, formatQuotaUnits, quotaCost, sumCents } from "@bolao/core";
import type { FinancialView, LocalRecord } from "@bolao/core";
import { Avatar, EmptyState, SectionTitle } from "../components";
import { draftQuotaCost } from "../quota-display";
import type { FormKind, Snapshot } from "../app-shared";

export function BolaoPessoas(
  {
    snapshot,
    pool,
    poolQuotas,
    payments,
    financialView,
    isDemo,
    openForm,
  }: {
    snapshot: Snapshot;
    pool: LocalRecord<"pool">;
    poolQuotas: LocalRecord<"quota">[];
    payments: Snapshot["confirmed"];
    financialView: FinancialView | null;
    isDemo: boolean;
    openForm: (kind: FormKind) => void;
  },
) {
  return (
    <section className="panel">
      <SectionTitle
        title="Quem faz parte"
        subtitle="Autoria dos números e direito ao prêmio são coisas distintas."
        action={
          <button
            className="button primary"
            onClick={() => openForm("person")}
          >
            <Plus size={17} />Adicionar pessoa
          </button>
        }
      />
      <div className="panel-actions">
        <button
          className="button secondary"
          onClick={() => openForm("quota")}
        >
          Preparar cota
        </button>
        <button
          className="button secondary"
          onClick={() => openForm("payment")}
        >
          Preparar pagamento
        </button>
      </div>
      {!snapshot.persons.length
        ? (
          <EmptyState
            icon={<Users size={28} />}
            title="Vamos reunir a turma"
            description="Basta um nome e a declaração de maioridade. Nenhuma conta é necessária."
          />
        )
        : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Pessoa</th>
                  <th>Cotas preparadas</th>
                  <th>Valor devido</th>
                  <th>Recebimento confirmado</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.persons.map((person, i) => {
                  const units = poolQuotas.filter((
                    q,
                  ) => q.data.personId === person.id)
                    .reduce(
                      (n, q) => n + q.data.units,
                      0,
                    );
                  const paid = !isDemo
                    ? financialView
                      ?.personPoolFunding(
                        pool.id,
                        person.id,
                      ) ?? "0"
                    : sumCents(
                      payments.filter((p) => p.personId === person.id).map((
                        p,
                      ) => p.amountCents),
                    );
                  return (
                    <tr key={person.id}>
                      <td>
                        <span className="person-cell">
                          <Avatar
                            name={person.data.name}
                            index={i}
                            small
                          />
                          <span>
                            <strong>
                              {person.data.name}
                            </strong>
                            <small>
                              {person.data
                                  .adultDeclared
                                ? "Maioridade declarada"
                                : "Maioridade pendente"}
                            </small>
                          </span>
                        </span>
                      </td>
                      <td>
                        {formatQuotaUnits(units)}
                      </td>
                      <td>
                        {draftQuotaCost(
                            pool.data.quotaPriceCents,
                            units,
                          ) === null
                          ? "Revisar cota"
                          : formatBRL(
                            quotaCost(
                              pool.data
                                .quotaPriceCents,
                              units,
                            ),
                          )}
                      </td>
                      <td>{formatBRL(paid)}</td>
                      <td>
                        <span
                          className={`simple-pill ${
                            BigInt(paid) > 0n ? "green" : "amber"
                          }`}
                        >
                          {BigInt(paid) > 0n
                            ? isDemo ? "Exemplo confirmado" : "Recebido"
                            : "Em preparação"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}
