import { describe, it } from "node:test";
import { doesNotThrow, equal, ok, throws } from "node:assert/strict";
import type { GameState, ChallengeEvent, Reveal } from "./index.ts";
import {
  createGenesisState,
  createNextState,
  verifyChain,
  createClosedSecret,
  createOpenSecret,
  verifyOpenSecret,
  deriveRoll,
  createPool,
  nextChallenge,
  processReveal,
  verifyReveal,
  reconstructPool,
  verifyPoolFingerprints,
  verifyChallenge,
  findStateInChain,
  verifyGame,
  lookupSides,
} from "./index.ts";

describe("GameState chain", () => {
  it("creates a genesis state with no previous reference", () => {
    const g = createGenesisState("game started", 0);
    equal(g.data, "game started");
    equal(g.prevHash, null);
    equal(g.timestamp, 0);
    ok(typeof g.hash === "string" && g.hash.length === 64);
  });

  it("chains a next state to its predecessor", () => {
    const g1 = createGenesisState("turn 1", 100);
    const g2 = createNextState(g1, "turn 2", 200);
    equal(g2.prevHash, g1.hash);
    equal(g2.data, "turn 2");
  });

  it("forms a chain of 3 states", () => {
    const g1 = createGenesisState("a", 0);
    const g2 = createNextState(g1, "b", 1);
    const g3 = createNextState(g2, "c", 2);
    doesNotThrow(() => verifyChain([g1, g2, g3]));
  });

  it("rejects a chain with a tampered hash", () => {
    const g1 = createGenesisState("a", 0);
    const g2 = createNextState(g1, "b", 1);
    const tampered: typeof g2 = { ...g2, data: "X" };
    throws(() => verifyChain([g1, tampered]));
  });

  it("rejects a chain with tampered sides", () => {
    const g1 = createGenesisState("a", 0);
    const g2 = createNextState(g1, "b", 1, 20);
    const tampered: typeof g2 = { ...g2, sides: 6 };
    throws(() => verifyChain([g1, tampered]));
  });

  it("rejects a chain with broken link", () => {
    const g1 = createGenesisState("a", 0);
    const g2 = createGenesisState("b", 1);
    throws(() => verifyChain([g1, g2]));
  });

  it("rejects a chain with a non-genesis state missing prevHash", () => {
    const g1 = createGenesisState("a", 0);
    const g2: GameState = { ...createNextState(g1, "b", 1), prevHash: null };
    throws(() => verifyChain([g1, g2]));
  });

  it("rejects an empty chain", () => {
    throws(() => verifyChain([]));
  });
});

describe("findStateInChain", () => {
  it("finds a state by hash in the chain", () => {
    const g1 = createGenesisState("a", 0);
    const g2 = createNextState(g1, "b", 1);
    const g3 = createNextState(g2, "c", 2);
    equal(findStateInChain([g1, g2, g3], g2.hash), g2);
  });

  it("returns null when hash is not found", () => {
    const g1 = createGenesisState("a", 0);
    equal(findStateInChain([g1], "nonexistent"), null);
  });

  it("returns first match in an unverified chain", () => {
    const g = createGenesisState("dup", 0);
    equal(findStateInChain([g, g], g.hash), g);
  });
});

describe("lookupSides", () => {
  it("returns sides from a state in the chain", () => {
    const g = createGenesisState("roll", 0, 20);
    equal(lookupSides([g], g.hash), 20);
  });

  it("throws when state hash is not found", () => {
    throws(() => lookupSides([], "unknown"));
  });

  it("throws when state does not define sides", () => {
    const g = createGenesisState("no dice", 0);
    throws(() => lookupSides([g], g.hash));
  });

  it("throws when sides is 1 or less", () => {
    const g0 = createGenesisState("zero", 0, 0);
    const g1 = createGenesisState("one", 0, 1);
    throws(() => lookupSides([g0], g0.hash));
    throws(() => lookupSides([g1], g1.hash));
  });
});

