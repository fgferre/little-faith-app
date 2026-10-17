import { useState } from "react";
import { buildPixPayload } from "@bolao/core";
import { Card, Eyebrow, PixCode } from "./ui";

// Quem recebe a doação: o dono do app, pela configuração pública do build (decisão dele em 16/10: Pix por QR Code, sem
// valor fixo). Sem a chave, nada disso aparece; nunca é o Pix da cota e nunca desconta de prêmio nenhum.
const key = import.meta.env.VITE_DONATION_PIX_KEY as string | undefined;
const name = import.meta.env.VITE_DONATION_PIX_NAME as string | undefined;
const city = import.meta.env.VITE_DONATION_PIX_CITY as string | undefined;

export const donationPayload = (() => {
  if (!key || !name || !city) return null;
  try {
    return buildPixPayload({ key, name, city, amountCents: null });
  } catch {
    return null;
  }
})();

/** O cartão de Dados: grátis para a turma; quem quiser ajuda com o valor que escolher, pelo Pix do dono do app. */
export function DoacaoCard() {
  if (!donationPayload) return null;
  return (
    <Card className="finance-card" label="Manter o Little Faith">
      <Eyebrow>Manter o Little Faith</Eyebrow>
      <p className="settings-copy">
        O app é grátis para a turma. Se ele ajudou, uma contribuição de qualquer
        valor mantém essa companhia. Vai para {name}, não para o caixa do grupo.
      </p>
      <PixCode payload={donationPayload} />
    </Card>
  );
}

const DISMISSED = "little-faith:doacao-convite";
function dismissed() {
  try {
    return localStorage.getItem(DISMISSED) === "1";
  } catch {
    return false;
  }
}

/** Depois de encerrar um bolão, uma linha só, que some para sempre neste aparelho ao primeiro "agora não". */
export function DoacaoConvite() {
  const [hidden, setHidden] = useState(dismissed);
  if (!donationPayload || hidden) return null;
  return (
    <p className="ui-sec doacao-convite">
      O app ajudou? Uma contribuição mantém essa companhia.{" "}
      <a className="pool-link" href="#/dados">Apoiar o app</a>
      <button
        type="button"
        className="pool-link"
        onClick={() => {
          try {
            localStorage.setItem(DISMISSED, "1");
          } catch {
            // Sem armazenamento, some só nesta visita.
          }
          setHidden(true);
        }}
      >
        Agora não
      </button>
    </p>
  );
}
