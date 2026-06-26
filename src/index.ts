import { createHash } from "node:crypto";
import { taggedHash, at, MAX_SIDES } from "./util.ts";

export interface GameState {
  hash: string;
  prevHash: string | null;
  data: string;
  timestamp: number;
  sides?: number;
}

export interface ClosedSecret {
  seed: string;
  author: string;
  seqId: number;
  fingerprint: string;
}

export interface OpenSecret {
  seed: string;
  author: string;
  seqId: number;
  fingerprint: string;
  secret: string;
}

/** A consumed (opened) secret with the roll that consumed it. */
export interface ConsumedSecret {
  seed: string;
  author: string;
  seqId: number;
  fingerprint: string;
  secret: string;
  rollId: string;
}

/** A pool of commitments for one author. Consumed commitments are removed from `commitments` and moved to `consumed`. */
export interface SecretPoolState {
  author: string;
  commitments: ClosedSecret[];
  consumed: ConsumedSecret[];
}

/** One requested secret within a roll declaration, identified by its commitment fingerprint. */
export interface SecretRequest {
  author: string;
  seqId: number;
  fingerprint: string;
}

/** Intent to roll dice. Declarer names the gameHash (state hash) and which secrets feed the roll. */
export interface RollDeclaration {
  gameHash: string;
  sides: number;
  requests: SecretRequest[];
}

/** Publication of a raw secret for a specific commitment. */
export interface SecretReveal {
  seed: string;
  author: string;
  seqId: number;
  secret: string;
  fingerprint: string;
}

/** A resolved roll: the declaration, the reveals (in request order), and the computed roll. */
export interface RollResolution {
  declaration: RollDeclaration;
  reveals: SecretReveal[];
  roll: number;
}

export interface VerifyGameResult {
  valid: boolean;
  errors: string[];
}

function hashState(data: string, prevHash: string | null, timestamp: number, sides?: number): string {
  return taggedHash("urd-state/v1", data, prevHash ?? "\0", timestamp.toString(), ...(sides !== undefined ? [sides.toString()] : []));
}

export function createClosedSecret(author: string, seqId: number, secret: string, seed: string): ClosedSecret {
  if (!Number.isFinite(seqId) || !Number.isInteger(seqId) || seqId < 0) throw new Error("seqId must be a non-negative integer");
  const fingerprint = taggedHash("urd-commit/v1", seed, author, seqId.toString(), secret);
  return { seed, author, seqId, fingerprint };
}

export function createOpenSecret(closed: ClosedSecret, secret: string): OpenSecret {
  const fingerprint = taggedHash("urd-commit/v1", closed.seed, closed.author, closed.seqId.toString(), secret);
  if (fingerprint !== closed.fingerprint) throw new Error("Secret does not match fingerprint");
  return {
    seed: closed.seed,
    author: closed.author,
    seqId: closed.seqId,
    fingerprint: closed.fingerprint,
    secret,
  };
}

export function verifyOpenSecret(open: OpenSecret): void {
  const fingerprint = taggedHash("urd-commit/v1", open.seed, open.author, open.seqId.toString(), open.secret);
  if (fingerprint !== open.fingerprint) throw new Error("Secret does not match fingerprint");
}

export function createGenesisState(data: string, timestamp: number, sides?: number): GameState {
  if (!Number.isFinite(timestamp)) throw new Error("Timestamp must be a finite number");
  return {
    hash: hashState(data, null, timestamp, sides),
    prevHash: null,
    data,
    timestamp,
    sides,
  };
}

export function createNextState(prev: GameState, data: string, timestamp: number, sides?: number): GameState {
  if (!Number.isFinite(timestamp)) throw new Error("Timestamp must be a finite number");
  const hash = hashState(data, prev.hash, timestamp, sides);
  return {
    hash,
    prevHash: prev.hash,
    data,
    timestamp,
    sides,
  };
}

