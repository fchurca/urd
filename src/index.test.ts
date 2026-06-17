import { describe, it } from "node:test";
import { equal, ok, throws } from "node:assert/strict";
import type { GameState, ChallengeEvent, Reveal } from "./index.ts";
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
  reconstructPool,
  verifyPoolFingerprints,
  verifyChallenge,
  findStateInChain,
  verifyGame,
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

  it("rejects a chain with a non-genesis state missing prevHash", () => {
    const g1 = createGenesisState("a", 0);
    const g2: GameState = { ...createNextState(g1, "b", 1), prevHash: null };
    equal(verifyChain([g1, g2]), false);
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

  it("throws when opening a closed secret with the wrong secret", () => {
    const closed = createClosedSecret("alice", 0, "my-secret");
    throws(() => openSecret(closed, "wrong-secret"));
  });

  it("rejects an open secret with wrong secret via verifyOpenSecret", () => {
    const opened = {
      author: "alice",
      seqId: 0,
      fingerprint: createClosedSecret("alice", 0, "real").fingerprint,
      secret: "fake",
    };
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

  it("throws when sides is zero or negative", () => {
    throws(() => deriveRoll("x", "y", 0));
    throws(() => deriveRoll("x", "y", -1));
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

  it("rejects a pool with duplicate seqIds", () => {
    throws(() => createPool("alice", [
      createClosedSecret("alice", 0, "a"),
      createClosedSecret("alice", 0, "b"),
    ]));
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

describe("Pool reconstruction", () => {
  it("reconstructs pool from initial commitments and reveals", () => {
    const commitments = [
      createClosedSecret("alice", 0, "s0"),
      createClosedSecret("alice", 1, "s1"),
    ];
    const reveals: Reveal[] = [
      {
        seqId: 0,
        secret: "s0",
        newFingerprint: createClosedSecret("alice", 2, "r0").fingerprint,
        stateHash: "s",
        sides: 20,
      },
      {
        seqId: 1,
        secret: "s1",
        newFingerprint: createClosedSecret("alice", 3, "r1").fingerprint,
        stateHash: "s",
        sides: 20,
      },
    ];
    const pool = reconstructPool("alice", commitments, reveals);
    equal(pool.consumedUpTo, 2);
    equal(pool.commitments.length, 4);
  });

  it("reconstruction yields the same pool as sequential reveals", () => {
    const commitments = [createClosedSecret("alice", 0, "x")];
    const reveals: Reveal[] = [
      {
        seqId: 0,
        secret: "x",
        newFingerprint: createClosedSecret("alice", 1, "y").fingerprint,
        stateHash: "s",
        sides: 6,
      },
    ];
    const pool = reconstructPool("alice", commitments, reveals);
    equal(pool.consumedUpTo, 1);
    equal(nextChallenge(pool)!.seqId, 1);
  });

  it("reconstruction replays reveals in order", () => {
    throws(() => {
      reconstructPool("alice", [createClosedSecret("alice", 0, "s")], [
        {
          seqId: 0,
          secret: "wrong",
          newFingerprint: "x".repeat(64),
          stateHash: "s",
          sides: 6,
        } as Reveal,
      ]);
    });
  });
});

describe("Pool fingerprint verification", () => {
  it("verifies opened secrets against pool commitments", () => {
    const s0 = createClosedSecret("alice", 0, "s0");
    const s1 = createClosedSecret("alice", 1, "s1");
    const pool = createPool("alice", [s0, s1]);
    const opened = [openSecret(s0, "s0"), openSecret(s1, "s1")];
    ok(verifyPoolFingerprints(pool, opened));
  });

  it("rejects when an opened secret is missing from the pool", () => {
    const s0 = createClosedSecret("alice", 0, "s0");
    const pool = createPool("alice", [s0]);
    const unknown = { author: "alice", seqId: 99, fingerprint: "x".repeat(64), secret: "y" };
    equal(verifyPoolFingerprints(pool, [unknown]), false);
  });

  it("rejects when an opened secret has a wrong secret", () => {
    const s0 = createClosedSecret("alice", 0, "s0");
    const pool = createPool("alice", [s0]);
    const opened = { author: "alice", seqId: 0, fingerprint: s0.fingerprint, secret: "wrong" };
    equal(verifyPoolFingerprints(pool, [opened]), false);
  });
});

describe("Challenge verification", () => {
  it("verifies a challenge matches the next expected one", () => {
    const pool = createPool("alice", [createClosedSecret("alice", 0, "s0")]);
    const challenge: ChallengeEvent = {
      challenger: "bob",
      targetAuthor: "alice",
      seqId: 0,
      fingerprint: pool.commitments[0]!.fingerprint,
    };
    ok(verifyChallenge(pool, challenge));
  });

  it("rejects a challenge with wrong fingerprint", () => {
    const pool = createPool("alice", [createClosedSecret("alice", 0, "s0")]);
    const challenge: ChallengeEvent = {
      challenger: "bob",
      targetAuthor: "alice",
      seqId: 0,
      fingerprint: "x".repeat(64),
    };
    equal(verifyChallenge(pool, challenge), false);
  });

  it("rejects a challenge against a depleted pool", () => {
    const pool = createPool("alice", [createClosedSecret("alice", 0, "s")]);
    const { updatedPool } = revealSecret(pool, {
      seqId: 0,
      secret: "s",
      newFingerprint: createClosedSecret("alice", 1, "r").fingerprint,
      stateHash: "s",
      sides: 20,
    });
    const challenge: ChallengeEvent = {
      challenger: "bob",
      targetAuthor: "alice",
      seqId: 0,
      fingerprint: pool.commitments[0]!.fingerprint,
    };
    equal(verifyChallenge(updatedPool, challenge), false);
  });
});

describe("Security properties", () => {
  it("different authors produce different fingerprints for the same secret", () => {
    const a = createClosedSecret("alice", 0, "same");
    const b = createClosedSecret("bob", 0, "same");
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
    equal(verifyChain([g1, tampered, g3]), false);
  });

  it("a reveal with correct secret passes verification", () => {
    const closed = createClosedSecret("alice", 0, "secret");
    ok(verifyReveal("alice", closed.fingerprint, 0, "secret", "hash", 6, deriveRoll("hash", "secret", 6)));
  });

  it("replay of same reveal on different state yields different roll and fails original verification", () => {
    const closed = createClosedSecret("bob", 0, "s");
    const rollA = deriveRoll("state-a", "s", 20);
    const rollB = deriveRoll("state-b", "s", 20);
    equal(verifyReveal("bob", closed.fingerprint, 0, "s", "state-a", 20, rollA), true);
    equal(verifyReveal("bob", closed.fingerprint, 0, "s", "state-a", 20, rollB), false);
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

  it("rejection sampling works for sides=1 (trivial range)", () => {
    equal(deriveRoll("any", "thing", 1), 1);
  });
});

describe("verifyGame", () => {
  it("passes a valid game with one reveal", () => {
    const g1 = createGenesisState("start", 0);
    const g2 = createNextState(g1, "roll happened", 1);
    const closed = createClosedSecret("alice", 0, "s0");
    const reveals: Reveal[] = [{
      seqId: 0,
      secret: "s0",
      newFingerprint: createClosedSecret("alice", 1, "r0").fingerprint,
      stateHash: g2.hash,
      sides: 20,
    }];
    const opened = [openSecret(closed, "s0")];
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
    ok(result.errors.some((e: string) => e.includes("chain")));
  });

  it("fails when reveal references unknown state hash", () => {
    const g1 = createGenesisState("start", 0);
    const g2 = createNextState(g1, "move", 1);
    const closed = createClosedSecret("alice", 0, "s0");
    const reveals: Reveal[] = [{
      seqId: 0,
      secret: "s0",
      newFingerprint: createClosedSecret("alice", 1, "r0").fingerprint,
      stateHash: "unknown-hash",
      sides: 20,
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
    const closed = createClosedSecret("alice", 0, "s0");
    const opened = [{
      author: "alice",
      seqId: 0,
      fingerprint: closed.fingerprint,
      secret: "wrong-secret",
    }];
    const result = verifyGame(
      [g1],
      { alice: [closed] },
      {},
      { alice: opened },
    );
    equal(result.valid, false);
    ok(result.errors.some((e: string) => e.includes("fingerprint")));
  });

  it("fails when a reveal uses wrong secret", () => {
    const g1 = createGenesisState("start", 0);
    const g2 = createNextState(g1, "move", 1);
    const closed = createClosedSecret("alice", 0, "s0");
    const reveals: Reveal[] = [{
      seqId: 0,
      secret: "wrong",
      newFingerprint: createClosedSecret("alice", 1, "r0").fingerprint,
      stateHash: g2.hash,
      sides: 20,
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
});
