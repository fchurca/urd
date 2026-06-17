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

export function createGenesisState(data: string, timestamp?: number): GameState {
  const ts = timestamp ?? Date.now();
  return {
    hash: hashState(data, null, ts),
    prevEventId: null,
    prevHash: null,
    data,
    timestamp: ts,
  };
}

export function createNextState(prev: GameState, data: string, timestamp?: number): GameState {
  const ts = timestamp ?? Date.now();
  const hash = hashState(data, prev.hash, ts);
  return {
    hash,
    prevEventId: prev.hash,
    prevHash: prev.hash,
    data,
    timestamp: ts,
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
      if (state.prevEventId !== prev.hash && state.prevEventId !== null) return false;
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
