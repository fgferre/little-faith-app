import { MessageCircle } from "lucide-react";

/**
 * Abre o WhatsApp com a mensagem já escrita (link oficial wa.me); a pessoa escolhe a conversa lá.
 * Tem a cara do botão do app e vai junto do "Copiar", que segue como plano B.
 */
export function EnviarWhatsApp(
  { text, variant = "primary", small = false }: {
    text: string;
    variant?: "primary" | "ghost";
    small?: boolean;
  },
) {
  return (
    <a
      className={["ui-btn", variant === "ghost" && "ghost", small && "sm"]
        .filter(Boolean).join(" ")}
      href={`https://wa.me/?text=${encodeURIComponent(text)}`}
      target="_blank"
      rel="noopener noreferrer"
    >
      <MessageCircle aria-hidden="true" />
      Enviar no WhatsApp
    </a>
  );
}