describe("Secret pool", () => {
  it("creates a closed secret from author, seq id, secret, and seed", () => {
    const s = createClosedSecret("alice", 0, "my-secret", "game-42");
    equal(s.author, "alice");
    equal(s.seqId, 0);
    equal(s.seed, "game-42");
    ok(typeof s.fingerprint === "string" && s.fingerprint.length === 64);
  });

  it("creates a closed secret with explicit empty seed", () => {
    const s = createClosedSecret("alice", 0, "secret", "");
    equal(s.seed, "");
  });

  it("creates consistent fingerprints for identical inputs", () => {
    const a = createClosedSecret("bob", 1, "hello", "");
    const b = createClosedSecret("bob", 1, "hello", "");
    equal(a.fingerprint, b.fingerprint);
  });

  it("produces different fingerprints for different seeds", () => {
    const a = createClosedSecret("alice", 0, "secret", "game-A");
    const b = createClosedSecret("alice", 0, "secret", "game-B");
    ok(a.fingerprint !== b.fingerprint);
  });

  it("produces different fingerprints for different seq ids", () => {
    const a = createClosedSecret("bob", 1, "same-secret", "");
    const b = createClosedSecret("bob", 2, "same-secret", "");
    ok(a.fingerprint !== b.fingerprint);
  });

  it("rejects non-finite, non-integer, or negative seqId", () => {
    throws(() => createClosedSecret("alice", NaN, "s", ""));
    throws(() => createClosedSecret("alice", Infinity, "s", ""));
    throws(() => createClosedSecret("alice", 3.14, "s", ""));
    throws(() => createClosedSecret("alice", -1, "s", ""));
  });

  it("opens a closed secret into an open secret", () => {
    const closed = createClosedSecret("alice", 0, "my-secret", "g");
    const opened = createOpenSecret(closed, "my-secret");
    equal(opened.author, "alice");
    equal(opened.seqId, 0);
    equal(opened.seed, "g");
    equal(opened.fingerprint, closed.fingerprint);
    equal(opened.secret, "my-secret");
  });

  it("verifies an open secret matches its fingerprint", () => {
    const closed = createClosedSecret("alice", 0, "my-secret", "g");
    const opened = createOpenSecret(closed, "my-secret");
    doesNotThrow(() => verifyOpenSecret(opened));
  });

  it("throws when opening a closed secret with the wrong secret", () => {
    const closed = createClosedSecret("alice", 0, "my-secret", "");
    throws(() => createOpenSecret(closed, "wrong-secret"));
  });

  it("rejects an open secret with wrong secret via verifyOpenSecret", () => {
    const closed = createClosedSecret("alice", 0, "real", "g");
    const opened = {
      seed: "g",
      author: "alice",
      seqId: 0,
      fingerprint: closed.fingerprint,
      secret: "fake",
    };
    throws(() => verifyOpenSecret(opened));
  });

  it("rejects an open secret with mismatched seed", () => {
    const closed = createClosedSecret("alice", 0, "s", "game-a");
    const opened = {
      seed: "game-b",
      author: "alice",
      seqId: 0,
      fingerprint: closed.fingerprint,
      secret: "s",
    };
    throws(() => verifyOpenSecret(opened));
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

  it("throws when sides is zero or negative", () => {
    throws(() => deriveRoll("x", "y", 0));
    throws(() => deriveRoll("x", "y", -1));
  });
});

describe("Challenge / reveal", () => {
  const aliceSecrets = [
    createClosedSecret("alice", 0, "secret-0", ""),
    createClosedSecret("alice", 1, "secret-1", ""),
    createClosedSecret("alice", 2, "secret-2", ""),
  ];

  it("creates a pool and picks the first challenge", () => {
    const pool = createPool("alice", aliceSecrets);
    equal(pool.author, "alice");
    equal(pool.consumedCount, 0);
    const c = nextChallenge(pool);
    ok(c !== null);
    equal(c!.seqId, 0);
    equal(c!.fingerprint, aliceSecrets[0]!.fingerprint);
  });

  it("sorts commitments by seqId regardless of input order", () => {
    const pool = createPool("alice", [
      createClosedSecret("alice", 3, "z", ""),
      createClosedSecret("alice", 0, "a", ""),
      createClosedSecret("alice", 1, "m", ""),
    ]);
    equal(nextChallenge(pool)!.seqId, 0);
    equal(pool.commitments[0]!.seqId, 0);
    equal(pool.commitments[1]!.seqId, 1);
    equal(pool.commitments[2]!.seqId, 3);
  });

  it("rejects a pool with mismatched author", () => {
    throws(() => createPool("alice", [createClosedSecret("bob", 0, "x", "")]));
  });

  it("rejects a pool with duplicate seqIds", () => {
    throws(() => createPool("alice", [
      createClosedSecret("alice", 0, "a", ""),
      createClosedSecret("alice", 0, "b", ""),
    ]));
  });

  it("rejects a pool with mismatched seeds", () => {
    throws(() => createPool("alice", [
      createClosedSecret("alice", 0, "a", "game-x"),
      createClosedSecret("alice", 1, "b", "game-y"),
    ]));
  });

  it("rejects an empty commitments array", () => {
    throws(() => createPool("alice", []));
  });

  it("advances the challenge after a reveal", () => {
    const pool = createPool("alice", [aliceSecrets[0]!]);
    equal(nextChallenge(pool)!.seqId, 0);
    const g = createGenesisState("roll", 0, 20);
    const roll = deriveRoll(g.hash, "secret-0", 20);
    const { updatedPool } = processReveal(pool, {
      seed: "",
      seqId: 0,
      secret: "secret-0",
      newFingerprint: createClosedSecret("alice", 1, "replenish-0", "").fingerprint,
      stateHash: g.hash,
      claimedRoll: roll,
    }, [g]);
    const next = nextChallenge(updatedPool);
    ok(next !== null);
    equal(next!.seqId, 1);
    equal(next!.fingerprint, createClosedSecret("alice", 1, "replenish-0", "").fingerprint);
  });

  it("processes a reveal and returns a valid roll", () => {
    const pool = createPool("alice", aliceSecrets);
    const newFp = createClosedSecret("alice", 3, "new-secret", "").fingerprint;
    const g = createGenesisState("roll", 0, 20);
    const expectedRoll = deriveRoll(g.hash, "secret-0", 20);
    const { roll, updatedPool } = processReveal(pool, {
      seed: "",
      seqId: 0,
      secret: "secret-0",
      newFingerprint: newFp,
      stateHash: g.hash,
      claimedRoll: expectedRoll,
    }, [g]);
    equal(roll, expectedRoll);
    ok(roll >= 1 && roll <= 20);
    equal(updatedPool.consumedCount, 1);
    equal(updatedPool.commitments.length, 4);
    equal(updatedPool.commitments[3]!.fingerprint, newFp);
  });

  it("steps through multiple reveals and never runs out due to replenish", () => {
    const g = createGenesisState("roll", 0, 6);
    let pool = createPool("alice", aliceSecrets);
    for (let i = 0; i < 3; i++) {
      const c = nextChallenge(pool);
      ok(c !== null);
      equal(c!.seqId, i);
      const roll = deriveRoll(g.hash, `secret-${i}`, 6);
      const result = processReveal(pool, {
        seed: "",
        seqId: i,
        secret: `secret-${i}`,
        newFingerprint: createClosedSecret("alice", 3 + i, `replenish-${i}`, "").fingerprint,
        stateHash: g.hash,
        claimedRoll: roll,
      }, [g]);
      pool = result.updatedPool;
    }
    equal(pool.consumedCount, 3);
    equal(pool.commitments.length, 6);
    const next = nextChallenge(pool);
    ok(next !== null);
    equal(next!.seqId, 3);
  });

  it("rejects a reveal with wrong seqId", () => {
    const pool = createPool("alice", aliceSecrets);
    const g = createGenesisState("roll", 0, 20);
    throws(() => processReveal(pool, {
      seed: "",
      seqId: 99,
      secret: "anything",
      newFingerprint: "a".repeat(64),
      stateHash: g.hash,
      claimedRoll: 1,
    }, [g]));
  });

  it("rejects a reveal with wrong seed", () => {
    const closed = createClosedSecret("alice", 0, "s", "real-seed");
    const pool = createPool("alice", [closed]);
    const g = createGenesisState("roll", 0, 20);
    throws(() => processReveal(pool, {
      seed: "wrong-seed",
      seqId: 0,
      secret: "s",
      newFingerprint: "a".repeat(64),
      stateHash: g.hash,
      claimedRoll: 1,
    }, [g]));
  });

  it("processes a reveal with non-empty seed", () => {
    const closed = createClosedSecret("alice", 0, "s", "my-seed");
    const pool = createPool("alice", [closed]);
    const newFp = createClosedSecret("alice", 1, "r", "my-seed").fingerprint;
    const g = createGenesisState("roll", 0, 20);
    const roll = deriveRoll(g.hash, "s", 20);
    const { updatedPool } = processReveal(pool, {
      seed: "my-seed",
      seqId: 0,
      secret: "s",
      newFingerprint: newFp,
      stateHash: g.hash,
      claimedRoll: roll,
    }, [g]);
    equal(updatedPool.consumedCount, 1);
    equal(updatedPool.commitments[1]!.seed, "my-seed");
  });

  it("rejects a reveal with wrong secret", () => {
    const pool = createPool("alice", aliceSecrets);
    const g = createGenesisState("roll", 0, 20);
    throws(() => processReveal(pool, {
      seed: "",
      seqId: 0,
      secret: "wrong-secret",
      newFingerprint: "a".repeat(64),
      stateHash: g.hash,
      claimedRoll: 1,
    }, [g]));
  });

  it("allows reveal against the same pool state (caller must track pool via event chain)", () => {
    const g = createGenesisState("roll", 0, 20);
    const pool = createPool("alice", [aliceSecrets[0]!]);
    const roll = deriveRoll(g.hash, "secret-0", 20);
    const input = {
      seed: "",
      seqId: 0,
      secret: "secret-0",
      newFingerprint: createClosedSecret("alice", 1, "x", "").fingerprint,
      stateHash: g.hash,
      claimedRoll: roll,
    };
    const r1 = processReveal(pool, input, [g]);
    const r2 = processReveal(pool, input, [g]);
    equal(r1.roll, r2.roll);
    equal(r1.updatedPool.consumedCount, 1);
    equal(r2.updatedPool.consumedCount, 1);
  });

  it("rejects a reveal with wrong claimed roll", () => {
    const pool = createPool("alice", [aliceSecrets[0]!]);
    const g = createGenesisState("roll", 0, 20);
    throws(() => processReveal(pool, {
      seed: "",
      seqId: 0,
      secret: "secret-0",
      newFingerprint: "a".repeat(64),
      stateHash: g.hash,
      claimedRoll: 999,
    }, [g]));
  });

  it("rejects a reveal with invalid newFingerprint", () => {
    const pool = createPool("alice", [aliceSecrets[0]!]);
    const g = createGenesisState("roll", 0, 20);
    throws(() => processReveal(pool, {
      seed: "",
      seqId: 0,
      secret: "secret-0",
      newFingerprint: "short",
      stateHash: g.hash,
      claimedRoll: 10,
    }, [g]));
  });

  it("verifies a reveal independently", () => {
    const closed = createClosedSecret("bob", 5, "bob-secret", "");
    const g = createGenesisState("roll", 0, 20);
    const reveal: Reveal = {
      seed: "",
      seqId: 5,
      secret: "bob-secret",
      newFingerprint: "a".repeat(64),
      stateHash: g.hash,
      claimedRoll: deriveRoll(g.hash, "bob-secret", 20),
    };
    doesNotThrow(() => verifyReveal("bob", closed.fingerprint, reveal, [g]));
  });

  it("verifies a reveal with seed", () => {
    const closed = createClosedSecret("bob", 5, "bob-secret", "game-X");
    const g = createGenesisState("roll", 0, 20);
    const reveal: Reveal = {
      seed: "game-X",
      seqId: 5,
      secret: "bob-secret",
      newFingerprint: "a".repeat(64),
      stateHash: g.hash,
      claimedRoll: deriveRoll(g.hash, "bob-secret", 20),
    };
    doesNotThrow(() => verifyReveal("bob", closed.fingerprint, reveal, [g]));
  });

  it("rejects verification with wrong claimed roll", () => {
    const closed = createClosedSecret("bob", 5, "bob-secret", "");
    const g = createGenesisState("roll", 0, 20);
    const reveal: Reveal = {
      seed: "",
      seqId: 5,
      secret: "bob-secret",
      newFingerprint: "a".repeat(64),
      stateHash: g.hash,
      claimedRoll: 999,
    };
    throws(() => verifyReveal("bob", closed.fingerprint, reveal, [g]));
  });

  it("rejects verification with wrong secret", () => {
    const closed = createClosedSecret("bob", 5, "bob-secret", "");
    const g = createGenesisState("roll", 0, 20);
    const goodRoll = deriveRoll(g.hash, "bob-secret", 20);
    const reveal: Reveal = {
      seed: "",
      seqId: 5,
      secret: "wrong",
      newFingerprint: "a".repeat(64),
      stateHash: g.hash,
      claimedRoll: goodRoll,
    };
    throws(() => verifyReveal("bob", closed.fingerprint, reveal, [g]));
  });

  it("rejects verification with invalid newFingerprint", () => {
    const closed = createClosedSecret("bob", 5, "bob-secret", "");
    const g = createGenesisState("roll", 0, 20);
    const goodRoll = deriveRoll(g.hash, "bob-secret", 20);
    const reveal: Reveal = {
      seed: "",
      seqId: 5,
      secret: "bob-secret",
      newFingerprint: "not-64-hex",
      stateHash: g.hash,
      claimedRoll: goodRoll,
    };
    throws(() => verifyReveal("bob", closed.fingerprint, reveal, [g]));
  });
});

describe("Pool reconstruction", () => {
  it("reconstructs pool from initial commitments and reveals", () => {
    const g = createGenesisState("roll", 0, 20);
    const commitments = [
      createClosedSecret("alice", 0, "s0", ""),
      createClosedSecret("alice", 1, "s1", ""),
    ];
    const reveals: Reveal[] = [
      {
        seed: "",
        seqId: 0,
        secret: "s0",
        newFingerprint: createClosedSecret("alice", 2, "r0", "").fingerprint,
        stateHash: g.hash,
        claimedRoll: deriveRoll(g.hash, "s0", 20),
      },
      {
        seed: "",
        seqId: 1,
        secret: "s1",
        newFingerprint: createClosedSecret("alice", 3, "r1", "").fingerprint,
        stateHash: g.hash,
        claimedRoll: deriveRoll(g.hash, "s1", 20),
      },
    ];
    const pool = reconstructPool("alice", commitments, reveals, [g]);
    equal(pool.consumedCount, 2);
    equal(pool.commitments.length, 4);
  });

  it("reconstruction yields the same pool as sequential reveals", () => {
    const g = createGenesisState("roll", 0, 6);
    const commitments = [createClosedSecret("alice", 0, "x", "")];
    const reveals: Reveal[] = [
      {
        seed: "",
        seqId: 0,
        secret: "x",
        newFingerprint: createClosedSecret("alice", 1, "y", "").fingerprint,
        stateHash: g.hash,
        claimedRoll: deriveRoll(g.hash, "x", 6),
      },
    ];
    const pool = reconstructPool("alice", commitments, reveals, [g]);
    equal(pool.consumedCount, 1);
    equal(nextChallenge(pool)!.seqId, 1);
  });

  it("reconstruction replays reveals in order", () => {
    throws(() => {
      reconstructPool("alice", [createClosedSecret("alice", 0, "s", "")], [
        {
          seed: "",
          seqId: 0,
          secret: "wrong",
          newFingerprint: "a".repeat(64),
          stateHash: "s",
          claimedRoll: 1,
        } as Reveal,
      ], []);
    });
  });
});

describe("Pool fingerprint verification", () => {
  it("verifies opened secrets against pool commitments", () => {
    const g = createGenesisState("roll", 0, 20);
    const s0 = createClosedSecret("alice", 0, "s0", "");
    const s1 = createClosedSecret("alice", 1, "s1", "");
    const r0 = createClosedSecret("alice", 2, "r0", "");
    const r1 = createClosedSecret("alice", 3, "r1", "");
    const reveals: Reveal[] = [
      { seed: "", seqId: 0, secret: "s0", newFingerprint: r0.fingerprint, stateHash: g.hash, claimedRoll: deriveRoll(g.hash, "s0", 20) },
      { seed: "", seqId: 1, secret: "s1", newFingerprint: r1.fingerprint, stateHash: g.hash, claimedRoll: deriveRoll(g.hash, "s1", 20) },
    ];
    const pool = reconstructPool("alice", [s0, s1], reveals, [g]);
    const opened = [createOpenSecret(s0, "s0"), createOpenSecret(s1, "s1")];
    doesNotThrow(() => verifyPoolFingerprints(pool, opened));
  });

  it("rejects when an opened secret is missing from the pool", () => {
    const s0 = createClosedSecret("alice", 0, "s0", "");
    const pool = createPool("alice", [s0]);
    const unknown = { seed: "", author: "alice", seqId: 99, fingerprint: "x".repeat(64), secret: "y" };
    throws(() => verifyPoolFingerprints(pool, [unknown]));
  });

  it("rejects when an opened secret has a wrong secret", () => {
    const s0 = createClosedSecret("alice", 0, "s0", "");
    const pool = createPool("alice", [s0]);
    const opened = { seed: "", author: "alice", seqId: 0, fingerprint: s0.fingerprint, secret: "wrong" };
    throws(() => verifyPoolFingerprints(pool, [opened]));
  });

  it("rejects opened secrets for unconsumed replenished commitments", () => {
    const g = createGenesisState("roll", 0, 20);
    const s0 = createClosedSecret("alice", 0, "s0", "");
    let pool = createPool("alice", [s0]);
    const roll = deriveRoll(g.hash, "s0", 20);
    const replenished = createClosedSecret("alice", 1, "r", "");
    const result = processReveal(pool, {
      seed: "",
      seqId: 0,
      secret: "s0",
      newFingerprint: replenished.fingerprint,
      stateHash: g.hash,
      claimedRoll: roll,
    }, [g]);
    pool = result.updatedPool;
    equal(pool.consumedCount, 1);
    const opened = createOpenSecret(replenished, "r");
    throws(() => verifyPoolFingerprints(pool, [opened]));
  });

  it("rejects duplicate opened secrets", () => {
    const g = createGenesisState("roll", 0, 20);
    const s0 = createClosedSecret("alice", 0, "s0", "");
    let pool = createPool("alice", [s0]);
    const roll = deriveRoll(g.hash, "s0", 20);
    const r0 = createClosedSecret("alice", 1, "r0", "");
    const result = processReveal(pool, {
      seed: "",
      seqId: 0,
      secret: "s0",
      newFingerprint: r0.fingerprint,
      stateHash: g.hash,
      claimedRoll: roll,
    }, [g]);
    pool = result.updatedPool;
    equal(pool.consumedCount, 1);
    const opened = createOpenSecret(s0, "s0");
    throws(() => verifyPoolFingerprints(pool, [opened, opened]));
  });

  it("rejects extra opened secrets beyond consumed count", () => {
    const g = createGenesisState("roll", 0, 20);
    const s0 = createClosedSecret("alice", 0, "s0", "");
    let pool = createPool("alice", [s0]);
    const roll = deriveRoll(g.hash, "s0", 20);
    const r0 = createClosedSecret("alice", 1, "r0", "");
    const result = processReveal(pool, {
      seed: "",
      seqId: 0,
      secret: "s0",
      newFingerprint: r0.fingerprint,
      stateHash: g.hash,
      claimedRoll: roll,
    }, [g]);
    pool = result.updatedPool;
    equal(pool.consumedCount, 1);
    const opened = createOpenSecret(s0, "s0");
    const extra = { seed: "", author: "alice", seqId: 99, fingerprint: "x".repeat(64), secret: "y" };
    throws(() => verifyPoolFingerprints(pool, [opened, extra]));
  });
});

describe("Challenge verification", () => {
  it("verifies a challenge matches the next expected one", () => {
    const pool = createPool("alice", [createClosedSecret("alice", 0, "s0", "")]);
    const challenge: ChallengeEvent = {
      challenger: "bob",
      targetAuthor: "alice",
      seed: "",
      seqId: 0,
      fingerprint: pool.commitments[0]!.fingerprint,
    };
    doesNotThrow(() => verifyChallenge(pool, challenge));
  });

  it("rejects a challenge with wrong fingerprint", () => {
    const pool = createPool("alice", [createClosedSecret("alice", 0, "s0", "")]);
    const challenge: ChallengeEvent = {
      challenger: "bob",
      targetAuthor: "alice",
      seed: "",
      seqId: 0,
      fingerprint: "x".repeat(64),
    };
    throws(() => verifyChallenge(pool, challenge));
  });

  it("rejects a challenge with wrong seed", () => {
    const s = createClosedSecret("alice", 0, "s", "game-X");
    const pool = createPool("alice", [s]);
    const challenge: ChallengeEvent = {
      challenger: "bob",
      targetAuthor: "alice",
      seed: "wrong-seed",
      seqId: 0,
      fingerprint: s.fingerprint,
    };
    throws(() => verifyChallenge(pool, challenge));
  });

  it("rejects a challenge against a depleted pool", () => {
    const g = createGenesisState("roll", 0, 20);
    const pool = createPool("alice", [createClosedSecret("alice", 0, "s", "")]);
    const roll = deriveRoll(g.hash, "s", 20);
    const { updatedPool } = processReveal(pool, {
      seed: "",
      seqId: 0,
      secret: "s",
      newFingerprint: createClosedSecret("alice", 1, "r", "").fingerprint,
      stateHash: g.hash,
      claimedRoll: roll,
    }, [g]);
    const challenge: ChallengeEvent = {
      challenger: "bob",
      targetAuthor: "alice",
      seed: "",
      seqId: 0,
      fingerprint: pool.commitments[0]!.fingerprint,
    };
    throws(() => verifyChallenge(updatedPool, challenge));
  });
});

describe("Security properties", () => {
  it("different authors produce different fingerprints for the same secret", () => {
    const a = createClosedSecret("alice", 0, "same", "");
    const b = createClosedSecret("bob", 0, "same", "");
    ok(a.fingerprint !== b.fingerprint);
  });

  it("different seeds produce different fingerprints for identical inputs", () => {
    const a = createClosedSecret("alice", 0, "secret", "game-A");
    const b = createClosedSecret("alice", 0, "secret", "game-B");
    ok(a.fingerprint !== b.fingerprint);
  });

  it("same reveal with different state hash produces different roll", () => {
    const r1 = deriveRoll("state-a", "secret", 100);
    const r2 = deriveRoll("state-b", "secret", 100);
    ok(r1 !== r2);
  });

  it("a tampered game state in a chain is detected", () => {
    const g1 = createGenesisState("start", 0);
    const g2 = createNextState(g1, "move-1", 1);
    const g3 = createNextState(g2, "move-2", 2);
    const tampered: typeof g2 = { ...g2, data: "CHEAT" };
    throws(() => verifyChain([g1, tampered, g3]));
  });

  it("a reveal with correct secret passes verification", () => {
    const closed = createClosedSecret("alice", 0, "secret", "");
    const g = createGenesisState("roll", 0, 6);
    const reveal: Reveal = {
      seed: "",
      seqId: 0,
      secret: "secret",
      newFingerprint: "a".repeat(64),
      stateHash: g.hash,
      claimedRoll: deriveRoll(g.hash, "secret", 6),
    };
    doesNotThrow(() => verifyReveal("alice", closed.fingerprint, reveal, [g]));
  });

  it("rejects a reveal where claimed roll was derived from a different state hash", () => {
    const closed = createClosedSecret("bob", 0, "s", "");
    const gA = createGenesisState("state-a", 0, 20);
    const gB = createGenesisState("state-b", 1, 20);
    const rollA = deriveRoll(gA.hash, "s", 20);
    const rollB = deriveRoll(gB.hash, "s", 20);
    const revealA: Reveal = {
      seed: "", seqId: 0, secret: "s",
      newFingerprint: "a".repeat(64),
      stateHash: gA.hash, claimedRoll: rollA,
    };
    const revealB: Reveal = {
      seed: "", seqId: 0, secret: "s",
      newFingerprint: "a".repeat(64),
      stateHash: gA.hash, claimedRoll: rollB,
    };
    doesNotThrow(() => verifyReveal("bob", closed.fingerprint, revealA, [gA]));
    throws(() => verifyReveal("bob", closed.fingerprint, revealB, [gA]));
  });

  it("roll distribution is uniform (no modulo bias on small sides)", () => {
    const counts: number[] = new Array(6).fill(0);
    const trials = 1000;
    for (let i = 0; i < trials; i++) {
      const r = deriveRoll(`state-${i}`, `secret-${i}`, 6);
      counts[r - 1]!++;
    }
    const expected = trials / 6;
    for (let i = 0; i < 6; i++) {
      const deviation = Math.abs(counts[i]! - expected);
      ok(deviation < expected * 0.5, `Face ${i + 1}: count ${counts[i]} deviates too much`);
    }
  });

  it("rejection sampling never produces val outside [0, maxAcceptable)", () => {
    const r = deriveRoll("abc", "def", 20);
    ok(r >= 1 && r <= 20);
  });

  it("rejects sides that are not finite integers >= 2", () => {
    throws(() => deriveRoll("any", "thing", NaN));
    throws(() => deriveRoll("any", "thing", Infinity));
    throws(() => deriveRoll("any", "thing", 3.14));
    throws(() => deriveRoll("any", "thing", 1));
    throws(() => deriveRoll("any", "thing", 0));
    throws(() => deriveRoll("any", "thing", -1));
    throws(() => deriveRoll("any", "thing", 2 ** 48 + 1));
  });

  it("multi-source deriveRoll with challenger secret produces different roll", () => {
    const r1 = deriveRoll("abc", "secret", 100);
    const r2 = deriveRoll("abc", "secret", 100, "challenger-secret");
    ok(r1 !== r2);
  });

  it("deriveRoll with same challenger secret is deterministic", () => {
    const r1 = deriveRoll("abc", "s", 20, "c");
    const r2 = deriveRoll("abc", "s", 20, "c");
    equal(r1, r2);
  });

  it("processReveal binds roll to previous state hash (not current)", () => {
    const g1 = createGenesisState("prev", 0, 6);
    const g2 = createNextState(g1, "current", 1, 6);
    const closed = createClosedSecret("alice", 0, "s", "");
    const pool = createPool("alice", [closed]);
    const roll = deriveRoll(g1.hash, "s", 6);
    const result = processReveal(pool, {
      seed: "", seqId: 0, secret: "s",
      newFingerprint: createClosedSecret("alice", 1, "r", "").fingerprint,
      stateHash: g2.hash, claimedRoll: roll,
    }, [g1, g2]);
    ok(result.roll >= 1 && result.roll <= 6);
    equal(result.updatedPool.consumedCount, 1);
  });

  it("processReveal with valid challenger commitment verifies both secrets", () => {
    const g1 = createGenesisState("roll", 0, 20);
    const closed = createClosedSecret("alice", 0, "roller-secret", "");
    const challengerCommitment = createClosedSecret("bob", 0, "challenger-secret", "");
    const pool = createPool("alice", [closed]);
    const roll = deriveRoll(g1.hash, "roller-secret", 20, "challenger-secret");
    const result = processReveal(pool, {
      seed: "", seqId: 0, secret: "roller-secret",
      newFingerprint: createClosedSecret("alice", 1, "r", "").fingerprint,
      stateHash: g1.hash, claimedRoll: roll,
      challengerSecret: "challenger-secret",
    }, [g1], {
      seed: "", author: "bob", seqId: 0, fingerprint: challengerCommitment.fingerprint,
    });
    ok(result.roll >= 1 && result.roll <= 20);
  });

  it("processReveal rejects mismatched challenger secret", () => {
    const g1 = createGenesisState("roll", 0, 20);
    const closed = createClosedSecret("alice", 0, "roller", "");
    const pool = createPool("alice", [closed]);
    const challengerCommitment = createClosedSecret("bob", 0, "real", "");
    throws(() => processReveal(pool, {
      seed: "", seqId: 0, secret: "roller",
      newFingerprint: "a".repeat(64),
      stateHash: g1.hash, claimedRoll: 10,
      challengerSecret: "fake",
    }, [g1], {
      seed: "", author: "bob", seqId: 0, fingerprint: challengerCommitment.fingerprint,
    }));
  });

  it("processReveal rejects challenger secret without commitment", () => {
    const g1 = createGenesisState("roll", 0, 20);
    const closed = createClosedSecret("alice", 0, "roller", "");
    const pool = createPool("alice", [closed]);
    throws(() => processReveal(pool, {
      seed: "", seqId: 0, secret: "roller",
      newFingerprint: "a".repeat(64),
      stateHash: g1.hash, claimedRoll: 10,
      challengerSecret: "anything",
    }, [g1]));
  });
});

describe("verifyGame", () => {
  it("passes a valid game with one reveal", () => {
    const g1 = createGenesisState("start", 0);
    const g2 = createNextState(g1, "roll happened", 1, 20);
    const closed = createClosedSecret("alice", 0, "s0", "");
    const roll = deriveRoll(g2.prevHash ?? g2.hash, "s0", 20);
    const reveals: Reveal[] = [{
      seed: "",
      seqId: 0,
      secret: "s0",
      newFingerprint: createClosedSecret("alice", 1, "r0", "").fingerprint,
      stateHash: g2.hash,
      claimedRoll: roll,
    }];
    const opened = [createOpenSecret(closed, "s0")];
    const result = verifyGame(
      [g1, g2],
      { alice: [closed] },
      { alice: reveals },
      { alice: opened },
    );
    ok(result.valid);
    equal(result.errors.length, 0);
  });

  it("passes an empty game (no reveals)", () => {
    const g1 = createGenesisState("start", 0);
    const result = verifyGame([g1], {}, {}, {});
    ok(result.valid);
    equal(result.errors.length, 0);
  });

  it("fails on broken chain", () => {
    const g1 = createGenesisState("start", 0);
    const g2 = createGenesisState("rogue", 1);
    const result = verifyGame([g1, g2], {}, {}, {});
    equal(result.valid, false);
    ok(result.errors.some((e: string) => e.includes("Chain")));
  });

  it("fails when reveal references unknown state hash", () => {
    const g1 = createGenesisState("start", 0);
    const g2 = createNextState(g1, "move", 1, 20);
    const closed = createClosedSecret("alice", 0, "s0", "");
    const roll = deriveRoll("unknown-hash", "s0", 20);
    const reveals: Reveal[] = [{
      seed: "",
      seqId: 0,
      secret: "s0",
      newFingerprint: createClosedSecret("alice", 1, "r0", "").fingerprint,
      stateHash: "unknown-hash",
      claimedRoll: roll,
    }];
    const result = verifyGame(
      [g1, g2],
      { alice: [closed] },
      { alice: reveals },
      {},
    );
    equal(result.valid, false);
    ok(result.errors.some((e: string) => e.includes("unknown state")));
  });

  it("fails on pool fingerprint mismatch", () => {
    const g1 = createGenesisState("start", 0);
    const g2 = createNextState(g1, "roll", 1, 20);
    const closed = createClosedSecret("alice", 0, "s0", "");
    const roll = deriveRoll(g2.prevHash ?? g2.hash, "s0", 20);
    const reveals: Reveal[] = [{
      seed: "",
      seqId: 0,
      secret: "s0",
      newFingerprint: createClosedSecret("alice", 1, "r0", "").fingerprint,
      stateHash: g2.hash,
      claimedRoll: roll,
    }];
    const opened = [{
      seed: "",
      author: "alice",
      seqId: 0,
      fingerprint: closed.fingerprint,
      secret: "wrong-secret",
    }];
    const result = verifyGame(
      [g1, g2],
      { alice: [closed] },
      { alice: reveals },
      { alice: opened },
    );
    equal(result.valid, false);
    ok(result.errors.some((e: string) => e.includes("fingerprint")));
  });

  it("fails when a reveal uses wrong secret", () => {
    const g1 = createGenesisState("start", 0);
    const g2 = createNextState(g1, "move", 1, 20);
    const closed = createClosedSecret("alice", 0, "s0", "");
    const roll = deriveRoll(g2.prevHash ?? g2.hash, "wrong", 20);
    const reveals: Reveal[] = [{
      seed: "",
      seqId: 0,
      secret: "wrong",
      newFingerprint: createClosedSecret("alice", 1, "r0", "").fingerprint,
      stateHash: g2.hash,
      claimedRoll: roll,
    }];
    const result = verifyGame(
      [g1, g2],
      { alice: [closed] },
      { alice: reveals },
      {},
    );
    equal(result.valid, false);
    ok(result.errors.some((e: string) => e.includes("reconstruction")));
  });

  it("fails when opened secrets are missing for consumed reveals", () => {
    const g1 = createGenesisState("start", 0);
    const g2 = createNextState(g1, "roll", 1, 6);
    const closed = createClosedSecret("alice", 0, "s", "");
    const roll = deriveRoll(g2.prevHash ?? g2.hash, "s", 6);
    const reveals: Reveal[] = [{
      seed: "",
      seqId: 0,
      secret: "s",
      newFingerprint: createClosedSecret("alice", 1, "r", "").fingerprint,
      stateHash: g2.hash,
      claimedRoll: roll,
    }];
    const result = verifyGame([g1, g2], { alice: [closed] }, { alice: reveals }, {});
    equal(result.valid, false);
    ok(result.errors.some((e: string) => e.includes("have 0, need 1")));
  });

  it("fails when too many opened secrets are provided", () => {
    const g1 = createGenesisState("start", 0);
    const g2 = createNextState(g1, "roll", 1, 6);
    const closed = createClosedSecret("alice", 0, "s", "");
    const roll = deriveRoll(g2.prevHash ?? g2.hash, "s", 6);
    const reveals: Reveal[] = [{
      seed: "",
      seqId: 0,
      secret: "s",
      newFingerprint: createClosedSecret("alice", 1, "r", "").fingerprint,
      stateHash: g2.hash,
      claimedRoll: roll,
    }];
    const opened = [createOpenSecret(closed, "s"), createOpenSecret(closed, "s")];
    const result = verifyGame([g1, g2], { alice: [closed] }, { alice: reveals }, { alice: opened });
    equal(result.valid, false);
    ok(result.errors.some((e: string) => e.includes("have 2, need 1")));
  });

  it("fails when expectedSides does not match reveal", () => {
    const g1 = createGenesisState("start", 0);
    const g2 = createNextState(g1, "roll", 1, 6);
    const closed = createClosedSecret("alice", 0, "s", "");
    const roll = deriveRoll(g2.prevHash ?? g2.hash, "s", 6);
    const reveals: Reveal[] = [{
      seed: "",
      seqId: 0,
      secret: "s",
      newFingerprint: "a".repeat(64),
      stateHash: g2.hash,
      claimedRoll: roll,
    }];
    const result = verifyGame([g1, g2], { alice: [closed] }, { alice: reveals }, {}, 20);
    equal(result.valid, false);
    ok(result.errors.some((e: string) => e.includes("sides")));
  });

  it("fails when reveals reference an author without initial commitments", () => {
    const g1 = createGenesisState("start", 0);
    const g2 = createNextState(g1, "roll", 1, 6);
    const reveals: Reveal[] = [{
      seed: "",
      seqId: 0,
      secret: "s",
      newFingerprint: "a".repeat(64),
      stateHash: g2.hash,
      claimedRoll: 1,
    }];
    const result = verifyGame([g1, g2], { alice: [] }, { bob: reveals }, {});
    equal(result.valid, false);
    ok(result.errors.some((e: string) => e.includes("no initial commitments")));
  });

  it("fails when state referenced by reveal has no sides", () => {
    const g1 = createGenesisState("start", 0);
    const g2 = createNextState(g1, "roll", 1);
    const closed = createClosedSecret("alice", 0, "s", "");
    const roll = deriveRoll(g2.prevHash ?? g2.hash, "s", 6);
    const reveals: Reveal[] = [{
      seed: "",
      seqId: 0,
      secret: "s",
      newFingerprint: "a".repeat(64),
      stateHash: g2.hash,
      claimedRoll: roll,
    }];
    const result = verifyGame([g1, g2], { alice: [closed] }, { alice: reveals }, {}, 20);
    equal(result.valid, false);
    ok(result.errors.some((e: string) => e.includes("does not define sides")));
  });

  it("fails when state referenced by reveal has invalid sides", () => {
    const g1 = createGenesisState("start", 0);
    const g2 = createNextState(g1, "roll", 1, 1);
    const closed = createClosedSecret("alice", 0, "s", "");
    const reveals: Reveal[] = [{
      seed: "",
      seqId: 0,
      secret: "s",
      newFingerprint: "a".repeat(64),
      stateHash: g2.hash,
      claimedRoll: 1,
    }];
    const result = verifyGame([g1, g2], { alice: [closed] }, { alice: reveals }, {}, 20);
    equal(result.valid, false);
    ok(result.errors.some((e: string) => e.includes("must be a finite integer >= 2")));
  });

  it("fails when opened secrets reference an author without initial commitments", () => {
    const g1 = createGenesisState("start", 0);
    const result = verifyGame([g1], {}, {}, { bob: [{ seed: "", author: "bob", seqId: 0, fingerprint: "a".repeat(64), secret: "x" }] });
    equal(result.valid, false);
    ok(result.errors.some((e: string) => e.includes("no initial commitments")));
  });

  it("passes a multi-source game via challengerCommitments parameter", () => {
    const g1 = createGenesisState("roll", 0, 20);
    const roller = createClosedSecret("alice", 0, "roller-secret", "");
    const challenger = createClosedSecret("bob", 0, "chal-secret", "");
    const roll = deriveRoll(g1.hash, "roller-secret", 20, "chal-secret");
    const reveals: Reveal[] = [{
      seed: "", seqId: 0, secret: "roller-secret",
      newFingerprint: createClosedSecret("alice", 1, "r", "").fingerprint,
      stateHash: g1.hash, claimedRoll: roll,
      challengerSecret: "chal-secret",
    }];
    const result = verifyGame([g1], { alice: [roller] }, { alice: reveals }, {
      alice: [createOpenSecret(roller, "roller-secret")],
    }, undefined, {
      alice: [{ seed: "", author: "bob", seqId: 0, fingerprint: challenger.fingerprint }],
    });
    ok(result.valid);
    equal(result.errors.length, 0);
  });

  it("fails multi-source game when challenger commitment is wrong", () => {
    const g1 = createGenesisState("roll", 0, 20);
    const roller = createClosedSecret("alice", 0, "roller-secret", "");
    const roll = deriveRoll(g1.hash, "roller-secret", 20, "chal-secret");
    const reveals: Reveal[] = [{
      seed: "", seqId: 0, secret: "roller-secret",
      newFingerprint: createClosedSecret("alice", 1, "r", "").fingerprint,
      stateHash: g1.hash, claimedRoll: roll,
      challengerSecret: "chal-secret",
    }];
    const result = verifyGame([g1], { alice: [roller] }, { alice: reveals }, {
      alice: [createOpenSecret(roller, "roller-secret")],
    }, undefined, {
      alice: [{ seed: "", author: "bob", seqId: 0, fingerprint: "x".repeat(64) }],
    });
    equal(result.valid, false);
    ok(result.errors.some((e: string) => e.includes("Challenger secret")));
  });

  it("fails multi-source game without challengerCommitments when reveal has challengerSecret", () => {
    const g1 = createGenesisState("roll", 0, 20);
    const roller = createClosedSecret("alice", 0, "roller-secret", "");
    const roll = deriveRoll(g1.hash, "roller-secret", 20, "chal-secret");
    const reveals: Reveal[] = [{
      seed: "", seqId: 0, secret: "roller-secret",
      newFingerprint: createClosedSecret("alice", 1, "r", "").fingerprint,
      stateHash: g1.hash, claimedRoll: roll,
      challengerSecret: "chal-secret",
    }];
    const result = verifyGame([g1], { alice: [roller] }, { alice: reveals }, {
      alice: [createOpenSecret(roller, "roller-secret")],
    });
    equal(result.valid, false);
    ok(result.errors.some((e: string) => e.includes("no challenger commitment")));
  });
});
