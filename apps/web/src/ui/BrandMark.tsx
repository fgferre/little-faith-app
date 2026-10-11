/** A marca do app: bola de prata atrás e de ouro na frente. O tamanho vem do font-size do contêiner. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={["ui-brandmark", className].filter(Boolean).join(" ")}
      aria-hidden="true"
    >
      <span className="ui-ball" />
      <span className="ui-ball gold" />
    </span>
  );
}
