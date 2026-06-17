import { describe, it } from "node:test";
import { equal, ok, throws } from "node:assert/strict";
import type { GameState } from "./index.ts";
import {
  createGenesisState,
  createNextState,
  verifyChain,
  createClosedSecret,
  openSecret,
  verifyOpenSecret,
  deriveRoll,
  createPool,
  nextChallenge,
  revealSecret,
  verifyReveal,
} from "./index.ts";

describe("GameState chain", () => {
  it("creates a genesis state with no previous reference", () => {
    const g = createGenesisState("game started", 0);
    equal(g.data, "game started");
    equal(g.prevHash, null);
    equal(g.prevEventId, null);
    equal(g.timestamp, 0);
    ok(typeof g.hash === "string" && g.hash.length === 64);
  });

  it("chains a next state to its predecessor", () => {
    const g1 = createGenesisState("turn 1", 100);
    const g2 = createNextState(g1, "turn 2", 200);
    equal(g2.prevHash, g1.hash);
    equal(g2.prevEventId, g1.hash);
    equal(g2.data, "turn 2");
  });

  it("forms a chain of 3 states", () => {
    const g1 = createGenesisState("a", 0);
    const g2 = createNextState(g1, "b", 1);
    const g3 = createNextState(g2, "c", 2);
    ok(verifyChain([g1, g2, g3]));
  });

  it("rejects a chain with a tampered hash", () => {
    const g1 = createGenesisState("a", 0);
    const g2 = createNextState(g1, "b", 1);
    const tampered: typeof g2 = { ...g2, data: "X" };
    equal(verifyChain([g1, tampered]), false);
  });

  it("rejects a chain with broken link", () => {
    const g1 = createGenesisState("a", 0);
    const g2 = createGenesisState("b", 1);
    equal(verifyChain([g1, g2]), false);
  });

  it("rejects a chain missing prevEventId on non-genesis state", () => {
    const g1 = createGenesisState("a", 0);
    const g2: GameState = { ...createNextState(g1, "b", 1), prevEventId: null };
    equal(verifyChain([g1, g2]), false);
  });
});

describe("Secret pool", () => {
  it("creates a closed secret from author, seq id, and secret", () => {
    const s = createClosedSecret("alice", 0, "my-secret");
    equal(s.author, "alice");
    equal(s.seqId, 0);
    ok(typeof s.fingerprint === "string" && s.fingerprint.length === 64);
  });

  it("creates consistent fingerprints for identical inputs", () => {
    const a = createClosedSecret("bob", 1, "hello");
    const b = createClosedSecret("bob", 1, "hello");
    equal(a.fingerprint, b.fingerprint);
  });

  it("produces different fingerprints for different seq ids", () => {
    const a = createClosedSecret("bob", 1, "same-secret");
    const b = createClosedSecret("bob", 2, "same-secret");
    ok(a.fingerprint !== b.fingerprint);
  });

  it("opens a closed secret into an open secret", () => {
    const closed = createClosedSecret("alice", 0, "my-secret");
    const opened = openSecret(closed, "my-secret");
    equal(opened.author, "alice");
    equal(opened.seqId, 0);
    equal(opened.fingerprint, closed.fingerprint);
    equal(opened.secret, "my-secret");
  });

  it("verifies an open secret matches its fingerprint", () => {
    const closed = createClosedSecret("alice", 0, "my-secret");
    const opened = openSecret(closed, "my-secret");
    ok(verifyOpenSecret(opened));
  });

  it("rejects an open secret with wrong secret", () => {
    const closed = createClosedSecret("alice", 0, "my-secret");
    const tampered: typeof closed = { ...closed, fingerprint: "0000".padEnd(64, "0") };
    const opened = openSecret(tampered, "wrong-secret");
    equal(verifyOpenSecret(opened), false);
  });
});

describe("Roll derivation", () => {
  it("derives a deterministic roll from state hash and secret", () => {
    const r1 = deriveRoll("abc", "secret1", 20);
    const r2 = deriveRoll("abc", "secret1", 20);
    equal(r1, r2);
  });

  it("produces a value in [1, sides]", () => {
    for (let i = 0; i < 50; i++) {
      const r = deriveRoll(`state${i}`, `secret${i}`, 20);
      ok(r >= 1 && r <= 20, `roll ${r} out of range`);
    }
  });

  it("changes result when state hash changes", () => {
    const r1 = deriveRoll("state-a", "x", 100);
    const r2 = deriveRoll("state-b", "x", 100);
    ok(r1 !== r2);
  });
});

