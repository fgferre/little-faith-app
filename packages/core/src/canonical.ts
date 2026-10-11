/** Compact canonical JSON for our domain: ASCII object keys, safe integer numbers, ordered arrays. */
export function canonicalJSON(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(current: unknown): string {
    if (current === null) return 'null';
    if (typeof current === 'string' || typeof current === 'boolean') return JSON.stringify(current);
    if (typeof current === 'number') {
      if (!Number.isSafeInteger(current) || Object.is(current,-0)) throw new Error('JSON canônico exige inteiros seguros, sem -0.');
      return current.toString();
    }
    if (typeof current !== 'object' || !current) throw new Error('Valor não representável no manifesto.');
    if (ancestors.has(current)) throw new Error('JSON circular não é permitido.');
    ancestors.add(current);
    let encoded: string;
    if (Array.isArray(current)) {
      if (Object.keys(current).length!==current.length) throw new Error('Lista esparsa ou com propriedades extras.');
      encoded=`[${current.map(encode).join(',')}]`;
    } else {
      const prototype=Object.getPrototypeOf(current);
      if (prototype!==Object.prototype && prototype!==null) throw new Error('Manifesto exige objetos simples.');
      const object=current as Record<string,unknown>;
      const keys=Object.keys(object).sort();
      if (keys.some((key)=>!/^[\x20-\x7e]*$/.test(key))) throw new Error('Chave de manifesto deve ser ASCII imprimível.');
      encoded=`{${keys.map((key)=>`${JSON.stringify(key)}:${encode(object[key])}`).join(',')}}`;
    }
    ancestors.delete(current);
    return encoded;
  }
  return encode(value);
}
const constants=new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
const rr=(value:number,bits:number):number=>(value>>>bits)|(value<<(32-bits));
/** SHA-256 over UTF-8, synchronous for deterministic IDs and defensive snapshot validation. */
export function sha256Hex(text: string): string {
  const bytes=new TextEncoder().encode(text);
  const padded=new Uint8Array(Math.ceil((bytes.length+9)/64)*64);
  padded.set(bytes); padded[bytes.length]=0x80;
  const data=new DataView(padded.buffer);
  const bits=BigInt(bytes.length)*8n;
  data.setUint32(padded.length-8,Number(bits>>32n)); data.setUint32(padded.length-4,Number(bits&0xffffffffn));
  const hash=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const words=new Uint32Array(64);
  for (let offset=0;offset<padded.length;offset+=64) {
    for (let i=0;i<16;i++) words[i]=data.getUint32(offset+i*4);
    for (let i=16;i<64;i++) {
      const a=words[i-15]!,b=words[i-2]!;
      words[i]=(words[i-16]!+(rr(a,7)^rr(a,18)^(a>>>3))+words[i-7]!+(rr(b,17)^rr(b,19)^(b>>>10)))>>>0;
    }
    let [a,b,c,d,e,f,g,h]=[...hash] as [number,number,number,number,number,number,number,number];
    for (let i=0;i<64;i++) {
      const t1=(h+(rr(e,6)^rr(e,11)^rr(e,25))+((e&f)^(~e&g))+constants[i]!+words[i]!)>>>0;
      const t2=((rr(a,2)^rr(a,13)^rr(a,22))+((a&b)^(a&c)^(b&c)))>>>0;
      h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    const state=[a,b,c,d,e,f,g,h];
    for (let i=0;i<8;i++) hash[i]=(hash[i]!+state[i]!)>>>0;
  }
  return [...hash].map((word)=>word.toString(16).padStart(8,'0')).join('');
}
export function deterministicId(value: unknown): string {
  const hash=sha256Hex(canonicalJSON(value));
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-8${hash.slice(13,16)}-${((Number.parseInt(hash[16]!,16)&3)|8).toString(16)}${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
