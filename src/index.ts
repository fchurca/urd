import { createHash } from "node:crypto";

export interface GameState {
  hash: string;
  prevHash: string | null;
  data: string;
  timestamp: number;
}

export interface ClosedSecret {
  author: string;
  seqId: number;
  fingerprint: string;
}

export interface OpenSecret {
  author: string;
  seqId: number;
  fingerprint: string;
  secret: string;
}

function hashState(data: string, prevHash: string | null, timestamp: number): string {
  return createHash("sha256")
    .update(data)
    .update(prevHash ?? "\0")
    .update(timestamp.toString())
    .digest("hex");
}

export function createClosedSecret(author: string, seqId: number, secret: string): ClosedSecret {
  const fingerprint = createHash("sha256")
    .update(author)
    .update(seqId.toString())
    .update(secret)
    .digest("hex");
  return { author, seqId, fingerprint };
}

export function openSecret(closed: ClosedSecret, secret: string): OpenSecret {
  const fingerprint = createHash("sha256")
    .update(closed.author)
    .update(closed.seqId.toString())
    .update(secret)
    .digest("hex");
  if (fingerprint !== closed.fingerprint) throw new Error("Secret does not match fingerprint");
  return {
    author: closed.author,
    seqId: closed.seqId,
    fingerprint: closed.fingerprint,
    secret,
  };
}

export function verifyOpenSecret(open: OpenSecret): boolean {
  const fingerprint = createHash("sha256")
    .update(open.author)
    .update(open.seqId.toString())
    .update(open.secret)
    .digest("hex");
  return fingerprint === open.fingerprint;
}

export function createGenesisState(data: string, timestamp: number): GameState {
  return {
    hash: hashState(data, null, timestamp),
    prevHash: null,
    data,
    timestamp,
  };
}

export function createNextState(prev: GameState, data: string, timestamp: number): GameState {
  const hash = hashState(data, prev.hash, timestamp);
  return {
    hash,
    prevHash: prev.hash,
    data,
    timestamp,
  };
}

export function verifyChain(states: readonly GameState[]): boolean {
  for (let i = 0; i < states.length; i++) {
    const state = states[i]!;
    const expectedHash = hashState(state.data, state.prevHash, state.timestamp);
    if (state.hash !== expectedHash) return false;
    if (i > 0) {
      const prev = states[i - 1]!;
      if (state.prevHash !== prev.hash) return false;
    } else {
      if (state.prevHash !== null) return false;
    }
  }
  return true;
}

export function deriveRoll(stateHash: string, secret: string, sides: number): number {
  if (sides <= 0) throw new Error("Roll sides must be positive");
  const hash = createHash("sha256")
    .update(stateHash)
    .update(secret)
    .digest("hex");
  const maxVal = 2 ** 48;
  const maxAcceptable = maxVal - (maxVal % sides);
  for (let offset = 0; offset + 12 <= hash.length; offset += 12) {
    const val = parseInt(hash.slice(offset, offset + 12), 16);
    if (val < maxAcceptable) return (val % sides) + 1;
  }
  return (parseInt(hash.slice(0, 12), 16) % sides) + 1;
}

export interface SecretPoolState {
  author: string;
  commitments: ClosedSecret[];
  consumedUpTo: number;
}

export function createPool(author: string, commitments: ClosedSecret[]): SecretPoolState {
  const sorted = [...commitments].sort((a, b) => a.seqId - b.seqId);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.seqId === sorted[i - 1]!.seqId) throw new Error("Duplicate seqId in pool");
  }
  for (const c of sorted) {
    if (c.author !== author) throw new Error("Commitment author does not match pool author");
  }
  return { author, commitments: sorted, consumedUpTo: 0 };
}

export interface Challenge {
  seqId: number;
  fingerprint: string;
}

export function nextChallenge(pool: SecretPoolState): Challenge | null {
  if (pool.consumedUpTo >= pool.commitments.length) return null;
  const next = pool.commitments[pool.consumedUpTo]!;
  return { seqId: next.seqId, fingerprint: next.fingerprint };
}

