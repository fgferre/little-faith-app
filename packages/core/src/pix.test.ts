import { describe, expect, it } from 'vitest';
import { buildPixPayload, normalizePixKey, pixCrc16, validatePixReceiver } from './pix';
import { validateEntityData } from './validation';

/** A second CRC16-CCITT-FALSE, table-driven, written apart from the bitwise one in pix.ts. */
const TABLE = Array.from({ length: 256 }, (_, byte) => {
  let value = byte << 8;
  for (let bit = 0; bit < 8; bit++) value = (value & 0x8000 ? (value << 1) ^ 0x1021 : value << 1) & 0xffff;
  return value;
});
const tableCrc = (text: string) => {
  let crc = 0xffff;
  for (const char of text) crc = ((crc << 8) & 0xffff) ^ TABLE[((crc >> 8) ^ char.charCodeAt(0)) & 0xff]!;
  return crc.toString(16).toUpperCase().padStart(4, '0');
};

/** Splits a BR Code into its top-level fields (id -> value). */
const fields = (payload: string) => {
  const found = new Map<string, string>();
  for (let at = 0; at < payload.length;) {
    const size = Number(payload.slice(at + 2, at + 4));
    found.set(payload.slice(at, at + 2), payload.slice(at + 4, at + 4 + size));
    at += 4 + size;
  }
  return found;
};

describe('Pix BR Code', () => {
  it('computes the CRC of the Banco Central example and the CRC16-CCITT-FALSE check value', () => {
    // Static example of the Manual de Padrões para Iniciação do Pix (no amount), with its published CRC 1D3D.
    const manual = '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***6304';
    expect(pixCrc16(manual)).toBe('1D3D');
    expect(tableCrc(manual)).toBe('1D3D');
    expect(pixCrc16('123456789')).toBe('29B1');
  });

  it('builds the static code with the amount, field by field', () => {
    const payload = buildPixPayload({ key: 'chave@exemplo.com', name: 'Fulano de Tal', city: 'BRASILIA', amountCents: '1050' });
    expect(payload).toBe(
      '00020126390014br.gov.bcb.pix0117chave@exemplo.com520400005303986540510.505802BR5913Fulano de Tal6008BRASILIA62070503***6304'
        + tableCrc('00020126390014br.gov.bcb.pix0117chave@exemplo.com520400005303986540510.505802BR5913Fulano de Tal6008BRASILIA62070503***6304'),
    );
    const top = fields(payload);
    expect([...top.keys()]).toEqual(['00', '26', '52', '53', '54', '58', '59', '60', '62', '63']);
    expect(top.get('54')).toBe('10.50');
    expect(top.get('63')).toBe(tableCrc(payload.slice(0, -4)));
  });

  it('removes accents, cuts name and city to 25 and 15 characters and keeps a given txid', () => {
    const payload = buildPixPayload({
      key: '+5511912345678', name: 'João Pé de Feijão Comércio Ltda', city: 'São José dos Campos', amountCents: '7', txid: 'BOLAO42',
    });
    const top = fields(payload);
    expect(top.get('59')).toBe('Joao Pe de Feijao Comerci');
    expect(top.get('60')).toBe('Sao Jose dos Ca');
    expect(top.get('54')).toBe('0.07');
    expect(top.get('62')).toBe('0507BOLAO42');
    expect(top.get('63')).toBe(tableCrc(payload.slice(0, -4)));
    expect(() => buildPixPayload({ key: 'chave@exemplo.com', name: 'A', city: 'B', amountCents: '0' })).toThrow('maior que zero');
    expect(() => buildPixPayload({ key: 'chave@exemplo.com', name: 'A', city: 'B', amountCents: '100', txid: 'com-hífen' })).toThrow('Identificador');
  });

  it('normalizes the five key types and refuses wrong check digits', () => {
    expect(normalizePixKey('cpf', '123.456.789-09')).toBe('12345678909');
    expect(normalizePixKey('cpf', '123.456.789-00')).toBeNull();
    expect(normalizePixKey('cpf', '111.111.111-11')).toBeNull();
    expect(normalizePixKey('cnpj', '11.222.333/0001-81')).toBe('11222333000181');
    expect(normalizePixKey('cnpj', '12.abc.345/01de-35')).toBe('12ABC34501DE35');
    expect(normalizePixKey('cnpj', '11.222.333/0001-82')).toBeNull();
    expect(normalizePixKey('email', ' Chave@Exemplo.com ')).toBe('chave@exemplo.com');
    expect(normalizePixKey('email', 'chave@exemplo')).toBeNull();
    expect(normalizePixKey('phone', '(11) 91234-5678')).toBe('+5511912345678');
    expect(normalizePixKey('phone', '+55 11 91234-5678')).toBe('+5511912345678');
    expect(normalizePixKey('phone', '(11) 3123-4567')).toBeNull();
    expect(normalizePixKey('random', '123E4567-E12B-12D1-A456-426655440000')).toBe('123e4567-e12b-12d1-a456-426655440000');
    expect(normalizePixKey('random', '123e4567')).toBeNull();
    expect(validatePixReceiver({ keyType: 'email', key: 'Chave@Exemplo.com', name: ' Ana  Cláudia ', city: 'Niterói' }))
      .toEqual({ keyType: 'email', key: 'chave@exemplo.com', name: 'Ana Claudia', city: 'Niteroi' });
    expect(() => validatePixReceiver({ keyType: 'email', key: 'chave@exemplo.com', name: '', city: 'Niteroi' })).toThrow('nome');
  });

  it('keeps the receiver optional in the group and accepts only its normal form', () => {
    const pix = { key: 'chave@exemplo.com', keyType: 'email', name: 'Ana Claudia', city: 'Niteroi' };
    expect(validateEntityData('group', { name: 'Turma', statute: '' })).toEqual({ name: 'Turma', statute: '' });
    expect(validateEntityData('group', { name: 'Turma', statute: '', pix: null }).pix).toBeNull();
    expect(validateEntityData('group', { name: 'Turma', statute: '', pix }).pix).toEqual(pix);
    expect(() => validateEntityData('group', { name: 'Turma', statute: '', pix: { ...pix, key: 'Chave@Exemplo.com' } })).toThrow('normalizado');
    expect(() => validateEntityData('group', { name: 'Turma', statute: '', pix: { ...pix, bank: '001' } })).toThrow('bank');
    expect(() => validateEntityData('group', { name: 'Turma', statute: '', pix: { ...pix, keyType: 'cpf' } })).toThrow('CPF');
  });
});
