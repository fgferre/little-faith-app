import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

const MINUTE = 60_000;

function parts(ms: number, timeZone?: string) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      ...(timeZone ? { timeZone } : {}),
    }).formatToParts(ms).map((p) => [p.type, p.value]),
  );
  return {
    day: Date.UTC(+values.year!, +values.month! - 1, +values.day!),
    hour: `${+values.hour!}h${values.minute === "00" ? "" : values.minute}`,
    short: `${values.day}/${values.month}`,
  };
}

/** Dias de calendário entre agora e o alvo, no fuso escolhido (0 = hoje). */
export function calendarDaysUntil(
  target: number,
  now: number,
  timeZone?: string,
) {
  return Math.round((parts(target, timeZone).day - parts(now, timeZone).day) /
    86_400_000);
}

/** "hoje, 20h" · "amanhã, 20h" · "sábado, 20h" (próximos 6 dias) · "24/10, 20h". */
export function formatWhen(target: number, now: number, timeZone?: string) {
  const at = parts(target, timeZone);
  const days = calendarDaysUntil(target, now, timeZone);
  const day = days === 0
    ? "hoje"
    : days === 1
    ? "amanhã"
    : days > 1 && days < 7
    ? new Intl.DateTimeFormat("pt-BR", {
      weekday: "long",
      ...(timeZone ? { timeZone } : {}),
    }).format(target)
    : at.short;
  return `${day}, ${at.hour}`;
}

/** "2 dias 4 h" · "4 h 12 min" · "12 min"; depois do horário, no mesmo dia, "hoje, 20h". */
export function countdownText(target: number, now: number, timeZone?: string) {
  const diff = target - now;
  if (diff <= 0) return formatWhen(target, now, timeZone);
  const total = Math.ceil(diff / MINUTE);
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  if (days) {
    return `${days} ${days === 1 ? "dia" : "dias"}${
      hours ? ` ${hours} h` : ""
    }`;
  }
  if (hours) return `${hours} h${minutes ? ` ${minutes} min` : ""}`;
  return `${minutes} min`;
}

/** Contagem até um instante; atualiza a cada minuto e não anima os números com movimento reduzido. */
export function Countdown(
  { target, timeZone }: { target: string; timeZone?: string },
) {
  const reduced = useReducedMotion();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const tick = () => setNow(Date.now());
    const timeout = setTimeout(() => {
      tick();
      interval = setInterval(tick, MINUTE);
    }, MINUTE - (Date.now() % MINUTE));
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, []);
  const text = countdownText(Date.parse(target), now, timeZone);
  return (
    <time className="ui-money ui-countdown" dateTime={target}>
      {reduced ? text : (
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={text}
            style={{ display: "inline-block" }}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: .2 }}
          >
            {text}
          </motion.span>
        </AnimatePresence>
      )}
    </time>
  );
}
