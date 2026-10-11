import { planningInvalid } from './prepared-plans';

/** Internal number token: JSON monetary values never pass through IEEE-754. */
export class JsonNumber {
  constructor(readonly token: string) {}
}
export type LosslessJson = null | boolean | string | JsonNumber | LosslessJson[] | { [key: string]: LosslessJson };

export function parseLosslessJSON(raw: string): LosslessJson {
  let at = 0;
  const fail = (): never => planningInvalid('rawText', `JSON inválido na posição ${at}.`);
  const whitespace = (): void => { while (/[\t\n\r ]/.test(raw[at] ?? '\u0001')) at++; };
  const string = (): string => {
    const start = at++;
    while (at < raw.length) {
      const char = raw[at++]!;
      if (char === '\\') { at++; continue; }
      if (char === '"') {
        try { return JSON.parse(raw.slice(start, at)) as string; } catch { return fail(); }
      }
      if (char.charCodeAt(0) < 32) return fail();
    }
    return fail();
  };
  const value = (depth: number): LosslessJson => {
    if (depth > 100) return planningInvalid('rawText', 'JSON excede o limite de profundidade.');
    whitespace();
    const char = raw[at];
    if (char === '"') return string();
    if (char === '[') {
      at++; whitespace();
      const result: LosslessJson[] = [];
      if (raw[at] === ']') { at++; return result; }
      while (true) {
        result.push(value(depth + 1)); whitespace();
        if (raw[at] === ']') { at++; return result; }
        if (raw[at++] !== ',') return fail();
      }
    }
    if (char === '{') {
      at++; whitespace();
      const result = Object.create(null) as Record<string, LosslessJson>;
      if (raw[at] === '}') { at++; return result; }
      while (true) {
        whitespace(); if (raw[at] !== '"') return fail();
        const key = string(); whitespace();
        if (Object.hasOwn(result, key)) return planningInvalid('rawText', 'JSON contém chave repetida.');
        if (raw[at++] !== ':') return fail();
        result[key] = value(depth + 1); whitespace();
        if (raw[at] === '}') { at++; return result; }
        if (raw[at++] !== ',') return fail();
      }
    }
    for (const [token, parsed] of [['null', null], ['true', true], ['false', false]] as const) {
      if (raw.startsWith(token, at)) { at += token.length; return parsed; }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(raw.slice(at));
    if (number) { at += number[0].length; return new JsonNumber(number[0]); }
    return fail();
  };
  const result = value(0); whitespace();
  if (at !== raw.length) fail();
  return result;
}

/** Converts a non-negative JSON decimal token to an exact scaled integer. No rounding. */
export function decimalTokenToInteger(token: string, scale: number, field: string): string {
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match || token.length > 300) return planningInvalid(field, 'Decimal não negativo inválido.');
  const integer = match[1]!;
  const fraction = match[2] ?? '';
  const exponentToken = match[3] ?? '0';
  if (exponentToken.replace(/^[+-]/, '').length > 4) return planningInvalid(field, 'Expoente excede o limite.');
  const exponent = Number(exponentToken);
  if (Math.abs(exponent) > 1_000) return planningInvalid(field, 'Expoente excede o limite.');
  let digits = (integer + fraction).replace(/^0+/, '') || '0';
  if (digits === '0') return '0';
  const shift = scale + exponent - fraction.length;
  if (shift >= 0) {
    if (digits.length + shift > 100) return planningInvalid(field, 'Valor excede 100 dígitos.');
    digits += '0'.repeat(shift);
  } else {
    const cut = -shift;
    if (cut >= digits.length || !/^0*$/.test(digits.slice(-cut))) return planningInvalid(field, 'A fonte contém uma fração de centavo ou inteiro.');
    digits = digits.slice(0, -cut);
  }
  if (digits.length > 100) return planningInvalid(field, 'Valor excede 100 dígitos.');
  return digits;
}

export function decimalBRLTokenToCents(token: string): string {
  return decimalTokenToInteger(token, 2, 'valorPremio');
}
