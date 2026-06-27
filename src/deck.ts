import { randomInt } from "node:crypto";
import { taggedHash, at } from "./util.ts";
import { encrypt, decrypt, bigintToBase64, base64ToBigint, DECK_SAFE_PRIME } from "./sra.ts";

export interface KeyCommitment {
  author: string;
  deckId: string;
  commitment: string;
}

export interface DeckDeclaration {
  deckId: string;
  prime: string;
  participants: string[];
  cardCount: number;
}

export interface DeckShuffle {
  deckId: string;
  author: string;
  inputDeckHash: string;
  outputDeck: string[];
  keyCommitment: string;
}

export interface DrawCommitment {
  deckId: string;
  player: string;
  ciphertext: string;
  nonce: string;
  commitment: string;
}

export interface PartialReveal {
  deckId: string;
  drawCiphertext: string;
  author: string;
  e: string;
  inputCiphertext: string;
  outputCiphertext: string;
  nonce: string;
}

export interface CardReveal {
  deckId: string;
  drawCommitment: DrawCommitment;
  card: number;
  partials: PartialReveal[];
}

export function createInitialDeck(cardCount: number = 52): bigint[] {
  const deck: bigint[] = [];
  // Offset by 2 to avoid fixed points of modular exponentiation (0^e ≡ 0, 1^e ≡ 1)
  for (let i = 2n; i < BigInt(cardCount) + 2n; i++) deck.push(i);
  return deck;
}

function fisherYatesShuffle(arr: readonly bigint[]): bigint[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const pick = randomInt(i + 1);
    [result[i], result[pick]] = [result[pick]!, result[i]!];
  }
  return result;
}

export function shuffleDeck(deck: readonly bigint[]): bigint[] {
  return fisherYatesShuffle(deck);
}

export function encryptDeck(deck: readonly bigint[], key: bigint, prime: bigint): bigint[] {
  return deck.map(c => encrypt(c, key, prime));
}

export function hashDeck(deck: readonly bigint[]): string {
  return taggedHash("urd-deck/v1", ...deck.map(c => bigintToBase64(c)));
}

export function verifyDeckDeclaration(decl: DeckDeclaration): void {
  if (decl.cardCount < 1) throw new Error("Deck must have at least 1 card");
  if (decl.participants.length === 0) throw new Error("Deck must have at least one participant");
  const prime = base64ToBigint(decl.prime);
  if (prime !== DECK_SAFE_PRIME) throw new Error("Unsupported prime");
}

export function verifyDeckShuffle(event: DeckShuffle, inputDeckHash: string, deckKeyCommitments: Map<string, KeyCommitment>): void {
  if (event.inputDeckHash !== inputDeckHash) {
    throw new Error(`Deck shuffle input hash does not match: expected ${inputDeckHash.slice(0, 8)}..., got ${event.inputDeckHash.slice(0, 8)}...`);
  }
  if (event.outputDeck.length === 0) throw new Error("Deck shuffle output is empty");
  const seen = new Set<string>();
  for (const ct of event.outputDeck) {
    if (seen.has(ct)) throw new Error(`Duplicate ciphertext in shuffled deck: ${ct.slice(0, 8)}...`);
    seen.add(ct);
  }
  const kc = deckKeyCommitments.get(event.author);
  if (!kc) throw new Error(`No key commitment found for shuffle author ${event.author}`);
  if (kc.commitment !== event.keyCommitment) throw new Error(`Key commitment mismatch for ${event.author}`);
  if (kc.deckId !== event.deckId) throw new Error(`Key commitment deckId mismatch for ${event.author}`);
}

export function drawCard(deck: readonly bigint[]): { card: bigint; remaining: bigint[] } {
  if (deck.length === 0) throw new Error("Cannot draw from an empty deck");
  const card = at(deck, 0);
  const remaining = deck.slice(1);
  return { card, remaining };
}

export function verifyDraw(deck: readonly string[], drawCiphertext: string): void {
  if (at(deck, 0) !== drawCiphertext) throw new Error(`Drawn ciphertext does not match front of deck`);
}

export function createDrawCommitment(deckId: string, player: string, ciphertext: string, nonce: string): DrawCommitment {
  const commitment = taggedHash("urd-draw/v1", ciphertext, player, nonce);
  return { deckId, player, ciphertext, nonce, commitment };
}

export function verifyDrawCommitment(commit: DrawCommitment, ciphertext: string, player: string, nonce: string): void {
  const expected = taggedHash("urd-draw/v1", ciphertext, player, nonce);
  if (expected !== commit.commitment) throw new Error("Draw commitment does not match");
}

export function createKeyCommitment(author: string, deckId: string, e: bigint, nonce: string): KeyCommitment {
  const commitment = taggedHash("urd-key/v1", bigintToBase64(e), nonce);
  return { author, deckId, commitment };
}

export function verifyKeyCommitment(commit: KeyCommitment, e: bigint, nonce: string): void {
  const expected = taggedHash("urd-key/v1", bigintToBase64(e), nonce);
  if (expected !== commit.commitment) throw new Error("Key commitment does not match");
}

export function revealCard(ciphertext: bigint, keysD: readonly bigint[], prime: bigint): bigint {
  let result = ciphertext;
  for (const d of keysD) result = decrypt(result, d, prime);
  return result;
}

export function verifyCardReveal(
  reveal: CardReveal,
  deckKeyCommitments: Map<string, KeyCommitment>,
  prime: bigint,
): void {
  const { drawCommitment, card, partials } = reveal;
  verifyDrawCommitment(drawCommitment, drawCommitment.ciphertext, drawCommitment.player, drawCommitment.nonce);
  if (partials.length === 0) throw new Error("Card reveal must include at least one partial reveal");
  let expectedInput = drawCommitment.ciphertext;
  for (const pr of partials) {
    if (pr.deckId !== reveal.deckId) throw new Error(`Partial reveal deckId mismatch for ${pr.author}`);
    if (pr.drawCiphertext !== drawCommitment.ciphertext) throw new Error("Partial reveal ciphertext does not match draw commitment");
    if (pr.inputCiphertext !== expectedInput) throw new Error(`Partial reveal input chain broken for ${pr.author}`);
    const kc = deckKeyCommitments.get(pr.author);
    if (!kc) throw new Error(`No key commitment found for ${pr.author}`);
    const e = base64ToBigint(pr.e);
    verifyKeyCommitment(kc, e, pr.nonce);
    const input = base64ToBigint(pr.inputCiphertext);
    const output = base64ToBigint(pr.outputCiphertext);
    if (encrypt(output, e, prime) !== input) throw new Error(`Invalid partial decryption for ${pr.author}`);
    expectedInput = pr.outputCiphertext;
  }
  const result = base64ToBigint(expectedInput);
  const expectedCard = BigInt(card);
  if (result !== expectedCard) throw new Error(`Revealed card ${result} does not match claimed card ${card}`);
}
