import { describe, it } from "node:test";
import { doesNotThrow, equal, ok, throws } from "node:assert/strict";
import type { GameState, SecretReveal, RollDeclaration, RollResolution } from "./index.ts";
import {
  createGenesisState,
  createNextState,
  verifyChain,
  createClosedSecret,
  createOpenSecret,
  verifyOpenSecret,
  deriveRoll,
  createPool,
  addToPool,
  verifySecretReveal,
  verifyRollDeclaration,
  verifyRollResolution,
  resolveRoll,
  findStateInChain,
  verifyGame,
  lookupSides,
  consumeSecrets,
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

  it("rejects genesis state with NaN timestamp", () => {
    throws(() => createGenesisState("x", NaN));
    throws(() => createGenesisState("x", Infinity));
    throws(() => createGenesisState("x", -Infinity));
  });

  it("rejects next state with NaN timestamp", () => {
    const g = createGenesisState("g", 0);
    throws(() => createNextState(g, "x", NaN));
    throws(() => createNextState(g, "x", Infinity));
    throws(() => createNextState(g, "x", -Infinity));
  });

  it("rejects a chain where a state has invalid timestamp", () => {
    const g1 = createGenesisState("a", 0);
    const g2: GameState = { ...createNextState(g1, "b", 1), timestamp: NaN };
    throws(() => verifyChain([g1, g2]));
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

describe("Pool management", () => {
  it("creates a pool and sorts commitments by seqId", () => {
    const pool = createPool("alice", [
      createClosedSecret("alice", 3, "z", ""),
      createClosedSecret("alice", 0, "a", ""),
      createClosedSecret("alice", 1, "m", ""),
    ]);
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

  it("addToPool appends a commitment with validation", () => {
    const s0 = createClosedSecret("alice", 0, "s0", "g");
    const s1 = createClosedSecret("alice", 1, "s1", "g");
    const pool = createPool("alice", [s0]);
    const updated = addToPool(pool, s1);
    equal(updated.commitments.length, 2);
    equal(updated.commitments[1]!.seqId, 1);
  });

  it("addToPool rejects duplicate seqId", () => {
    const s0 = createClosedSecret("alice", 0, "s0", "g");
    const dup = createClosedSecret("alice", 0, "different", "g");
    const pool = createPool("alice", [s0]);
    throws(() => addToPool(pool, dup));
  });

  it("addToPool rejects mismatched author", () => {
    const s0 = createClosedSecret("alice", 0, "s0", "g");
    const bad = createClosedSecret("bob", 1, "x", "g");
    const pool = createPool("alice", [s0]);
    throws(() => addToPool(pool, bad));
  });

  it("addToPool rejects mismatched seed", () => {
    const s0 = createClosedSecret("alice", 0, "s0", "game-a");
    const bad = createClosedSecret("alice", 1, "x", "game-b");
    const pool = createPool("alice", [s0]);
    throws(() => addToPool(pool, bad));
  });
});

describe("consumeSecrets", () => {
  it("moves one commitment from commitments to consumed", () => {
    const s0 = createClosedSecret("alice", 0, "s0", "g");
    const pool = createPool("alice", [s0]);
    const reveal: SecretReveal = {
      seed: "g", author: "alice", seqId: 0, secret: "s0",
      fingerprint: s0.fingerprint,
    };
    const updated = consumeSecrets(pool, "gameHash", [reveal]);
    equal(updated.commitments.length, 0);
    equal(updated.consumed.length, 1);
    equal(updated.consumed[0]!.secret, "s0");
    equal(updated.consumed[0]!.rollId, "gameHash");
  });

  it("preserves existing consumed entries and appends", () => {
    const s0 = createClosedSecret("alice", 0, "s0", "g");
    const s1 = createClosedSecret("alice", 1, "s1", "g");
    const pool = createPool("alice", [s0, s1]);
    const reveal0: SecretReveal = {
      seed: "g", author: "alice", seqId: 0, secret: "s0",
      fingerprint: s0.fingerprint,
    };
    const afterFirst = consumeSecrets(pool, "roll-a", [reveal0]);
    equal(afterFirst.commitments.length, 1);
    equal(afterFirst.consumed.length, 1);
    const reveal1: SecretReveal = {
      seed: "g", author: "alice", seqId: 1, secret: "s1",
      fingerprint: s1.fingerprint,
    };
    const afterSecond = consumeSecrets(afterFirst, "roll-b", [reveal1]);
    equal(afterSecond.commitments.length, 0);
    equal(afterSecond.consumed.length, 2);
    equal(afterSecond.consumed[0]!.rollId, "roll-a");
    equal(afterSecond.consumed[1]!.rollId, "roll-b");
  });

  it("consumes multiple reveals from the same author at once", () => {
    const s0 = createClosedSecret("alice", 0, "s0", "g");
    const s1 = createClosedSecret("alice", 1, "s1", "g");
    const pool = createPool("alice", [s0, s1]);
    const reveal0: SecretReveal = {
      seed: "g", author: "alice", seqId: 0, secret: "s0",
      fingerprint: s0.fingerprint,
    };
    const reveal1: SecretReveal = {
      seed: "g", author: "alice", seqId: 1, secret: "s1",
      fingerprint: s1.fingerprint,
    };
    const updated = consumeSecrets(pool, "roll-x", [reveal0, reveal1]);
    equal(updated.commitments.length, 0);
    equal(updated.consumed.length, 2);
  });

  it("rejects reveal whose fingerprint does not match commitments[0]", () => {
    const s0 = createClosedSecret("alice", 0, "real", "g");
    const pool = createPool("alice", [s0]);
    const fakeReveal: SecretReveal = {
      seed: "g", author: "alice", seqId: 0, secret: "fake",
      fingerprint: "0".repeat(64),
    };
    throws(() => consumeSecrets(pool, "r", [fakeReveal]));
  });

  it("rejects reveal whose author does not match pool author", () => {
    const s0 = createClosedSecret("alice", 0, "s", "g");
    const pool = createPool("alice", [s0]);
    const reveal: SecretReveal = {
      seed: "g", author: "bob", seqId: 0, secret: "s",
      fingerprint: s0.fingerprint,
    };
    throws(() => consumeSecrets(pool, "r", [reveal]));
  });

  it("does not mutate the input pool", () => {
    const s0 = createClosedSecret("alice", 0, "s", "g");
    const pool = createPool("alice", [s0]);
    const reveal: SecretReveal = {
      seed: "g", author: "alice", seqId: 0, secret: "s",
      fingerprint: s0.fingerprint,
    };
    consumeSecrets(pool, "r", [reveal]);
    equal(pool.commitments.length, 1);
    equal(pool.consumed.length, 0);
  });
});

describe("Roll derivation", () => {
  it("derives a deterministic roll from game hash and one secret", () => {
    const g = createGenesisState("roll", 0, 20);
    const r1 = deriveRoll(g.hash, ["secret1"], 20);
    const r2 = deriveRoll(g.hash, ["secret1"], 20);
    equal(r1, r2);
  });

  it("produces a value in [1, sides]", () => {
    const g = createGenesisState("roll", 0, 20);
    for (let i = 0; i < 50; i++) {
      const r = deriveRoll(g.hash, [`secret${i}`], 20);
      ok(r >= 1 && r <= 20, `roll ${r} out of range`);
    }
  });

  it("changes result when game hash changes", () => {
    const g1 = createGenesisState("roll-a", 0, 100);
    const g2 = createGenesisState("roll-b", 0, 100);
    const r1 = deriveRoll(g1.hash, ["x"], 100);
    const r2 = deriveRoll(g2.hash, ["x"], 100);
    ok(r1 !== r2);
  });

  it("changes result when secrets differ", () => {
    const g = createGenesisState("roll", 0, 100);
    ok(deriveRoll(g.hash, ["secret-a"], 100) !== deriveRoll(g.hash, ["secret-b"], 100));
  });

  it("two secrets produce a different roll than one", () => {
    const g = createGenesisState("roll", 0, 100);
    const single = deriveRoll(g.hash, ["s1"], 100);
    const multi = deriveRoll(g.hash, ["s1", "s2"], 100);
    ok(single !== multi);
  });

  it("order of secrets matters", () => {
    const g = createGenesisState("roll", 0, 100);
    const a = deriveRoll(g.hash, ["s1", "s2"], 100);
    const b = deriveRoll(g.hash, ["s2", "s1"], 100);
    ok(a !== b);
  });

  it("throws when sides is zero or negative", () => {
    const g = createGenesisState("roll", 0, 20);
    throws(() => deriveRoll(g.hash, ["x"], 0));
    throws(() => deriveRoll(g.hash, ["x"], -1));
  });

  it("throws when no secrets provided", () => {
    const g = createGenesisState("roll", 0, 20);
    throws(() => deriveRoll(g.hash, [], 20));
  });

  it("rejects sides that are not finite integers >= 2", () => {
    throws(() => deriveRoll("a", ["x"], NaN));
    throws(() => deriveRoll("a", ["x"], Infinity));
    throws(() => deriveRoll("a", ["x"], 3.14));
    throws(() => deriveRoll("a", ["x"], 1));
    throws(() => deriveRoll("a", ["x"], 0));
    throws(() => deriveRoll("a", ["x"], -1));
    throws(() => deriveRoll("a", ["x"], 2 ** 48 + 1));
  });
});

describe("Secret reveal", () => {
  it("verifySecretReveal passes for correct secret", () => {
    const commit = createClosedSecret("alice", 0, "my-secret", "game-1");
    const reveal: SecretReveal = {
      seed: "game-1", author: "alice", seqId: 0, secret: "my-secret",
      fingerprint: commit.fingerprint,
    };
    doesNotThrow(() => verifySecretReveal("alice", commit.fingerprint, reveal));
  });

  it("verifySecretReveal rejects wrong secret", () => {
    const commit = createClosedSecret("alice", 0, "real", "g");
    const reveal: SecretReveal = {
      seed: "g", author: "alice", seqId: 0, secret: "fake",
      fingerprint: commit.fingerprint,
    };
    throws(() => verifySecretReveal("alice", commit.fingerprint, reveal));
  });

  it("verifySecretReveal rejects wrong author", () => {
    const commit = createClosedSecret("alice", 0, "secret", "g");
    const reveal: SecretReveal = {
      seed: "g", author: "alice", seqId: 0, secret: "secret",
      fingerprint: commit.fingerprint,
    };
    throws(() => verifySecretReveal("bob", commit.fingerprint, reveal));
  });
});

describe("Roll declaration", () => {
  it("passes for a valid declaration with existing fingerprint", () => {
    const g = createGenesisState("roll", 0, 20);
    const commit = createClosedSecret("alice", 0, "s", "g");
    const pool = createPool("alice", [commit]);
    const decl: RollDeclaration = {
      gameHash: g.hash,
      sides: 20,
      requests: [{ author: "alice", seqId: 0, fingerprint: commit.fingerprint }],
    };
    doesNotThrow(() => verifyRollDeclaration(decl, { alice: pool }));
  });

  it("rejects declaration with missing fingerprint in pool", () => {
    const g = createGenesisState("roll", 0, 20);
    const pool = createPool("alice", [createClosedSecret("alice", 0, "s", "g")]);
    const decl: RollDeclaration = {
      gameHash: g.hash,
      sides: 20,
      requests: [{ author: "alice", seqId: 0, fingerprint: "0".repeat(64) }],
    };
    throws(() => verifyRollDeclaration(decl, { alice: pool }));
  });

  it("rejects declaration with author that has no pool", () => {
    const g = createGenesisState("roll", 0, 20);
    const commit = createClosedSecret("bob", 0, "s", "g");
    const decl: RollDeclaration = {
      gameHash: g.hash,
      sides: 20,
      requests: [{ author: "bob", seqId: 0, fingerprint: commit.fingerprint }],
    };
    throws(() => verifyRollDeclaration(decl, {}));
  });

  it("rejects declaration with invalid sides", () => {
    const decl: RollDeclaration = {
      gameHash: "a".repeat(64),
      sides: 0,
      requests: [],
    };
    throws(() => verifyRollDeclaration(decl, {}));
  });

  it("rejects declaration with empty requests", () => {
    const g = createGenesisState("roll", 0, 20);
    const decl: RollDeclaration = {
      gameHash: g.hash,
      sides: 20,
      requests: [],
    };
    throws(() => verifyRollDeclaration(decl, {}));
  });

  it("rejects declaration with invalid gameHash", () => {
    const commit = createClosedSecret("alice", 0, "s", "g");
    const pool = createPool("alice", [commit]);
    const decl: RollDeclaration = {
      gameHash: "short",
      sides: 20,
      requests: [{ author: "alice", seqId: 0, fingerprint: commit.fingerprint }],
    };
    throws(() => verifyRollDeclaration(decl, { alice: pool }));
  });

  it("rejects declaration with seqId mismatch", () => {
    const g = createGenesisState("roll", 0, 20);
    const commit = createClosedSecret("alice", 42, "s", "g");
    const pool = createPool("alice", [commit]);
    const decl: RollDeclaration = {
      gameHash: g.hash,
      sides: 20,
      requests: [{ author: "alice", seqId: 99, fingerprint: commit.fingerprint }],
    };
    throws(() => verifyRollDeclaration(decl, { alice: pool }));
  });
});

describe("Roll resolution", () => {
  it("verifyRollResolution passes for valid resolution", () => {
    const g = createGenesisState("roll", 0, 20);
    const commit = createClosedSecret("alice", 0, "s", "g");
    const pool = createPool("alice", [commit]);
    const reveal: SecretReveal = {
      seed: "g", author: "alice", seqId: 0, secret: "s",
      fingerprint: commit.fingerprint,
    };
    const decl: RollDeclaration = {
      gameHash: g.hash, sides: 20,
      requests: [{ author: "alice", seqId: 0, fingerprint: commit.fingerprint }],
    };
    const resolution = resolveRoll(decl, [reveal]);
    doesNotThrow(() => verifyRollResolution(resolution, { alice: pool }));
  });

  it("verifyRollResolution rejects wrong roll", () => {
    const g = createGenesisState("roll", 0, 20);
    const commit = createClosedSecret("alice", 0, "s", "g");
    const pool = createPool("alice", [commit]);
    const reveal: SecretReveal = {
      seed: "g", author: "alice", seqId: 0, secret: "s",
      fingerprint: commit.fingerprint,
    };
    const decl: RollDeclaration = {
      gameHash: g.hash, sides: 20,
      requests: [{ author: "alice", seqId: 0, fingerprint: commit.fingerprint }],
    };
    const resolution = resolveRoll(decl, [reveal]);
    const badRes: RollResolution = { ...resolution, roll: resolution.roll + 1 };
    throws(() => verifyRollResolution(badRes, { alice: pool }));
  });

  it("verifyRollResolution rejects missing reveal", () => {
    const g = createGenesisState("roll", 0, 20);
    const commit = createClosedSecret("alice", 0, "s", "g");
    const pool = createPool("alice", [commit]);
    const decl: RollDeclaration = {
      gameHash: g.hash, sides: 20,
      requests: [{ author: "alice", seqId: 0, fingerprint: commit.fingerprint }],
    };
    const badRes: RollResolution = { declaration: decl, reveals: [], roll: 1 };
    throws(() => verifyRollResolution(badRes, { alice: pool }));
  });

  it("verifyRollResolution rejects wrong secret", () => {
    const g = createGenesisState("roll", 0, 20);
    const commit = createClosedSecret("alice", 0, "real", "g");
    const pool = createPool("alice", [commit]);
    const decl: RollDeclaration = {
      gameHash: g.hash, sides: 20,
      requests: [{ author: "alice", seqId: 0, fingerprint: commit.fingerprint }],
    };
    const reveal: SecretReveal = {
      seed: "g", author: "alice", seqId: 0, secret: "wrong",
      fingerprint: commit.fingerprint,
    };
    const resolution = resolveRoll(decl, [reveal]);
    throws(() => verifyRollResolution(resolution, { alice: pool }));
  });

  it("verifyRollResolution with multi-secret passes for two authors", () => {
    const g = createGenesisState("roll", 0, 6);
    const aCommit = createClosedSecret("alice", 0, "a-secret", "g");
    const bCommit = createClosedSecret("bob", 0, "b-secret", "g");
    const poolA = createPool("alice", [aCommit]);
    const poolB = createPool("bob", [bCommit]);
    const revealA: SecretReveal = {
      seed: "g", author: "alice", seqId: 0, secret: "a-secret",
      fingerprint: aCommit.fingerprint,
    };
    const revealB: SecretReveal = {
      seed: "g", author: "bob", seqId: 0, secret: "b-secret",
      fingerprint: bCommit.fingerprint,
    };
    const decl: RollDeclaration = {
      gameHash: g.hash, sides: 6,
      requests: [
        { author: "alice", seqId: 0, fingerprint: aCommit.fingerprint },
        { author: "bob", seqId: 0, fingerprint: bCommit.fingerprint },
      ],
    };
    const resolution = resolveRoll(decl, [revealA, revealB]);
    doesNotThrow(() => verifyRollResolution(resolution, { alice: poolA, bob: poolB }));
  });

  it("verifyRollResolution rejects when reveals are in wrong order", () => {
    const g = createGenesisState("roll", 0, 6);
    const aCommit = createClosedSecret("alice", 0, "a-secret", "g");
    const bCommit = createClosedSecret("bob", 0, "b-secret", "g");
    const poolA = createPool("alice", [aCommit]);
    const poolB = createPool("bob", [bCommit]);
    const revealA: SecretReveal = {
      seed: "g", author: "alice", seqId: 0, secret: "a-secret",
      fingerprint: aCommit.fingerprint,
    };
    const revealB: SecretReveal = {
      seed: "g", author: "bob", seqId: 0, secret: "b-secret",
      fingerprint: bCommit.fingerprint,
    };
    const decl: RollDeclaration = {
      gameHash: g.hash, sides: 6,
      requests: [
        { author: "alice", seqId: 0, fingerprint: aCommit.fingerprint },
        { author: "bob", seqId: 0, fingerprint: bCommit.fingerprint },
      ],
    };
    // Wrong order: bob first, alice second
    const resolution = resolveRoll(decl, [revealB, revealA]);
    throws(() => verifyRollResolution(resolution, { alice: poolA, bob: poolB }));
  });
});

describe("verifyGame", () => {
  it("passes a valid game with one resolution", () => {
    const g = createGenesisState("start", 0, 20);
    const commit = createClosedSecret("alice", 0, "s0", "g");
    const reveal: SecretReveal = {
      seed: "g", author: "alice", seqId: 0, secret: "s0",
      fingerprint: commit.fingerprint,
    };
    const decl: RollDeclaration = {
      gameHash: g.hash, sides: 20,
      requests: [{ author: "alice", seqId: 0, fingerprint: commit.fingerprint }],
    };
    const resolution = resolveRoll(decl, [reveal]);
    const result = verifyGame([g], { alice: [commit] }, [resolution]);
    ok(result.valid);
    equal(result.errors.length, 0);
  });

  it("passes a valid game with multiple resolutions (replenished pool)", () => {
    const g = createGenesisState("start", 0, 6);
    const s0 = createClosedSecret("alice", 0, "s0", "g");
    const s1 = createClosedSecret("alice", 1, "s1", "g");
    const pool = createPool("alice", [s0]);
    const updated = addToPool(pool, s1);
    const reveal0: SecretReveal = {
      seed: "g", author: "alice", seqId: 0, secret: "s0",
      fingerprint: s0.fingerprint,
    };
    const reveal1: SecretReveal = {
      seed: "g", author: "alice", seqId: 1, secret: "s1",
      fingerprint: s1.fingerprint,
    };
    const decl0: RollDeclaration = {
      gameHash: g.hash, sides: 6,
      requests: [{ author: "alice", seqId: 0, fingerprint: s0.fingerprint }],
    };
    const decl1: RollDeclaration = {
      gameHash: g.hash, sides: 6,
      requests: [{ author: "alice", seqId: 1, fingerprint: s1.fingerprint }],
    };
    const result = verifyGame(
      [g],
      { alice: [s0, s1] },
      [resolveRoll(decl0, [reveal0]), resolveRoll(decl1, [reveal1])],
    );
    ok(result.valid);
  });

  it("passes a valid game with multi-secret resolution", () => {
    const g = createGenesisState("start", 0, 6);
    const aCommit = createClosedSecret("alice", 0, "a-s", "g");
    const bCommit = createClosedSecret("bob", 0, "b-s", "g");
    const revealA: SecretReveal = {
      seed: "g", author: "alice", seqId: 0, secret: "a-s",
      fingerprint: aCommit.fingerprint,
    };
    const revealB: SecretReveal = {
      seed: "g", author: "bob", seqId: 0, secret: "b-s",
      fingerprint: bCommit.fingerprint,
    };
    const decl: RollDeclaration = {
      gameHash: g.hash, sides: 6,
      requests: [
        { author: "alice", seqId: 0, fingerprint: aCommit.fingerprint },
        { author: "bob", seqId: 0, fingerprint: bCommit.fingerprint },
      ],
    };
    const result = verifyGame(
      [g],
      { alice: [aCommit], bob: [bCommit] },
      [resolveRoll(decl, [revealA, revealB])],
    );
    ok(result.valid);
  });

  it("passes an empty game (no resolutions)", () => {
    const g1 = createGenesisState("start", 0);
    const result = verifyGame([g1], {}, []);
    ok(result.valid);
    equal(result.errors.length, 0);
  });

  it("passes with an author that has commitments but no resolutions", () => {
    const g1 = createGenesisState("start", 0);
    const closed = createClosedSecret("alice", 0, "s", "g");
    const result = verifyGame([g1], { alice: [closed] }, []);
    ok(result.valid);
    equal(result.errors.length, 0);
  });

  it("fails on broken chain", () => {
    const g1 = createGenesisState("start", 0);
    const g2 = createGenesisState("rogue", 1);
    const result = verifyGame([g1, g2], {}, []);
    equal(result.valid, false);
    ok(result.errors.some((e: string) => e.includes("Chain")));
  });

  it("fails when state referenced by resolution has sides mismatch", () => {
    const g1 = createGenesisState("roll", 0, 6);
    const commit = createClosedSecret("alice", 0, "s", "g");
    const reveal: SecretReveal = {
      seed: "g", author: "alice", seqId: 0, secret: "s",
      fingerprint: commit.fingerprint,
    };
    const decl: RollDeclaration = {
      gameHash: g1.hash, sides: 6,
      requests: [{ author: "alice", seqId: 0, fingerprint: commit.fingerprint }],
    };
    const result = verifyGame([g1], { alice: [commit] }, [resolveRoll(decl, [reveal])], 20);
    equal(result.valid, false);
    ok(result.errors.some((e: string) => e.includes("has sides 6, expected 20")));
  });

  it("fails on fingerprint reuse across resolutions", () => {
    const g = createGenesisState("roll", 0, 20);
    const commit = createClosedSecret("alice", 0, "s", "g");
    const reveal: SecretReveal = {
      seed: "g", author: "alice", seqId: 0, secret: "s",
      fingerprint: commit.fingerprint,
    };
    const decl: RollDeclaration = {
      gameHash: g.hash, sides: 20,
      requests: [{ author: "alice", seqId: 0, fingerprint: commit.fingerprint }],
    };
    const res1 = resolveRoll(decl, [reveal]);
    const res2 = resolveRoll(decl, [reveal]);
    const result = verifyGame([g], { alice: [commit] }, [res1, res2]);
    equal(result.valid, false);
    ok(result.errors.some((e: string) => e.includes("Resolution 1 failed")));
  });

  it("fails on resolution with wrong secret", () => {
    const g = createGenesisState("roll", 0, 20);
    const commit = createClosedSecret("alice", 0, "real", "g");
    const reveal: SecretReveal = {
      seed: "g", author: "alice", seqId: 0, secret: "wrong",
      fingerprint: commit.fingerprint,
    };
    const decl: RollDeclaration = {
      gameHash: g.hash, sides: 20,
      requests: [{ author: "alice", seqId: 0, fingerprint: commit.fingerprint }],
    };
    const result = verifyGame([g], { alice: [commit] }, [resolveRoll(decl, [reveal])]);
    equal(result.valid, false);
    ok(result.errors.some((e: string) => e.includes("does not match fingerprint")));
  });

  it("fails on resolution with wrong claimed roll", () => {
    const g = createGenesisState("roll", 0, 20);
    const commit = createClosedSecret("alice", 0, "s", "g");
    const reveal: SecretReveal = {
      seed: "g", author: "alice", seqId: 0, secret: "s",
      fingerprint: commit.fingerprint,
    };
    const decl: RollDeclaration = {
      gameHash: g.hash, sides: 20,
      requests: [{ author: "alice", seqId: 0, fingerprint: commit.fingerprint }],
    };
    const resolution = resolveRoll(decl, [reveal]);
    const badRes: RollResolution = { ...resolution, roll: resolution.roll + 1 };
    const result = verifyGame([g], { alice: [commit] }, [badRes]);
    equal(result.valid, false);
    ok(result.errors.some((e: string) => e.includes("does not match computed roll")));
  });

  it("fails when resolution references unknown state", () => {
    const commit = createClosedSecret("alice", 0, "s", "g");
    const reveal: SecretReveal = {
      seed: "g", author: "alice", seqId: 0, secret: "s",
      fingerprint: commit.fingerprint,
    };
    const decl: RollDeclaration = {
      gameHash: "0000000000000000000000000000000000000000000000000000000000000000",
      sides: 20,
      requests: [{ author: "alice", seqId: 0, fingerprint: commit.fingerprint }],
    };
    const g = createGenesisState("roll", 0, 20);
    const result = verifyGame([g], { alice: [commit] }, [resolveRoll(decl, [reveal])]);
    equal(result.valid, false);
    ok(result.errors.some((e: string) => e.includes("unknown state")));
  });

  it("handles mixed valid and invalid resolutions", () => {
    const g = createGenesisState("roll", 0, 20);
    const commit = createClosedSecret("alice", 0, "s", "g");
    const reveal: SecretReveal = {
      seed: "g", author: "alice", seqId: 0, secret: "s",
      fingerprint: commit.fingerprint,
    };
    const decl: RollDeclaration = {
      gameHash: g.hash, sides: 20,
      requests: [{ author: "alice", seqId: 0, fingerprint: commit.fingerprint }],
    };
    const good = resolveRoll(decl, [reveal]);
    const bad: RollResolution = { ...good, roll: good.roll + 1 };
    const result = verifyGame([g], { alice: [commit] }, [good, bad]);
    equal(result.valid, false);
    ok(result.errors.length > 0);
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

  it("same game hash with same secrets is deterministic", () => {
    const g = createGenesisState("roll", 0, 100);
    const r1 = deriveRoll(g.hash, ["s1", "s2"], 100);
    const r2 = deriveRoll(g.hash, ["s1", "s2"], 100);
    equal(r1, r2);
  });

  it("different game hash with same secrets produces different roll", () => {
    const g1 = createGenesisState("roll-a", 0, 100);
    const g2 = createGenesisState("roll-b", 0, 100);
    ok(deriveRoll(g1.hash, ["s"], 100) !== deriveRoll(g2.hash, ["s"], 100));
  });

  it("a tampered game state in a chain is detected", () => {
    const g1 = createGenesisState("start", 0);
    const g2 = createNextState(g1, "move-1", 1);
    const g3 = createNextState(g2, "move-2", 2);
    const tampered: typeof g2 = { ...g2, data: "CHEAT" };
    throws(() => verifyChain([g1, tampered, g3]));
  });

  it("secret reveal with correct secret passes verification", () => {
    const commit = createClosedSecret("alice", 0, "secret", "");
    const reveal: SecretReveal = {
      seed: "", author: "alice", seqId: 0, secret: "secret",
      fingerprint: commit.fingerprint,
    };
    doesNotThrow(() => verifySecretReveal("alice", commit.fingerprint, reveal));
  });

  it("roll distribution is uniform (no modulo bias on small sides)", () => {
    const g = createGenesisState("roll", 0, 6);
    const counts: number[] = new Array(6).fill(0);
    const trials = 1000;
    for (let i = 0; i < trials; i++) {
      const r = deriveRoll(g.hash, [`secret-${i}`], 6);
      counts[r - 1]!++;
    }
    const expected = trials / 6;
    for (let i = 0; i < 6; i++) {
      const deviation = Math.abs(counts[i]! - expected);
      ok(deviation < expected * 0.5, `Face ${i + 1}: count ${counts[i]} deviates too much`);
    }
  });

  it("rejection sampling never produces val outside [0, maxAcceptable)", () => {
    const g = createGenesisState("roll", 0, 20);
    const r = deriveRoll(g.hash, ["def"], 20);
    ok(r >= 1 && r <= 20);
  });

  it("multi-secret deriveRoll includes all secrets", () => {
    const g = createGenesisState("roll", 0, 100);
    const single = deriveRoll(g.hash, ["s1"], 100);
    const multi = deriveRoll(g.hash, ["s1", "s2"], 100);
    ok(single !== multi);
  });

  it("commitments cannot be reused across resolutions in verifyGame", () => {
    const g = createGenesisState("roll", 0, 20);
    const commit = createClosedSecret("alice", 0, "s", "g");
    const reveal: SecretReveal = {
      seed: "g", author: "alice", seqId: 0, secret: "s",
      fingerprint: commit.fingerprint,
    };
    const decl: RollDeclaration = {
      gameHash: g.hash, sides: 20,
      requests: [{ author: "alice", seqId: 0, fingerprint: commit.fingerprint }],
    };
    const result = verifyGame([g], { alice: [commit] }, [
      resolveRoll(decl, [reveal]),
      resolveRoll(decl, [reveal]),
    ]);
    equal(result.valid, false);
  });
});
