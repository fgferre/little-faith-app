import { formatBRL, LOTTERIES, validatePoolManifest } from "@bolao/core";
import type { PoolManifest } from "@bolao/core";

/** The registrar needs the games/checklist, not the group's financial snapshot. */
export function registrationChecklist(input: PoolManifest): string {
  const manifest = validatePoolManifest(input);
  const { plan, pool, responsible, persons } = manifest.content;
  const name = (id: string | null) =>
    persons.find((person) => person.id === id)?.data.name ?? "A conferir";
  const deadline = pool.data.deadlineAt
    ? new Intl.DateTimeFormat("pt-BR", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: "America/Sao_Paulo",
    }).format(new Date(pool.data.deadlineAt))
    : "A definir";
  const lines = [
    "LITTLE FAITH · LISTA PRIVADA DO GRUPO PARA REGISTRO EXTERNO",
    "Documento do grupo. Não é um bilhete ou recibo da CAIXA.",
    "",
    `${pool.data.title} · ${
      LOTTERIES[plan.lotteryId].label
    } · concurso ${plan.contestNumber}`,
    `Manifesto versão ${manifest.version} · confirmado ${manifest.lockedAt} (UTC)`,
    `Hash do manifesto: ${manifest.sha256}`,
    `Registrador: ${name(responsible.registrarPersonId)}`,
    ...(responsible.ticketHolderPersonId
      ? [`Titular no acordo interno: ${name(responsible.ticketHolderPersonId)}`]
      : ["Participação por recibos oficiais de cotas."]),
    `Prazo interno do grupo: ${deadline} (Brasília) · ${
      pool.data.deadlineAt ?? "a definir"
    } (UTC)`,
    "Confira o encerramento oficial do canal antes de registrar.",
    `Custo previsto das apostas: ${formatBRL(plan.betCostCents)}`,
    `Taxa externa prevista no plano: ${formatBRL(plan.feeCents)}${
      plan.feeLabel ? ` (${plan.feeLabel})` : ""
    }`,
    "",
  ];
  plan.tickets.forEach((ticket, index) => {
    lines.push(
      `CARTELA ${index + 1} · ${ticket.numberCount} dezenas · apostas ${
        formatBRL(ticket.betCostCents)
      }`,
    );
    for (const key of ticket.betKeys) {
      const bet = plan.bets.find((item) => item.key === key)!;
      lines.push(
        `  ${
          bet.numbers.map((number) => String(number).padStart(2, "0")).join(" ")
        }`,
      );
    }
    if (ticket.officialQuotaCount !== null) {
      lines.push(
        `${ticket.officialQuotaCount} cotas oficiais previstas · ${
          formatBRL(ticket.officialQuotaValueCents!)
        } por cota`,
      );
      for (const assignment of ticket.assignments) {
        lines.push(
          `  ${
            name(assignment.personId)
          }: ${assignment.officialQuotas} cota(s) oficiais`,
        );
      }
    } else {
      lines.push(
        "Aposta pelo acordo interno do grupo; não representa cota oficial emitida.",
      );
    }
    lines.push(
      "[ ] Modalidade e concurso  [ ] Dezenas  [ ] Valor  [ ] Cotas/titular",
      "[ ] Guardar o original privado e devolver o comprovante para conferência",
      "Observações/divergências: ________________________________________",
      "",
    );
  });
  lines.push(
    "Preserve o comprovante original. Informe jogos ausentes, diferenças e registro parcial para revisão pelo organizador.",
  );
  return `${lines.join("\n")}\n`;
}

export function downloadText(
  text: string,
  name: string,
  type = "text/plain;charset=utf-8",
) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
