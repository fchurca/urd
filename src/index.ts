import { createHash } from "node:crypto";

/** A state in the game chain. Hash is computed from data, prevHash, timestamp, and optional sides. */
export interface GameState {
  hash: string;
  prevHash: string | null;
  data: string;
  timestamp: number;
  sides?: number;
}

/** A commitment: the public part of a secret before reveal. The fingerprint binds the secret to the seed, author, and seqId.
 * `ChallengerCommitment` extends this type — the same fields serve both the owner of a commitment and a peer who challenges it. */
export interface ClosedSecret {
  seed: string;
  author: string;
  seqId: number;
  fingerprint: string;
}

/** An opened (revealed) secret: includes the raw secret alongside the commitment fields. */
export interface OpenSecret {
  seed: string;
  author: string;
  seqId: number;
  fingerprint: string;
  secret: string;
}

function taggedHash(tag: string, ...parts: string[]): string {
  const tagHash = createHash("sha256").update(tag).digest();
  const h = createHash("sha256").update(tagHash).update(tagHash);
  for (const part of parts) h.update(part);
  return h.digest("hex");
}

const MAX_SIDES = 2 ** 48;

function at<T>(arr: readonly T[], index: number): T {
  const val = arr[index];
  if (val === undefined) throw new Error(`Index ${index} out of bounds`);
  return val;
}

function hashState(data: string, prevHash: string | null, timestamp: number, sides?: number): string {
  return taggedHash("urd-state/v1", data, prevHash ?? "\0", timestamp.toString(), ...(sides !== undefined ? [sides.toString()] : []));
}

/**
 * Create a commitment (closed secret) from an author, sequence id, secret, and game seed.
 * The fingerprint is `hash(seed + author + seqId + secret)`.
 *
 * @param author - Player identifier (e.g., Nostr pubkey)
 * @param seqId - Monotonic sequence number within the author's pool
 * @param secret - The raw secret to commit (must be kept hidden until reveal)
 * @param seed - Per-game identifier that prevents cross-game replay
 * @returns A ClosedSecret containing only public fields (seed, author, seqId, fingerprint)
 */
export function createClosedSecret(author: string, seqId: number, secret: string, seed: string): ClosedSecret {
  if (!Number.isFinite(seqId) || !Number.isInteger(seqId) || seqId < 0) throw new Error("seqId must be a non-negative integer");
  const fingerprint = taggedHash("urd-commit/v1", seed, author, seqId.toString(), secret);
  return { seed, author, seqId, fingerprint };
}

/**
 * Open a closed secret by revealing the raw secret string, verifying it matches the fingerprint.
 *
 * @param closed - The commitment (ClosedSecret) to open
 * @param secret - The raw secret that matches the commitment's fingerprint
 * @returns An OpenSecret that includes the revealed secret
 * @throws "Secret does not match fingerprint" if the secret does not hash to the committed fingerprint
 */
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

/**
 * Verify that an OpenSecret's secret matches its fingerprint.
 * Read-only — see README for rejection reasons.
 */
export function verifyOpenSecret(open: OpenSecret): void {
  const fingerprint = taggedHash("urd-commit/v1", open.seed, open.author, open.seqId.toString(), open.secret);
  if (fingerprint !== open.fingerprint) throw new Error("Secret does not match fingerprint");
}

/**
 * Create the first state in a game state chain.
 *
 * @param data - Opaque game data (e.g., move description)
 * @param timestamp - Unix timestamp (seconds) for hash binding
 * @param sides - Optional number of sides for dice rolls derived from this state
 */
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

/**
 * Create a new state chained after a previous state.
 * The new state's hash includes the previous state's hash (prevHash).
 *
 * @param prev - The predecessor GameState
 * @param data - Opaque game data for this state
 * @param timestamp - Unix timestamp (seconds) for hash binding
 * @param sides - Optional number of sides for dice rolls derived from this state
 */
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

/**
 * Verify a game state chain: hashes must be valid, links must connect, genesis must have null prevHash.
 * See README for full error table.
 */
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
 * Derive a deterministic roll in [1, sides] from a state hash and secret.
 * Uses rejection sampling on a 48-bit hash digest to eliminate modulo bias.
 *
 * When a challengerSecret is provided, the roll depends on both the roller's
 * and the challenger's secrets — neither party can predict the outcome alone.
 *
 * @param rollHash - Hash value that binds the roll (typically `prevHash ?? hash` of the referenced state)
 * @param secret - The revealed secret of the secret owner
 * @param sides - Number of faces (must be a finite integer >= 2 and <= 2^48)
 * @param challengerSecret - Optional second secret from the challenger for multi-source derivation
 * @returns A value in [1, sides]
 */