export function verifyChain(states: readonly GameState[]): void {
  if (states.length === 0) throw new Error("Chain is empty");
  for (let i = 0; i < states.length; i++) {
    const state = at(states, i);
    if (!Number.isFinite(state.timestamp)) throw new Error(`State ${state.hash.slice(0, 8)}... has invalid timestamp`);
    const expectedHash = hashState(state.data, state.prevHash, state.timestamp, state.sides);
    if (state.hash !== expectedHash) throw new Error(`State ${state.hash.slice(0, 8)}... hash is invalid`);
    if (i > 0) {
      const prev = at(states, i - 1);
      if (state.prevHash !== prev.hash) throw new Error(`Chain broken at ${state.hash.slice(0, 8)}...: prevHash does not match previous state`);
    } else {
      if (state.prevHash !== null) throw new Error(`Genesis state ${state.hash.slice(0, 8)}... has prevHash, expected null`);
    }
  }
}

/**
 * Derive a deterministic roll in [1, sides] from a game hash and N secrets.
 * Formula: taggedHash("urd-roll/v1", b64(gameHash) + ":" + b64(s1) + ":" + ...)
 * then extract 48 bits with rejection sampling.
 *
 * @param gameHash - Game state hash used as salt (hex string)
 * @param secrets - Revealed secrets in request order (at least one required)
 * @param sides - Number of faces (finite integer >= 2 and <= 2^48)
 */
export function deriveRoll(gameHash: string, secrets: readonly string[], sides: number): number {
  if (!Number.isFinite(sides) || !Number.isInteger(sides) || sides < 2 || sides > MAX_SIDES) throw new Error("Roll sides must be a finite integer >= 2 and ≤ 2^48");
  if (secrets.length === 0) throw new Error("At least one secret is required");
  const maxAcceptable = MAX_SIDES - (MAX_SIDES % sides);
  const ghB64 = Buffer.from(gameHash, "hex").toString("base64");
  const encoded = secrets.map(s => Buffer.from(s).toString("base64"));
  const input = ghB64 + ":" + encoded.join(":");
  let hash = taggedHash("urd-roll/v1", input);
  let offset = 0;
  while (true) {
    if (offset + 12 > hash.length) {
      hash = createHash("sha256").update(Buffer.from(hash, "hex")).digest("hex");
      offset = 0;
    }
    const val = parseInt(hash.slice(offset, offset + 12), 16);
    offset += 12;
    if (val < maxAcceptable) return (val % sides) + 1;
  }
}

/**
 * Create a secret pool from an author's initial commitments.
 * Validates that all commitments share the same author, seed, and have unique seqIds.
 * Commitments are sorted by seqId internally.
 */
export function createPool(author: string, commitments: ClosedSecret[]): SecretPoolState {
  if (commitments.length === 0) throw new Error("Pool must have at least one commitment");
  const sorted = [...commitments].sort((a, b) => a.seqId - b.seqId);
  for (let i = 1; i < sorted.length; i++) {
    if (at(sorted, i).seqId === at(sorted, i - 1).seqId) throw new Error("Duplicate seqId in pool");
  }
  for (const c of sorted) {
    if (c.author !== author) throw new Error("Commitment author does not match pool author");
  }
  for (let i = 1; i < sorted.length; i++) {
    if (at(sorted, i).seed !== at(sorted, 0).seed) throw new Error("Commitment seed mismatch in pool");
  }
  return { author, commitments: sorted, consumed: [] };
}

/**
 * Append a new commitment to a pool. Validates author, seed, and seqId uniqueness.
 * Returns a new SecretPoolState (does not mutate input).
 */
export function addToPool(pool: SecretPoolState, commitment: ClosedSecret): SecretPoolState {
  if (commitment.author !== pool.author) throw new Error("Commitment author does not match pool author");
  if (pool.commitments.length > 0 && commitment.seed !== at(pool.commitments, 0).seed) {
    throw new Error("Commitment seed mismatch in pool");
  }
  for (const c of pool.commitments) {
    if (c.seqId === commitment.seqId) throw new Error("Duplicate seqId in pool");
  }
  const sorted = [...pool.commitments, commitment].sort((a, b) => a.seqId - b.seqId);
  return { author: pool.author, commitments: sorted, consumed: pool.consumed };
}

