import { createHash } from "node:crypto";

export interface GameState {
  hash: string;
  prevEventId: string | null;
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
    prevEventId: null,
    prevHash: null,
    data,
    timestamp,
  };
}

export function createNextState(prev: GameState, data: string, timestamp: number): GameState {
  const hash = hashState(data, prev.hash, timestamp);
  return {
    hash,
    prevEventId: prev.hash,
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
      if (state.prevEventId !== prev.hash) return false;
    } else {
      if (state.prevHash !== null) return false;
      if (state.prevEventId !== null) return false;
    }
  }
  return true;
}

export function deriveRoll(stateHash: string, secret: string, sides: number): number {
  const hash = createHash("sha256")
    .update(stateHash)
    .update(secret)
    .digest("hex");
  const val = parseInt(hash.slice(0, 8), 16);
  return (val % sides) + 1;
}

export interface SecretPoolState {
  author: string;
  commitments: ClosedSecret[];
  consumedUpTo: number;
}

export function createPool(author: string, commitments: ClosedSecret[]): SecretPoolState {
  const sorted = [...commitments].sort((a, b) => a.seqId - b.seqId);
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
