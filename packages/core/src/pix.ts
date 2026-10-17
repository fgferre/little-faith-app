import type { PixKeyType, PixReceiver } from './types';
import { centsValue } from './money';

/**
 * Pix "copia e cola" (static BR Code with the amount), as in the Banco Central's Manual de Padrões para Iniciação do Pix
 * (EMV QRCPS-MPM). The app only assembles the code: it never talks to a bank, and payment stays confirmed by hand.
 */
export const PIX_KEY_TYPES: readonly PixKeyType[] = ['cpf', 'cnpj', 'email', 'phone', 'random'];

/** Field 26 holds at most 99 characters: GUI subfield (18) plus "01", the length (2) and the key. */
const KEY_MAX = 77;
const NAME_MAX = 25;
const CITY_MAX = 15;
const KEY_FORMS: Record<PixKeyType, RegExp> = {
  cpf: /^\d{11}$/,
  cnpj: /^[0-9A-Z]{12}\d{2}$/,
  email: /^[a-z0-9._+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/,
  phone: /^\+55[1-9]{2}9\d{8}$/,
  random: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
};
const KEY_ERRORS: Record<PixKeyType, string> = {
  cpf: 'CPF inválido: confira os 11 números.',
  cnpj: 'CNPJ inválido: confira os 14 caracteres.',
  email: 'E-mail inválido para chave Pix.',
  phone: 'Celular inválido: use o DDD e os 9 números, como (11) 91234-5678.',
  random: 'Chave aleatória inválida: cole os 36 caracteres como aparecem no banco.',
};

/** Name and city of the BR Code: accents removed, printable ASCII, single spaces. */
export function pixText(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ')
    .replace(/[^ -~]/g, '').replace(/ {2,}/g, ' ').trim();
}

/** The key in its normal form for the type, or null when it cannot be a key of that type. */
export function normalizePixKey(keyType: PixKeyType, raw: string): string | null {
  let key = raw.trim();
  if (keyType === 'cpf') key = key.replace(/[.\-\s]/g, '');
  else if (keyType === 'cnpj') key = key.toUpperCase().replace(/[.\-/\s]/g, '');
  else if (keyType === 'email' || keyType === 'random') key = key.toLowerCase();
  else {
    const digits = key.replace(/\D/g, '');
    if (digits.length === 11) key = `+55${digits}`;
    else if (digits.length === 13 && digits.startsWith('55')) key = `+${digits}`;
    else return null;
  }
  if (key.length > KEY_MAX || !KEY_FORMS[keyType].test(key)) return null;
  if (keyType === 'cpf' && !cpfDigitsValid(key)) return null;
  if (keyType === 'cnpj' && !cnpjDigitsValid(key)) return null;
  return key;
}

/** Checks and normalizes what the organizer typed; throws an Error with a message for the person. */
export function validatePixReceiver(input: { keyType: string; key: string; name: string; city: string }): PixReceiver {
  if (!(PIX_KEY_TYPES as readonly string[]).includes(input.keyType)) throw new Error('Escolha o tipo da chave Pix.');
  const keyType = input.keyType as PixKeyType;
  const key = normalizePixKey(keyType, input.key);
  if (key === null) throw new Error(KEY_ERRORS[keyType]);
  const name = pixText(input.name);
  if (!name || name.length > NAME_MAX) throw new Error(`Informe o nome de quem recebe, com até ${NAME_MAX} letras.`);
  const city = pixText(input.city);
  if (!city || city.length > CITY_MAX) throw new Error(`Informe a cidade de quem recebe, com até ${CITY_MAX} letras.`);
  return { key, keyType, name, city };
}

/** Static BR Code with the amount; txid is up to 25 letters and digits, "***" when there is none. */
export function buildPixPayload(
  { key, name, city, amountCents, txid = '' }: { key: string; name: string; city: string; amountCents: string | null; txid?: string },
): string {
  if (key.length > KEY_MAX || !/^[!-~]+$/.test(key)) throw new Error('Chave Pix inválida.');
  const merchant = pixText(name).slice(0, NAME_MAX).trim();
  const town = pixText(city).slice(0, CITY_MAX).trim();
  if (!merchant || !town) throw new Error('Informe o nome e a cidade de quem recebe o Pix.');
  // Without an amount (null) the payer types the value: field 54 is left out, as the BR Code allows (the donation code).
  const cents = amountCents === null ? null : centsValue(amountCents);
  if (cents !== null && cents <= 0n) throw new Error('O valor do Pix precisa ser maior que zero.');
  const amount = cents === null ? '' : `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
  if (amount.length > 13) throw new Error('Valor alto demais para um código Pix.');
  const reference = txid || '***';
  if (reference !== '***' && !/^[A-Za-z0-9]{1,25}$/.test(reference)) {
    throw new Error('Identificador do Pix inválido: use até 25 letras e números.');
  }
  const body = field('00', '01')
    + field('26', field('00', 'br.gov.bcb.pix') + field('01', key))
    + field('52', '0000') + field('53', '986') + (amount ? field('54', amount) : '') + field('58', 'BR')
    + field('59', merchant) + field('60', town) + field('62', field('05', reference)) + '6304';
  return body + pixCrc16(body);
}

/** CRC16-CCITT-FALSE (polynomial 0x1021, start 0xFFFF) in 4 uppercase hex digits, over the ASCII text. */
export function pixCrc16(text: string): string {
  let crc = 0xffff;
  for (let index = 0; index < text.length; index++) {
    crc ^= text.charCodeAt(index) << 8;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function field(id: string, value: string): string {
  if (value.length > 99) throw new Error('Campo grande demais para um código Pix.');
  return `${id}${String(value.length).padStart(2, '0')}${value}`;
}

function cpfDigitsValid(cpf: string): boolean {
  if (cpf === cpf[0]!.repeat(11)) return false;
  for (const size of [9, 10]) {
    let sum = 0;
    for (let index = 0; index < size; index++) sum += Number(cpf[index]) * (size + 1 - index);
    if ((sum * 10) % 11 % 10 !== Number(cpf[size])) return false;
  }
  return true;
}

/** Also the alphanumeric CNPJ (from July 2026): each character counts as its ASCII code minus 48. */
function cnpjDigitsValid(cnpj: string): boolean {
  if (cnpj === cnpj[0]!.repeat(14)) return false;
  for (const size of [12, 13]) {
    let sum = 0;
    for (let index = 0; index < size; index++) sum += (cnpj.charCodeAt(index) - 48) * (((size - 1 - index) % 8) + 2);
    const rest = sum % 11;
    if ((rest < 2 ? 0 : 11 - rest) !== cnpj.charCodeAt(size) - 48) return false;
  }
  return true;
}