export function deriveRoll(rollHash: string, secret: string, sides: number, challengerSecret?: string): number {
  if (!Number.isFinite(sides) || !Number.isInteger(sides) || sides < 2 || sides > MAX_SIDES) throw new Error("Roll sides must be a finite integer >= 2 and ≤ 2^48");
  const maxAcceptable = MAX_SIDES - (MAX_SIDES % sides);
  let hash = challengerSecret !== undefined
    ? taggedHash("urd-roll/v1", rollHash, secret, challengerSecret)
    : taggedHash("urd-roll/v1", rollHash, secret);
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

/** A pool of commitments for one author, consumed in FIFO order. */
export interface SecretPoolState {
  author: string;
  commitments: ClosedSecret[];
  consumedCount: number;
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
  return { author, commitments: sorted, consumedCount: 0 };
}

/** The next expected challenge: the oldest unconsumed commitment from a pool. */
export interface NextChallenge {
  seed: string;
  seqId: number;
  fingerprint: string;
}

/**
 * Get the next expected challenge (oldest unconsumed commitment) from a pool.
 * Returns null if all commitments have been consumed.
 */
export function nextChallenge(pool: SecretPoolState): NextChallenge | null {
  if (pool.consumedCount >= pool.commitments.length) return null;
  const next = at(pool.commitments, pool.consumedCount);
  return { seed: next.seed, seqId: next.seqId, fingerprint: next.fingerprint };
}

/** A challenger's pre-committed secret that contributes to a multi-source roll. */
export interface ChallengerCommitment extends ClosedSecret {}

/** An on-wire challenge event from a challenger targeting a specific author's next commitment. */
export interface ChallengeEvent {
  challenger: string;
  targetAuthor: string;
  seed: string;
  seqId: number;
  fingerprint: string;
  challengerCommitment?: ChallengerCommitment;
}

/**
 * Verify that a ChallengeEvent matches the next expected challenge for a pool.
 * Checks author, seed, seqId, and fingerprint against the next unconsumed commitment.
 * See README for full error table.
 */
export function verifyChallenge(pool: SecretPoolState, challenge: ChallengeEvent): void {
  const next = nextChallenge(pool);
  if (!next) throw new Error("No pending challenge");
  if (challenge.targetAuthor !== pool.author) throw new Error("Challenge target author does not match pool author");
  if (challenge.seed !== next.seed) throw new Error("Challenge seed does not match next commitment");
  if (challenge.seqId !== next.seqId) throw new Error("Challenge seqId does not match next commitment");
  if (challenge.fingerprint !== next.fingerprint) throw new Error("Challenge fingerprint does not match next commitment");
}

/** A reveal event published by the secret owner. Binds the secret, the state hash, and the claimed roll. */
export interface Reveal {
  seed: string;
  seqId: number;
  secret: string;
  newFingerprint: string;
  stateHash: string;
  claimedRoll: number;
  /** Optional challenger secret for multi-source derivation. When present, the roll depends on both secrets. */
  challengerSecret?: string;
}

/** The result of a processReveal call: the derived roll and the updated pool state. */
export interface RevealOutput {
  roll: number;
  updatedPool: SecretPoolState;
}

/**
 * Process a reveal against a pool: consume the next commitment, derive the roll, append a new commitment.
 * Returns a RevealOutput with the roll and updated pool. The input pool is not mutated.
 * See README for full error table.
 *
 * @param pool - The current pool state
 * @param reveal - The reveal event
 * @param states - Game state chain for side/prev-hash lookup
 * @param challenger - Optional challenger commitment for multi-source verification. Required when `reveal.challengerSecret` is set.
 */
export function processReveal(
  pool: SecretPoolState,
  reveal: Reveal,
  states: readonly GameState[],
  challenger?: ChallengerCommitment,
): RevealOutput {
  if (!/^[0-9a-f]{64}$/i.test(reveal.newFingerprint)) throw new Error("newFingerprint must be a 64-char hex string");
  const challenge = nextChallenge(pool);
  if (!challenge) throw new Error("No pending challenge");
  if (reveal.seqId !== challenge.seqId) throw new Error("seqId does not match next challenge");
  if (reveal.seed !== challenge.seed) throw new Error("Seed does not match challenge");

  const fingerprint = taggedHash("urd-commit/v1", reveal.seed, pool.author, reveal.seqId.toString(), reveal.secret);
  if (fingerprint !== challenge.fingerprint) throw new Error("Secret does not match fingerprint");

  const state = lookupState(states, reveal.stateHash);
  const sides = state.sides!;
  const rollHash = state.prevHash ?? state.hash;

  if (reveal.challengerSecret !== undefined) {
    if (!challenger) throw new Error("Challenger secret provided but no challenger commitment");
    const expectedFp = taggedHash("urd-commit/v1", challenger.seed, challenger.author, challenger.seqId.toString(), reveal.challengerSecret);
    if (expectedFp !== challenger.fingerprint) throw new Error("Challenger secret does not match challenger commitment");
  }

  const roll = deriveRoll(rollHash, reveal.secret, sides, reveal.challengerSecret);
  if (roll !== reveal.claimedRoll) throw new Error("Claimed roll does not match computed roll");

  const last = at(pool.commitments, pool.commitments.length - 1);
  const newCommitment: ClosedSecret = {
    seed: last.seed,
    author: pool.author,
    seqId: last.seqId + 1,
    fingerprint: reveal.newFingerprint,
  };

  const updatedPool: SecretPoolState = {
    author: pool.author,
    commitments: [...pool.commitments, newCommitment],
    consumedCount: pool.consumedCount + 1,
  };

  return { roll, updatedPool };
}

/**
 * Verify a reveal without mutating pool state. Read-only alternative to processReveal.
 * Checks that the secret matches the expected fingerprint, the state exists in the chain,
 * and the claimed roll matches the computed roll.
 * See README for full error table.
 *
 * @param author - The pool author whose commitment is being revealed
 * @param expectedFingerprint - The fingerprint from the pool commitment this reveal should match
 * @param reveal - The reveal event
 * @param states - Game state chain for side/prev-hash lookup
 * @param challenger - Optional challenger commitment for multi-source verification. Required when `reveal.challengerSecret` is set.
 */
export function verifyReveal(
  author: string,
  expectedFingerprint: string,
  reveal: Reveal,
  states: readonly GameState[],
  challenger?: ChallengerCommitment,
): void {
  if (!/^[0-9a-f]{64}$/i.test(reveal.newFingerprint)) throw new Error("newFingerprint must be a 64-char hex string");
  const fingerprint = taggedHash("urd-commit/v1", reveal.seed, author, reveal.seqId.toString(), reveal.secret);
  if (fingerprint !== expectedFingerprint) throw new Error("Secret does not match fingerprint");
  const state = lookupState(states, reveal.stateHash);
  const sides = state.sides!;
  const rollHash = state.prevHash ?? state.hash;

  if (reveal.challengerSecret !== undefined) {
    if (!challenger) throw new Error("Challenger secret provided but no challenger commitment");
    const expectedFp = taggedHash("urd-commit/v1", challenger.seed, challenger.author, challenger.seqId.toString(), reveal.challengerSecret);
    if (expectedFp !== challenger.fingerprint) throw new Error("Challenger secret does not match challenger commitment");
  }

  const roll = deriveRoll(rollHash, reveal.secret, sides, reveal.challengerSecret);
  if (roll !== reveal.claimedRoll) throw new Error("Claimed roll does not match computed roll");
}

/** The result of verifyGame: whether the game is valid and a list of error messages. */
export interface VerifyGameResult {
  valid: boolean;
  errors: string[];
}

/**
 * Verify a complete game: chain integrity, pool reconstruction, fingerprint matching,
 * roll correctness, and side consistency. All checks run regardless of intermediate
 * failures (errors are accumulated).
 *
 * @param states - The full game state chain
 * @param initialCommitments - Map of author → their initial ClosedSecret commitments
 * @param reveals - Map of author → their Reveal events (in order)
 * @param openedSecrets - Map of author → their OpenSecret records (one per consumed commitment)
 * @param expectedSides - Optional: if set, validates every reveal's state.sides matches
 * @param challengerCommitments - Optional: map of author → their challenger commitments (parallel to reveals, undefined = no challenger for that reveal)
 * @returns VerifyGameResult with valid flag and accumulated error messages
 */
export function verifyGame(
  states: readonly GameState[],
  initialCommitments: Record<string, readonly ClosedSecret[]>,
  reveals: Record<string, readonly Reveal[]>,
  openedSecrets: Record<string, readonly OpenSecret[]>,
  expectedSides?: number,
  challengerCommitments?: Record<string, readonly (ChallengerCommitment | undefined)[]>,
): VerifyGameResult {
  const errors: string[] = [];

  try {
    verifyChain(states);
  } catch (e) {
    return { valid: false, errors: [(e as Error).message] };
  }

  for (const author of Object.keys(reveals)) {
    if (!(author in initialCommitments)) {
      errors.push(`Author ${author} has reveals but no initial commitments`);
    }
  }

  for (const author of Object.keys(openedSecrets)) {
    if (!(author in initialCommitments)) {
      errors.push(`Author ${author} has opened secrets but no initial commitments`);
    }
  }

  for (const [author, commitments] of Object.entries(initialCommitments)) {
    const authorReveals = reveals[author] ?? [];
    const authorOpened = openedSecrets[author] ?? [];

    let poolReconstructFailed = false;
    try {
      const pool = reconstructPool(author, [...commitments], [...authorReveals], states, challengerCommitments?.[author]);
      if (authorOpened.length !== pool.consumedCount) {
        errors.push(`Opened secrets count for ${author}: have ${authorOpened.length}, need ${pool.consumedCount}`);
      } else {
        try {
          verifyPoolFingerprints(pool, [...authorOpened]);
        } catch (e) {
          errors.push(`Pool fingerprint mismatch for ${author}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      poolReconstructFailed = true;
      errors.push(`Pool reconstruction failed for ${author}: ${(e as Error).message}`);
    }

    for (const reveal of authorReveals) {
      const state = findStateInChain(states, reveal.stateHash);
      if (!state) {
        errors.push(`Reveal seqId ${reveal.seqId} by ${author} references unknown state ${reveal.stateHash.slice(0, 8)}...`);
      } else if (expectedSides !== undefined && !poolReconstructFailed) {
        if (state.sides !== expectedSides) {
          errors.push(`Reveal seqId ${reveal.seqId} by ${author} has sides ${state.sides}, expected ${expectedSides}`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Reconstruct a SecretPoolState from initial commitments and a sequence of reveals.
 * Replays reveals in order via processReveal.
 *
 * @param author - Pool author
 * @param commitments - Initial ClosedSecret commitments (will be sorted)
 * @param reveals - Reveal events in chronological order
 * @param states - Game state chain for roll derivation
 * @param challengerCommitments - Optional parallel array of challenger commitments (one per reveal, undefined if no challenger for that reveal)
 * @returns The reconstructed SecretPoolState
 */
export function reconstructPool(
  author: string,
  commitments: ClosedSecret[],
  reveals: Reveal[],
  states: readonly GameState[],
  challengerCommitments?: readonly (ChallengerCommitment | undefined)[],
): SecretPoolState {
  let pool = createPool(author, commitments);
  for (let i = 0; i < reveals.length; i++) {
    const reveal = at(reveals, i);
    const challenger = challengerCommitments?.[i];
    const result = processReveal(pool, reveal, states, challenger);
    pool = result.updatedPool;
  }
  return pool;
}

/**
 * Internal helper: find a state in the chain and validate its sides field.
 * Throws if the state is not found, missing sides, or has invalid sides.
 */
function lookupState(states: readonly GameState[], stateHash: string): GameState {
  const state = findStateInChain(states, stateHash);
  if (!state) throw new Error(`State ${stateHash.slice(0, 8)}... not found in chain`);
  if (state.sides === undefined) throw new Error(`State ${stateHash.slice(0, 8)}... does not define sides`);
  if (!Number.isFinite(state.sides) || !Number.isInteger(state.sides) || state.sides < 2 || state.sides > MAX_SIDES) throw new Error(`State ${stateHash.slice(0, 8)}... sides must be a finite integer >= 2 and ≤ 2^48, got ${state.sides}`);
  return state;
}

/**
 * Look up the `sides` value from a game state in the chain.
 * Throws if the state is not found, missing sides, or has invalid sides.
 */
export function lookupSides(states: readonly GameState[], stateHash: string): number {
  return lookupState(states, stateHash).sides!;
}

/**
 * Find a GameState in the chain by its hash. Returns null if not found.
 */
export function findStateInChain(chain: readonly GameState[], hash: string): GameState | null {
  for (const state of chain) {
    if (state.hash === hash) return state;
  }
  return null;
}

/**
 * Verify that opened secrets match the consumed commitments in a pool one-to-one.
 * Each opened secret must correspond to a consumed commitment (by author, seqId, seed)
 * and pass verifyOpenSecret. See README for error details.
 */
export function verifyPoolFingerprints(pool: SecretPoolState, opened: OpenSecret[]): void {
  if (opened.length !== pool.consumedCount) throw new Error(`Expected ${pool.consumedCount} opened secrets, got ${opened.length}`);
  const matched = new Array<boolean>(pool.consumedCount).fill(false);
  for (const open of opened) {
    let found = false;
    for (let i = 0; i < matched.length; i++) {
      if (at(matched, i)) continue;
      const c = at(pool.commitments, i);
      if (c.author === open.author && c.seqId === open.seqId && c.seed === open.seed) {
        matched[i] = true;
        found = true;
        break;
      }
    }
    if (!found) throw new Error(`Opened secret (author=${open.author}, seqId=${open.seqId}) not found in pool commitments`);
    verifyOpenSecret(open);
  }
}
