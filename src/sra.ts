import { randomBytes } from "node:crypto";

// RFC 3526 2048-bit MODP group #14 (safe prime p = 2q + 1)
export const DECK_SAFE_PRIME = 0xFFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AACAA68FFFFFFFFFFFFFFFFn;

// Binary exponentiation: (base ** exp) % mod
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

// Extended Euclidean: returns x such that (a * x) % m == 1
function modInverse(a: bigint, m: bigint): bigint {
  let [oldR, r] = [a, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new Error("No modular inverse exists");
  return oldS < 0n ? oldS + m : oldS;
}

function bigIntFromBytes(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const byte of bytes) result = (result << 8n) + BigInt(byte);
  return result;
}

export function generateKeypair(prime: bigint): { e: bigint; d: bigint } {
  const bits = prime.toString(2).length;
  const bytes = Math.ceil(bits / 8);
  let e: bigint;
  do {
    e = bigIntFromBytes(randomBytes(bytes)) % prime;
  } while (e < 2n || e % 2n === 0n);
  const d = modInverse(e, prime - 1n);
  return { e, d };
}

export function encrypt(value: bigint, key: bigint, prime: bigint): bigint {
  return modPow(value, key, prime);
}

export function decrypt(value: bigint, key: bigint, prime: bigint): bigint {
  return modPow(value, key, prime);
}

export function bigintToBase64(n: bigint): string {
  if (n === 0n) return "AA==";
  const hex = n.toString(16);
  const padded = hex.length % 2 === 0 ? hex : "0" + hex;
  return Buffer.from(padded, "hex").toString("base64");
}

export function base64ToBigint(s: string): bigint {
  const hex = Buffer.from(s, "base64").toString("hex");
  if (hex === "") return 0n;
  return BigInt("0x" + hex);
}