/**
 * Move revealed secrets from a pool's `commitments` to `consumed`.
 * All reveals must belong to the pool's author and match the next unconsumed commitment by fingerprint.
 * Returns a new SecretPoolState (does not mutate input).
 */
export function consumeSecrets(pool: SecretPoolState, rollId: string, reveals: SecretReveal[]): SecretPoolState {
  const remaining = [...pool.commitments];
  const consumed = [...pool.consumed];
  for (const reveal of reveals) {
    if (reveal.author !== pool.author) throw new Error("Reveal author does not match pool author");
    const commitment = at(remaining, 0);
    if (reveal.fingerprint !== commitment.fingerprint) throw new Error(`Fingerprint ${reveal.fingerprint.slice(0, 8)}... does not match next unconsumed commitment for ${pool.author}`);
    remaining.shift();
    consumed.push({
      seed: reveal.seed,
      author: reveal.author,
      seqId: reveal.seqId,
      fingerprint: reveal.fingerprint,
      secret: reveal.secret,
      rollId,
    });
  }
  return { author: pool.author, commitments: remaining, consumed };
}

/**
 * Verify that a SecretReveal's secret matches the expected fingerprint.
 * Checks: author matches, and hash(seed, author, seqId, secret) == expectedFingerprint.
 */
export function verifySecretReveal(author: string, expectedFingerprint: string, reveal: SecretReveal): void {
  if (reveal.author !== author) throw new Error("Secret author does not match expected author");
  const computed = taggedHash("urd-commit/v1", reveal.seed, author, reveal.seqId.toString(), reveal.secret);
  if (computed !== expectedFingerprint) throw new Error("Secret does not match fingerprint");
}

/**
 * Verify that a RollDeclaration is well-formed and all requested fingerprints exist in pools.
 */
export function verifyRollDeclaration(declaration: RollDeclaration, pools: Record<string, SecretPoolState>): void {
  if (!Number.isFinite(declaration.sides) || !Number.isInteger(declaration.sides) || declaration.sides < 2 || declaration.sides > MAX_SIDES) {
    throw new Error("Roll sides must be a finite integer >= 2 and ≤ 2^48");
  }
  if (declaration.requests.length === 0) throw new Error("Roll declaration must request at least one secret");
  if (!/^[0-9a-f]{64}$/i.test(declaration.gameHash)) throw new Error("gameHash must be a 64-char hex string");
  const authorOffset: Record<string, number> = {};
  for (const req of declaration.requests) {
    const pool = pools[req.author];
    if (!pool) throw new Error(`Author ${req.author} has no pool`);
    const offset = authorOffset[req.author] ?? 0;
    const expected = at(pool.commitments, offset);
    if (expected.fingerprint !== req.fingerprint) {
      throw new Error(`Fingerprint ${req.fingerprint.slice(0, 8)}... does not match next unconsumed commitment for ${req.author} (expected ${expected.fingerprint.slice(0, 8)}...)`);
    }
    if (expected.seqId !== req.seqId) throw new Error(`seqId mismatch for fingerprint ${req.fingerprint.slice(0, 8)}...`);
    authorOffset[req.author] = offset + 1;
  }
}

/**
 * Construct a RollResolution from a declaration and reveals.
 * Computes the roll via deriveRoll. Does NOT verify reveals match the declaration
 * or pools — use verifyRollResolution for that.
 */
export function resolveRoll(declaration: RollDeclaration, reveals: SecretReveal[]): RollResolution {
  const secrets = reveals.map(r => r.secret);
  const roll = deriveRoll(declaration.gameHash, secrets, declaration.sides);
  return { declaration, reveals, roll };
}

/**
 * Verify a complete RollResolution against pools.
 * Checks: declaration is valid, reveals match requests one-to-one,
 * each secret matches its commitment fingerprint, and the roll is correct.
 */
