import { createHash } from "node:crypto";

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

function at<T>(arr: readonly T[], index: number): T {
  const val = arr[index];
  if (val === undefined) throw new Error(`Index ${index} out of bounds`);
  return val;
}

function hashState(data: string, prevHash: string | null, timestamp: number, sides?: number): string {
  const h = createHash("sha256")
    .update(data)
    .update(prevHash ?? "\0")
    .update(timestamp.toString());
  if (sides !== undefined) h.update(sides.toString());
  return h.digest("hex");
}

export function createClosedSecret(author: string, seqId: number, secret: string, seed: string): ClosedSecret {
  const fingerprint = createHash("sha256")
    .update(seed)
    .update(author)
    .update(seqId.toString())
    .update(secret)
    .digest("hex");
  return { seed, author, seqId, fingerprint };
}

export function openSecret(closed: ClosedSecret, secret: string): OpenSecret {
  const fingerprint = createHash("sha256")
    .update(closed.seed)
    .update(closed.author)
    .update(closed.seqId.toString())
    .update(secret)
    .digest("hex");
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
  const fingerprint = createHash("sha256")
    .update(open.seed)
    .update(open.author)
    .update(open.seqId.toString())
    .update(open.secret)
    .digest("hex");
  if (fingerprint !== open.fingerprint) throw new Error("Secret does not match fingerprint");
}

export function createGenesisState(data: string, timestamp: number, sides?: number): GameState {
  return {
    hash: hashState(data, null, timestamp, sides),
    prevHash: null,
    data,
    timestamp,
    sides,
  };
}

