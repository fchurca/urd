import { describe, it } from "node:test";
import { equal, ok, throws, doesNotThrow } from "node:assert/strict";
import {
  DECK_SAFE_PRIME,
  generateKeypair,
  encrypt,
  decrypt,
  bigintToBase64,
  base64ToBigint,
} from "./sra.ts";

const p = DECK_SAFE_PRIME;

describe("SRA primitive", () => {
  it("generates a valid keypair", () => {
    const kp = generateKeypair(p);
    ok(kp.e > 0n);
    ok(kp.d > 0n);
    ok(kp.e < p);
    ok(kp.d < p);
  });

  it("encrypt then decrypt round-trips", () => {
    const kp = generateKeypair(p);
    const plaintext = 42n;
    const ciphertext = encrypt(plaintext, kp.e, p);
    const recovered = decrypt(ciphertext, kp.d, p);
    equal(recovered, plaintext);
  });

  it("keypair satisfies e * d ≡ 1 mod (p - 1)", () => {
    const kp = generateKeypair(p);
    const product = (kp.e * kp.d) % (p - 1n);
    equal(product, 1n);
  });

  it("encrypt and decrypt are the same operation (commutative)", () => {
    const kp = generateKeypair(p);
    equal(encrypt(42n, kp.e, p), decrypt(42n, kp.e, p));
  });

  it("three-party commutativity", () => {
    const a = generateKeypair(p);
    const b = generateKeypair(p);
    const c = generateKeypair(p);
    const x = 7n;

    // EncA(EncB(EncC(x))) then DecC(DecB(DecA(result)))
    const eABC = encrypt(encrypt(encrypt(x, a.e, p), b.e, p), c.e, p);
    const dCBA = decrypt(decrypt(decrypt(eABC, a.d, p), b.d, p), c.d, p);
    equal(dCBA, x);

    // Commutativity: different order gives same encrypted result
    const eACB = encrypt(encrypt(encrypt(x, a.e, p), c.e, p), b.e, p);
    const eBAC = encrypt(encrypt(encrypt(x, b.e, p), a.e, p), c.e, p);
    equal(eACB, eBAC);
    equal(eACB, eABC);
  });

  it("bigintToBase64 and base64ToBigint round-trip", () => {
    const values = [0n, 1n, 42n, p - 1n, 12345678901234567890n];
    for (const v of values) {
      const encoded = bigintToBase64(v);
      const decoded = base64ToBigint(encoded);
      equal(decoded, v);
    }
  });
});
