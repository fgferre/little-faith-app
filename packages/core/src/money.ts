/** Values crossing an API boundary are canonical decimal strings of integer cents. */
export function centsValue(cents: string): bigint {
  if (typeof cents !== 'string' || !/^-?(?:0|[1-9]\d*)$/.test(cents) || cents === '-0') {
    throw new Error('Informe centavos inteiros em formato canônico.');
  }
  return BigInt(cents);
}

/** Accepts Brazilian notation and the decimal dot used by HTML number inputs. */
export function parseBRL(input: string): string {
  if (typeof input !== 'string') throw new Error('Informe um valor em reais.');
  let value = input.trim();
  let negative = false;
  if (value.startsWith('-')) {
    negative = true;
    value = value.slice(1).trimStart();
  }
  if (value.startsWith('R$')) value = value.slice(2).trimStart();
  if (!negative && value.startsWith('-')) {
    negative = true;
    value = value.slice(1).trimStart();
  }
  // Dots followed by three digits are grouping separators; no rounding is allowed.
  const brazilian = /^(\d+|\d{1,3}(?:\.\d{3})+)(?:,(\d{1,2}))?$/.exec(value);
  const decimal = /^(\d+)\.(\d{1,2})$/.exec(value);
  const match = brazilian ?? decimal;
  if (!match) throw new Error('Use um valor com até duas casas decimais, como 25,50.');
  const whole = match[1]!.replaceAll('.', '');
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const cents = BigInt(whole) * 100n + BigInt(fraction || '0');
  return (negative ? -cents : cents).toString();
}

export function formatBRL(cents: string): string {
  const amount = centsValue(cents);
  const absolute = amount < 0n ? -amount : amount;
  const whole = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  return `${amount < 0n ? '-' : ''}R$ ${whole},${fraction}`;
}

export function sumCents(values: readonly string[]): string {
  return values.reduce((total, value) => total + centsValue(value), 0n).toString();
}

/** Internal quotas only. One quota is 100 units; this does not create official Caixa quotas. */
export function quotaUnits(input: string): number {
  if (typeof input !== 'string') throw new Error('Informe a quantidade de cotas.');
  const match = /^(\d+)(?:[,.](\d{1,2}))?$/.exec(input.trim());
  if (!match) throw new Error('Use cotas com até duas casas decimais, como 1,25.');
  const units = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Quantidade de cotas muito grande.');
  return Number(units);
}

export function formatQuotaUnits(units: number): string {
  requireUnits(units);
  const value = BigInt(units);
  const fraction = (value % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return `${value / 100n}${fraction ? `,${fraction}` : ''}`;
}

function requireUnits(units: number): void {
  if (!Number.isSafeInteger(units) || units < 0) throw new Error('Cotas devem usar unidades inteiras não negativas.');
}

/** A fractional quota cannot silently round a payment to a different number of cents. */
export function quotaCost(quotaPriceCents: string, units: number): string {
  requireUnits(units);
  const price = centsValue(quotaPriceCents);
  if (price < 0n) throw new Error('O preço da cota não pode ser negativo.');
  const product = price * BigInt(units);
  if (product % 100n !== 0n) throw new Error('Essa fração de cota resulta em uma fração de centavo; ajuste o preço ou a cota.');
  return (product / 100n).toString();
}

export interface DistributionShare { id: string; units: number }
export interface DistributedAmount extends DistributionShare { amountCents: string }

/** Largest remainders, with ordinal ID order for ties, independent of device locale. */
export function distributeCents(totalCents: string, shares: readonly DistributionShare[]): DistributedAmount[] {
  const total = centsValue(totalCents);
  if (total < 0n) throw new Error('O valor a distribuir não pode ser negativo.');
  if (shares.length === 0) {
    if (total === 0n) return [];
    throw new Error('Informe os participantes do rateio.');
  }
  const ids = new Set<string>();
  let totalUnits = 0n;
  for (const share of shares) {
    if (typeof share.id !== 'string' || !share.id || ids.has(share.id)) throw new Error('Cada participante do rateio precisa de um identificador único.');
    requireUnits(share.units);
    ids.add(share.id);
    totalUnits += BigInt(share.units);
  }
  if (totalUnits === 0n) throw new Error('O rateio precisa de cotas maiores que zero.');
  const amounts = shares.map((share) => {
    const numerator = total * BigInt(share.units);
    return { ...share, cents: numerator / totalUnits, remainder: numerator % totalUnits };
  });
  const floorTotal = amounts.reduce((sum, share) => sum + share.cents, 0n);
  const residual = Number(total - floorTotal); // Residual is strictly less than the number of shares.
  amounts.sort((left, right) => left.remainder === right.remainder
    ? compareIds(left.id, right.id)
    : left.remainder > right.remainder ? -1 : 1);
  for (let index = 0; index < residual; index++) amounts[index]!.cents += 1n;
  return amounts.sort((left, right) => compareIds(left.id, right.id))
    .map(({ id, units, cents }) => ({ id, units, amountCents: cents.toString() }));
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
