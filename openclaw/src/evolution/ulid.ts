const ALPH = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encode(n: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    s = ALPH[n % 32] + s;
    n = Math.floor(n / 32);
  }
  return s;
}

export function ulid(): string {
  const time = encode(Date.now(), 10);
  let rand = "";
  for (let i = 0; i < 16; i++) {
    rand += ALPH[Math.floor(Math.random() * 32)];
  }
  return time + rand;
}