describe("Challenge / reveal", () => {
  const aliceSecrets = [
    createClosedSecret("alice", 0, "secret-0"),
    createClosedSecret("alice", 1, "secret-1"),
    createClosedSecret("alice", 2, "secret-2"),
  ];

  it("creates a pool and picks the first challenge", () => {
    const pool = createPool("alice", aliceSecrets);
    equal(pool.author, "alice");
    equal(pool.consumedUpTo, 0);
    const c = nextChallenge(pool);
    ok(c !== null);
    equal(c!.seqId, 0);
    equal(c!.fingerprint, aliceSecrets[0]!.fingerprint);
  });

  it("sorts commitments by seqId regardless of input order", () => {
    const pool = createPool("alice", [
      createClosedSecret("alice", 3, "z"),
      createClosedSecret("alice", 0, "a"),
      createClosedSecret("alice", 1, "m"),
    ]);
    equal(nextChallenge(pool)!.seqId, 0);
    equal(pool.commitments[0]!.seqId, 0);
    equal(pool.commitments[1]!.seqId, 1);
    equal(pool.commitments[2]!.seqId, 3);
  });

  it("rejects a pool with mismatched author", () => {
    throws(() => createPool("alice", [createClosedSecret("bob", 0, "x")]));
  });

  it("advances the challenge after a reveal", () => {
    const pool = createPool("alice", [aliceSecrets[0]!]);
    equal(nextChallenge(pool)!.seqId, 0);
    const { updatedPool } = revealSecret(pool, {
      seqId: 0,
      secret: "secret-0",
      newFingerprint: createClosedSecret("alice", 1, "replenish-0").fingerprint,
      stateHash: "state-0",
      sides: 20,
    });
    const next = nextChallenge(updatedPool);
    ok(next !== null);
    equal(next!.seqId, 1);
    equal(next!.fingerprint, createClosedSecret("alice", 1, "replenish-0").fingerprint);
  });

  it("processes a reveal and returns a valid roll", () => {
    const pool = createPool("alice", aliceSecrets);
    const newFp = createClosedSecret("alice", 3, "new-secret").fingerprint;
    const { roll, updatedPool } = revealSecret(pool, {
      seqId: 0,
      secret: "secret-0",
      newFingerprint: newFp,
      stateHash: "state-1",
      sides: 20,
    });
    ok(roll >= 1 && roll <= 20);
    equal(updatedPool.consumedUpTo, 1);
    equal(updatedPool.commitments.length, 4);
    equal(updatedPool.commitments[3]!.fingerprint, newFp);
  });

  it("steps through multiple reveals and never runs out due to replenish", () => {
    let pool = createPool("alice", aliceSecrets);
    for (let i = 0; i < 3; i++) {
      const c = nextChallenge(pool);
      ok(c !== null);
      equal(c!.seqId, i);
      const result = revealSecret(pool, {
        seqId: i,
        secret: `secret-${i}`,
        newFingerprint: createClosedSecret("alice", 3 + i, `replenish-${i}`).fingerprint,
        stateHash: `state-${i}`,
        sides: 6,
      });
      pool = result.updatedPool;
    }
    equal(pool.consumedUpTo, 3);
    equal(pool.commitments.length, 6);
    const next = nextChallenge(pool);
    ok(next !== null);
    equal(next!.seqId, 3);
  });

  it("rejects a reveal with wrong seqId", () => {
    const pool = createPool("alice", aliceSecrets);
    throws(() => revealSecret(pool, {
      seqId: 99,
      secret: "anything",
      newFingerprint: "x".repeat(64),
      stateHash: "s",
      sides: 20,
    }));
  });

  it("rejects a reveal with wrong secret", () => {
    const pool = createPool("alice", aliceSecrets);
    throws(() => revealSecret(pool, {
      seqId: 0,
      secret: "wrong-secret",
      newFingerprint: "x".repeat(64),
      stateHash: "s",
      sides: 20,
    }));
  });

  it("allows reveal against the same pool state (caller must track pool via event chain)", () => {
    const pool = createPool("alice", [aliceSecrets[0]!]);
    const input = {
      seqId: 0,
      secret: "secret-0",
      newFingerprint: createClosedSecret("alice", 1, "x").fingerprint,
      stateHash: "s",
      sides: 20,
    };
    const r1 = revealSecret(pool, input);
    const r2 = revealSecret(pool, input);
    equal(r1.roll, r2.roll);
    equal(r1.updatedPool.consumedUpTo, 1);
    equal(r2.updatedPool.consumedUpTo, 1);
  });

  it("verifies a reveal independently", () => {
    const closed = createClosedSecret("bob", 5, "bob-secret");
    const stateHash = "game-state-42";
    const sides = 20;
    const secret = "bob-secret";
    const expectedRoll = deriveRoll(stateHash, secret, sides);
    ok(verifyReveal("bob", closed.fingerprint, 5, secret, stateHash, sides, expectedRoll));
  });

  it("rejects verification with wrong claimed roll", () => {
    const closed = createClosedSecret("bob", 5, "bob-secret");
    equal(verifyReveal("bob", closed.fingerprint, 5, "bob-secret", "state", 20, 999), false);
  });

  it("rejects verification with wrong secret", () => {
    const closed = createClosedSecret("bob", 5, "bob-secret");
    const goodRoll = deriveRoll("state", "bob-secret", 20);
    equal(verifyReveal("bob", closed.fingerprint, 5, "wrong", "state", 20, goodRoll), false);
  });
});