export interface ChallengeEvent {
  challenger: string;
  targetAuthor: string;
  seqId: number;
  fingerprint: string;
}

export function verifyChallenge(pool: SecretPoolState, challenge: ChallengeEvent): boolean {
  const next = nextChallenge(pool);
  if (!next) return false;
  if (challenge.targetAuthor !== pool.author) return false;
  if (challenge.seqId !== next.seqId) return false;
  if (challenge.fingerprint !== next.fingerprint) return false;
  return true;
}

export interface Reveal {
  seqId: number;
  secret: string;
  newFingerprint: string;
  stateHash: string;
  sides: number;
}

export interface RevealOutput {
  roll: number;
  updatedPool: SecretPoolState;
}

export function revealSecret(pool: SecretPoolState, reveal: Reveal): RevealOutput {
  const challenge = nextChallenge(pool);
  if (!challenge) throw new Error("No pending challenge");
  if (reveal.seqId !== challenge.seqId) throw new Error("seqId does not match next challenge");

  const fingerprint = createHash("sha256")
    .update(pool.author)
    .update(reveal.seqId.toString())
    .update(reveal.secret)
    .digest("hex");
  if (fingerprint !== challenge.fingerprint) throw new Error("Secret does not match fingerprint");

  const roll = deriveRoll(reveal.stateHash, reveal.secret, reveal.sides);

  const lastSeqId = pool.commitments[pool.commitments.length - 1]!.seqId;
  const newCommitment: ClosedSecret = {
    author: pool.author,
    seqId: lastSeqId + 1,
    fingerprint: reveal.newFingerprint,
  };

  const updatedPool: SecretPoolState = {
    author: pool.author,
    commitments: [...pool.commitments, newCommitment],
    consumedUpTo: pool.consumedUpTo + 1,
  };

  return { roll, updatedPool };
}

export function verifyReveal(
  author: string,
  expectedFingerprint: string,
  seqId: number,
  secret: string,
  stateHash: string,
  sides: number,
  claimedRoll: number,
): boolean {
  const fingerprint = createHash("sha256")
    .update(author)
    .update(seqId.toString())
    .update(secret)
    .digest("hex");
  if (fingerprint !== expectedFingerprint) return false;
  const roll = deriveRoll(stateHash, secret, sides);
  return roll === claimedRoll;
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
): VerifyGameResult {
  const errors: string[] = [];

  if (!verifyChain(states)) {
    errors.push("Game state chain is invalid");
    return { valid: false, errors };
  }

  for (const [author, commitments] of Object.entries(initialCommitments)) {
    const authorReveals = reveals[author] ?? [];
    const authorOpened = openedSecrets[author] ?? [];

    try {
      const pool = reconstructPool(author, [...commitments], [...authorReveals]);
      if (!verifyPoolFingerprints(pool, [...authorOpened])) {
        errors.push(`Pool fingerprint mismatch for ${author}`);
      }
    } catch (e) {
      errors.push(`Pool reconstruction failed for ${author}: ${(e as Error).message}`);
    }

    for (const reveal of authorReveals) {
      if (!findStateInChain(states, reveal.stateHash)) {
        errors.push(`Reveal seqId ${reveal.seqId} by ${author} references unknown state ${reveal.stateHash.slice(0, 8)}...`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function reconstructPool(
  author: string,
  commitments: ClosedSecret[],
  reveals: Reveal[],
): SecretPoolState {
  let pool = createPool(author, commitments);
  for (const reveal of reveals) {
    const result = revealSecret(pool, reveal);
    pool = result.updatedPool;
  }
  return pool;
}

export function findStateInChain(chain: readonly GameState[], hash: string): GameState | null {
  for (const state of chain) {
    if (state.hash === hash) return state;
  }
  return null;
}

export function verifyPoolFingerprints(pool: SecretPoolState, opened: OpenSecret[]): boolean {
  for (const open of opened) {
    const match = pool.commitments.find(
      (c) => c.author === open.author && c.seqId === open.seqId,
    );
    if (!match) return false;
    if (!verifyOpenSecret(open)) return false;
  }
  return true;
}