export function createNextState(prev: GameState, data: string, timestamp: number, sides?: number): GameState {
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

export function deriveRoll(stateHash: string, secret: string, sides: number): number {
  if (!Number.isFinite(sides) || !Number.isInteger(sides) || sides < 2) throw new Error("Roll sides must be a finite integer >= 2");
  const maxVal = 2 ** 48;
  const maxAcceptable = maxVal - (maxVal % sides);
  let hash = createHash("sha256")
    .update(stateHash)
    .update(secret)
    .digest("hex");
  let offset = 0;
  while (true) {
    if (offset + 12 > hash.length) {
      hash = createHash("sha256").update(hash).digest("hex");
      offset = 0;
    }
    const val = parseInt(hash.slice(offset, offset + 12), 16);
    offset += 12;
    if (val < maxAcceptable) return (val % sides) + 1;
  }
}

export interface SecretPoolState {
  author: string;
  commitments: ClosedSecret[];
  consumedCount: number;
}

export function createPool(author: string, commitments: ClosedSecret[]): SecretPoolState {
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

export interface Challenge {
  seed: string;
  seqId: number;
  fingerprint: string;
}

export function nextChallenge(pool: SecretPoolState): Challenge | null {
  if (pool.consumedCount >= pool.commitments.length) return null;
  const next = at(pool.commitments, pool.consumedCount);
  return { seed: next.seed, seqId: next.seqId, fingerprint: next.fingerprint };
}

export interface ChallengeEvent {
  challenger: string;
  targetAuthor: string;
  seed: string;
  seqId: number;
  fingerprint: string;
}

export function verifyChallenge(pool: SecretPoolState, challenge: ChallengeEvent): void {
  const next = nextChallenge(pool);
  if (!next) throw new Error("No pending challenge");
  if (challenge.targetAuthor !== pool.author) throw new Error("Challenge target author does not match pool author");
  if (challenge.seed !== next.seed) throw new Error("Challenge seed does not match next commitment");
  if (challenge.seqId !== next.seqId) throw new Error("Challenge seqId does not match next commitment");
  if (challenge.fingerprint !== next.fingerprint) throw new Error("Challenge fingerprint does not match next commitment");
}

export interface Reveal {
  seed: string;
  seqId: number;
  secret: string;
  newFingerprint: string;
  stateHash: string;
  claimedRoll: number;
}

export interface RevealOutput {
  roll: number;
  updatedPool: SecretPoolState;
}

export function revealSecret(pool: SecretPoolState, reveal: Reveal, states: readonly GameState[]): RevealOutput {
  if (!/^[0-9a-f]{64}$/i.test(reveal.newFingerprint)) throw new Error("newFingerprint must be a 64-char hex string");
  const challenge = nextChallenge(pool);
  if (!challenge) throw new Error("No pending challenge");
  if (reveal.seqId !== challenge.seqId) throw new Error("seqId does not match next challenge");
  if (reveal.seed !== challenge.seed) throw new Error("Seed does not match challenge");

  const fingerprint = createHash("sha256")
    .update(reveal.seed)
    .update(pool.author)
    .update(reveal.seqId.toString())
    .update(reveal.secret)
    .digest("hex");
  if (fingerprint !== challenge.fingerprint) throw new Error("Secret does not match fingerprint");

  const sides = lookupSides(states, reveal.stateHash);
  const roll = deriveRoll(reveal.stateHash, reveal.secret, sides);
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

export function verifyReveal(
  author: string,
  expectedFingerprint: string,
  reveal: Reveal,
  states: readonly GameState[],
): void {
  if (!/^[0-9a-f]{64}$/i.test(reveal.newFingerprint)) throw new Error("newFingerprint must be a 64-char hex string");
  const fingerprint = createHash("sha256")
    .update(reveal.seed)
    .update(author)
    .update(reveal.seqId.toString())
    .update(reveal.secret)
    .digest("hex");
  if (fingerprint !== expectedFingerprint) throw new Error("Reveal fingerprint does not match commitment");
  const sides = lookupSides(states, reveal.stateHash);
  const roll = deriveRoll(reveal.stateHash, reveal.secret, sides);
  if (roll !== reveal.claimedRoll) throw new Error("Claimed roll does not match computed roll");
}

export interface VerifyGameResult {
  valid: boolean;
  errors: string[];
}

export function verifyGame(
  states: readonly GameState[],
  initialCommitments: Record<string, readonly ClosedSecret[]>,
  reveals: Record<string, readonly Reveal[]>,
  openedSecrets: Record<string, readonly OpenSecret[]>,
  expectedSides?: number,
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

  for (const [author, commitments] of Object.entries(initialCommitments)) {
    const authorReveals = reveals[author] ?? [];
    const authorOpened = openedSecrets[author] ?? [];

    let poolReconstructFailed = false;
    try {
      const pool = reconstructPool(author, [...commitments], [...authorReveals], states);
      if (authorOpened.length < pool.consumedCount) {
        errors.push(`Missing opened secrets for ${author}: have ${authorOpened.length}, need ${pool.consumedCount}`);
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

export function reconstructPool(
  author: string,
  commitments: ClosedSecret[],
  reveals: Reveal[],
  states: readonly GameState[],
): SecretPoolState {
  let pool = createPool(author, commitments);
  for (const reveal of reveals) {
    const result = revealSecret(pool, reveal, states);
    pool = result.updatedPool;
  }
  return pool;
}

export function lookupSides(states: readonly GameState[], stateHash: string): number {
  const state = findStateInChain(states, stateHash);
  if (!state) throw new Error(`State ${stateHash.slice(0, 8)}... not found in chain`);
  if (state.sides === undefined) throw new Error(`State ${stateHash.slice(0, 8)}... does not define sides`);
  if (!Number.isFinite(state.sides) || !Number.isInteger(state.sides) || state.sides < 2) throw new Error(`State ${stateHash.slice(0, 8)}... sides must be a finite integer >= 2, got ${state.sides}`);
  return state.sides;
}

export function findStateInChain(chain: readonly GameState[], hash: string): GameState | null {
  for (const state of chain) {
    if (state.hash === hash) return state;
  }
  return null;
}

export function verifyPoolFingerprints(pool: SecretPoolState, opened: OpenSecret[]): void {
  for (const open of opened) {
    const match = pool.commitments.slice(0, pool.consumedCount).find(
      (c) => c.author === open.author && c.seqId === open.seqId && c.seed === open.seed,
    );
    if (!match) throw new Error(`Opened secret (author=${open.author}, seqId=${open.seqId}) not found in pool commitments`);
    verifyOpenSecret(open);
  }
}
