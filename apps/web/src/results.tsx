export function formatInstant(value: string | null, timeZone: string) {
  return value
    ? new Intl.DateTimeFormat("pt-BR", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone,
    }).format(new Date(value))
    : "A definir";
}
