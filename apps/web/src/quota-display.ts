import { quotaCost } from "@bolao/core";

/** A conflicting/offline draft may need correction; it must not crash the page. */
export function draftQuotaCost(
  priceCents: string,
  units: number,
): string | null {
  try {
    return quotaCost(priceCents, units);
  } catch {
    return null;
  }
}