export function verifyRollResolution(resolution: RollResolution, pools: Record<string, SecretPoolState>): void {
  const { declaration, reveals, roll } = resolution;
  verifyRollDeclaration(declaration, pools);
  if (reveals.length !== declaration.requests.length) {
    throw new Error(`Expected ${declaration.requests.length} reveals, got ${reveals.length}`);
  }
  for (let i = 0; i < declaration.requests.length; i++) {
    const req = at(declaration.requests, i);
    const reveal = at(reveals, i);
    if (reveal.fingerprint !== req.fingerprint) throw new Error(`Reveal ${i} fingerprint does not match request`);
    if (reveal.author !== req.author) throw new Error(`Reveal ${i} author does not match request`);
    const computed = taggedHash("urd-commit/v1", reveal.seed, reveal.author, reveal.seqId.toString(), reveal.secret);
    if (computed !== reveal.fingerprint) throw new Error(`Secret does not match fingerprint for reveal ${i}`);
  }
  const computedRoll = deriveRoll(declaration.gameHash, reveals.map(r => r.secret), declaration.sides);
  if (computedRoll !== roll) throw new Error(`Claimed roll does not match computed roll`);
}

/**
 * Verify a complete game: chain integrity, pool validity, and all roll resolutions.
 * Each fingerprint must be used at most once across all resolutions.
 */
export function verifyGame(
  states: readonly GameState[],
  pools: Record<string, readonly ClosedSecret[]>,
  resolutions: readonly RollResolution[],
  expectedSides?: number,
): VerifyGameResult {
  const errors: string[] = [];

  try {
    verifyChain(states);
  } catch (e) {
    return { valid: false, errors: [(e as Error).message] };
  }

  const poolStates: Record<string, SecretPoolState> = {};
  for (const [author, commitments] of Object.entries(pools)) {
    try {
      poolStates[author] = createPool(author, [...commitments]);
    } catch (e) {
      errors.push(`Pool creation failed for ${author}: ${(e as Error).message}`);
    }
  }

  for (let i = 0; i < resolutions.length; i++) {
    const resolution = at(resolutions, i);
    try {
      verifyRollResolution(resolution, poolStates);
    } catch (e) {
      errors.push(`Resolution ${i} failed: ${(e as Error).message}`);
      continue;
    }
    const revealsByAuthor: Record<string, SecretReveal[]> = {};
    for (const reveal of resolution.reveals) {
      (revealsByAuthor[reveal.author] ??= []).push(reveal);
    }
    for (const [author, authorReveals] of Object.entries(revealsByAuthor)) {
      const ps = poolStates[author];
      if (ps) poolStates[author] = consumeSecrets(ps, resolution.declaration.gameHash, authorReveals);
    }
    const state = findStateInChain(states, resolution.declaration.gameHash);
    if (!state) {
      errors.push(`Resolution ${i} references unknown state ${resolution.declaration.gameHash.slice(0, 8)}...`);
    } else if (expectedSides !== undefined && state.sides !== expectedSides) {
      errors.push(`Resolution ${i} has sides ${state.sides}, expected ${expectedSides}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function lookupState(states: readonly GameState[], stateHash: string): GameState {
  const state = findStateInChain(states, stateHash);
  if (!state) throw new Error(`State ${stateHash.slice(0, 8)}... not found in chain`);
  if (state.sides === undefined) throw new Error(`State ${stateHash.slice(0, 8)}... does not define sides`);
  if (!Number.isFinite(state.sides) || !Number.isInteger(state.sides) || state.sides < 2 || state.sides > MAX_SIDES) throw new Error(`State ${stateHash.slice(0, 8)}... sides must be a finite integer >= 2 and ≤ 2^48, got ${state.sides}`);
  return state;
}

export function lookupSides(states: readonly GameState[], stateHash: string): number {
  return lookupState(states, stateHash).sides!;
}

export function findStateInChain(chain: readonly GameState[], hash: string): GameState | null {
  for (const state of chain) {
    if (state.hash === hash) return state;
  }
  return null;
}
