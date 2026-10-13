import { useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { encode } from "uqr";
import { buildPixPayload } from "@bolao/core";
import type { PixReceiver } from "@bolao/core";
import { Button } from "./basics";
import { copiar } from "./texto";

/** O Pix copia e cola com o valor que falta; null sem chave cadastrada ou sem nada a pagar. */
export function codigoPix(
  pix: PixReceiver | null | undefined,
  cents: string | null,
) {
  if (!pix || cents === null || BigInt(cents) <= 0n) return null;
  return buildPixPayload({
    key: pix.key,
    name: pix.name,
    city: pix.city,
    amountCents: cents,
  });
}

/**
 * O QR e o código copia e cola de um Pix, com o botão de copiar. O QR é desenhado aqui em SVG (cada
 * módulo escuro um quadrado), com a margem branca de 4 módulos que os leitores dos bancos pedem.
 */
export function PixCode({ payload }: { payload: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const qr = useMemo(() => {
    const { size, data } = encode(payload, { ecc: "M", border: 4 });
    const path = data.flatMap((row, y) =>
      row.flatMap((dark, x) => dark ? [`M${x} ${y}h1v1h-1z`] : [])
    ).join("");
    return { size, path };
  }, [payload]);
  return (
    <div className="pix-code">
      <svg
        className="pix-qr"
        viewBox={`0 0 ${qr.size} ${qr.size}`}
        role="img"
        aria-label="QR code do Pix"
        shapeRendering="crispEdges"
      >
        <rect width={qr.size} height={qr.size} fill="#fff" />
        <path d={qr.path} fill="#000" />
      </svg>
      <p className="pix-text">{payload}</p>
      <Button
        variant="ghost"
        small
        icon={copied
          ? <Check aria-hidden="true" />
          : <Copy aria-hidden="true" />}
        onClick={() => void copiar(payload).then(setCopied)}
      >
        {copied ? "Código copiado" : "Copiar código Pix"}
      </Button>
      {copied === false && (
        <p className="ui-sec" role="status">
          Não deu para copiar. Toque e segure o código para copiar.
        </p>
      )}
    </div>
  );
}
