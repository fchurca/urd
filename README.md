# URD: URD's Roll Derivation

A Verifiable Randomness Protocol for Decentralized "Play-by-Nostr" Games

**Status:** proof-of-concept — state chain, secret pool, roll derivation, and
challenge/reveal mechanism implemented. Nostr bindings and demo client are
planned but not yet built.

**URD** (pronounced "urd") shares its name with [Urðr](https://en.wikipedia.org/wiki/Ur%C3%B0r),
one of the Norns who weave the threads of fate in Norse mythology — fitting for a protocol
that derives deterministic outcomes from committed secrets.

## Problem

In peer-to-peer multiplayer games without a central server (e.g., play-by-mail
over Nostr), trust in randomness is the weak link. "I rolled a natural 20,
trust me bro" is not verifiable. Casino provably-fair schemes require a
central server. On-chain commit-reveal requires blocks and synchronous timing.
VRFs and randomness beacons require external infrastructure.

## Goal

Design and implement a protocol for verifiable random outcomes in tabletop
games (dice rolls, card draws, etc.) over Nostr, with these properties:

- **Asynchronous**: players respond in hours/days, no rounds or deadlines
- **Shared-nothing**: no central server, no specialized relay, no blockchain
- **Deterministic and verifiable**: given the game state and committed secrets,
  anyone can replay and verify every result
- **Farm-resistant**: a player cannot choose which secret to reveal; abort (forfeit) is detectable
- **Identity via pubkey**: uses existing Nostr keys for signing and authentication

At a physical table, trust in randomness is solved by sharing custody: you
shuffle the deck, another player cuts it, and everyone takes turns dealing.
URD replicates this interaction digitally — each player locks in a shuffled
pool of secrets, a peer cuts by selecting which one to reveal, and the
result is dealt using the public game state.

## Proposed Design

### Components

1. **Pre-committed secret pool**: each player publishes an ordered list of
   fingerprints at game start. Each commitment is a closed secret published
   as `(author, seq_id, seed, fingerprint)` where `fingerprint = hash(seed + author + seq_id + secret)`.
   The initial pool can be as small as one fingerprint; new fingerprints are
   appended during each reveal (with incremented `seq_id`).

   The `seed` is a per-game identifier that binds all commitments within a
   pool to the same game. It prevents cross-game replay: a secret revealed
   in game X cannot be reused in game Y because the fingerprints differ
   (the seed is part of the hash). All commitments in a pool share the same
   seed — `createPool` enforces this equality.

   Every type that references a secret (`ClosedSecret`, `OpenSecret`, `Reveal`,
   `ChallengeEvent`) carries its own `seed` field. This redundancy is
   intentional: each record may arrive from a different wire event and must
   be verifiable in isolation without cross-referencing other events.
   `verifyChallenge` and `verifyReveal` both check that the on-wire seed
   matches the expected pool commitment, ensuring the event belongs to the
   correct game.

2. **Game state chain**: linked Nostr events where each state references the
   previous one (event `e` tag)

3. **Roll derivation**: `roll = hash(prev_state_hash, secret[, challenger_secret])`
   mapped to the requested range (e.g., 1–20 for a d20) — deterministic
   derivation from the *previous* state (binding to an already-published,
   immutable hash prevents timestamp grinding) and one or two secrets.
   When a challenger also provides a secret, neither party can predict the
   outcome alone (multi-source mode).

4. **FIFO consumption**: secrets are consumed in pool order (by ascending
   `seq_id`), never reused. Sequence numbers are localized per author.

5. **Challenge mechanism**: a player needing randomness publishes a "roll
   intent"; another player challenges them by calling out the oldest unused
   fingerprint from their pool. The roller must reveal the matching secret,
   locking in the result.

### Flow

Phase 0 — Setup: GM publishes kind:XXXXX with rules + their fingerprint pool.
Each player responds with kind:XXXXX adding their own pool, forming a circular
participant list.

Phase 1 — Commit to roll: Player A publishes kind:XXXXX "intent to roll d20"
referencing the current state. Player B publishes kind:XXXXX "challenge A"
including A's oldest unused fingerprint.

Phase 2 — Reveal: Player A publishes kind:XXXXX "reveal" with:
- secret matching the challenged fingerprint
- new fingerprint appended to pool (replenish, with `seq_id` incremented)
- derived result: `hash(prev_state_hash, secret)` mapped to the requested range

Anyone verifies:
- `hash(seed + author + seq_id + secret) == fingerprint` (initial commitment holds)
- `hash(prev_state_hash, secret)` produces the claimed result
- new fingerprint is appended at end of A's pool with correct `seq_id`
- the referenced state hash exists in the verified game state chain

If A does not reveal within a reasonable time: forfeit (inactivity).

**Note:** verification short-circuits on chain failure — if the state chain
is invalid, the game is unrecoverable and all subsequent checks are skipped.

**Hidden information / self-challenge**: the same challenge-reveal mechanism
serves independent private random values (e.g., a private draw from one's own
pool). A player can **self-challenge**
 — call `nextChallenge` on their own commitment pool, then `processReveal`
with their own secret to consume the fingerprint privately (returns an updated pool). The derived
result stays hidden until the player later publishes it (e.g., playing the
drawn card).

Alternatively, a player can ask a peer to reveal a secret for the same
purpose. In either case, the protocol does not care who initiated the
challenge — `verifyChallenge` accepts any challenger, and `processReveal`
accepts any revealer as long as the secret matches the fingerprint.

**Flow for a private draw:**
1. Player calls `nextChallenge(pool)` — the pool can be their own or a peer's
2. Player (or peer) calls `processReveal(pool, reveal, states)` to
   consume the commitment and get a deterministic roll (returns an updated pool)
3. The roll is not published yet — the player keeps it in their private state
4. When the hidden information must be revealed (e.g., playing the card),
   the player publishes the roll and the reveal details for verification

No extra encryption is needed — hiding is achieved by delaying publication
of the reveal event.

### Multi-source Derivation (Bias Prevention)

The roller alone can compute the outcome before publishing and may choose to
abort (forfeit). To eliminate this advantage, both parties can contribute a
secret so that neither can predict the roll alone:

1. The challenger selects a secret from their own committed pool and includes
   its seed, author, seqId, and fingerprint in the `ChallengeEvent` as `challengerCommitment`
2. The reveal includes the matching `challengerSecret`
3. The roll is derived from both secrets: `roll = hash(prev_state_hash, secret_roller, secret_challenger)`
4. `processReveal` and `verifyReveal` verify both secrets against their
   respective commitments

Multi-source is optional. In single-source mode (no challenger secret), abort
is detectable and attributable but not prevented.

### State Binding (Grinding Prevention)

The roll is bound to the *previous* state's hash (`prevHash ?? hash` of the
referenced state), not the current one. This prevents the roller from grinding
their own state's timestamp to influence the outcome — the roll depends on an
already-published, immutable state.

### Quick Start

A complete round — create a pool, challenge, reveal, and verify:

```ts
import {
  createPool, createClosedSecret, createOpenSecret,
  createGenesisState, deriveRoll, nextChallenge,
  processReveal, verifyReveal, verifyChallenge,
  verifyPoolFingerprints,
} from "urd";
import type { Reveal, ChallengeEvent } from "urd";

// Player A commits to a secret pool
const pool = createPool("alice", [
  createClosedSecret("alice", 0, "a1b2c3d4e5f6g7h8i9j0klmnopqrstuv", "game-1"),
]);

// Game state is established
const state = createGenesisState("start", 1001, 20);

// Challenger picks the oldest unused fingerprint
const challenge = nextChallenge(pool)!;

// Player A reveals the secret, gets a d20 roll and an updated pool
const roll = deriveRoll(state.hash, "a1b2c3d4e5f6g7h8i9j0klmnopqrstuv", 20);
const reveal: Reveal = {
  seed: "game-1",
  seqId: 0,
  secret: "a1b2c3d4e5f6g7h8i9j0klmnopqrstuv",
  newFingerprint: createClosedSecret("alice", 1, "k1l2m3n4o5p6q7r8s9t0", "game-1").fingerprint,
  stateHash: state.hash,
  claimedRoll: roll,
};
const { updatedPool } = processReveal(pool, reveal, [state]);

// Any observer can verify after the fact
verifyChallenge(pool, {
  challenger: "bob",
  targetAuthor: "alice",
  ...challenge,
} satisfies ChallengeEvent);
verifyReveal("alice", pool.commitments[0]!.fingerprint, reveal, [state]);
verifyPoolFingerprints(updatedPool, [createOpenSecret(pool.commitments[0]!, "a1b2c3d4e5f6g7h8i9j0klmnopqrstuv")]);
```

### Security Properties

- **No farming**: the fingerprint determines which secret to use; you cannot
  choose which secret to reveal. The roller computes the roll before publishing
  and can choose to abort (forfeit) instead of revealing — abort is detectable
  and attributable. **Multi-source mode** (both parties contribute a secret)
  prevents even abort-based bias: neither party can compute the roll alone.
- **No prediction**: the game state is unknown until published, and the secret
  is unknown until revealed
- **One-shot commitment**: the fingerprint pool is published before any game
  state exists; no fingerprints can be altered or reordered mid-game.
  Fingerprints can be appended for later rolls
- **Public verifiability**: any observer with the event chain can replay and
  verify every result
- **Timing-safe comparisons**: hash comparisons use string equality (`===`).
  The protocol targets turn-based games over Nostr where each round takes
  seconds or hours — microsecond timing leaks are irrelevant to the threat
  model
- **Verifiable in a shared log**: URD assumes a shared event log (e.g., a Nostr
  relay) visible to all participants. The protocol does not provide byzantine
  fault-tolerant consensus; fork detection requires relay-level deduplication or
  social coordination between participants.

### Verification Reference

All verifier functions in the library throw distinct errors on rejection. The
table below documents every rejection reason across the API.

#### `verifyChain(states)`

| Error message | When |
|---|---|
| `Chain is empty` | `states` array has length 0 |
| `State abc... hash is invalid` | A state's `hash` field does not match `hashState(data, prevHash, timestamp, sides)` |
| `Chain broken at abc...: prevHash does not match previous state` | A non-genesis state's `prevHash` does not reference the previous state's hash |
| `Genesis state abc... has prevHash, expected null` | The first state has a non-null `prevHash` |

#### `verifyOpenSecret(open)`

| Error message | When |
|---|---|
| `Secret does not match fingerprint` | `taggedHash("urd-commit/v1", seed, author, seq_id, secret)` does not equal `open.fingerprint` |

#### `verifyReveal(author, expectedFingerprint, reveal, states, challenger?)`

| Error message | When |
|---|---|---|
| `newFingerprint must be a 64-char hex string` | `reveal.newFingerprint` is not valid hex |
| `Secret does not match fingerprint` | `taggedHash(seed, author, seq_id, secret)` does not match the expected fingerprint |
| `State abc... not found in chain` | `reveal.stateHash` does not match any state in the chain |
| `State abc... does not define sides` | The referenced state has no `sides` field |
| `State abc... sides must be a finite integer >= 2, got ...` | Invalid sides value on referenced state |
| (propagated from `deriveRoll`) | `sides` exceeds 2^48 (the rejection sampling 48-bit limit) |
| `Challenger secret provided but no challenger commitment` | `reveal.challengerSecret` is set but no `challenger` argument was passed |
| `Challenger secret does not match challenger commitment` | The challenger's secret does not hash to `challenger.fingerprint` |
| `Claimed roll does not match computed roll` | `deriveRoll(rollHash, secret, sides[, challengerSecret]) !== reveal.claimedRoll` |

> `expectedFingerprint` is the `fingerprint` field from the `ClosedSecret` (the commitment published at game start). The caller extracts this from the commitment that corresponds to this reveal's `seqId`. The roll is computed from the **previous** state's hash (`state.prevHash ?? state.hash`) to prevent timestamp grinding.

> **`verifyReveal` is read-only.** The sibling function `processReveal` performs the same checks but also returns an updated pool (consumes the commitment, appends a new one). Use `processReveal` during gameplay; use `verifyReveal` for post-hoc audit.

#### `processReveal(pool, reveal, states, challenger?)`

| Error message | When |
|---|---|
| `newFingerprint must be a 64-char hex string` | `reveal.newFingerprint` is not valid hex |
| `No pending challenge` | All commitments have been consumed (pool depleted) |
| `seqId does not match next challenge` | `reveal.seqId` does not match the next unconsumed commitment's seqId |
| `Seed does not match challenge` | `reveal.seed` does not match the next commitment's seed |
| `Secret does not match fingerprint` | `taggedHash(seed, author, seq_id, secret)` does not match the committed fingerprint |
| `State abc... not found in chain` | `reveal.stateHash` does not match any state in the chain |
| `State abc... does not define sides` | The referenced state has no `sides` field |
| `State abc... sides must be a finite integer >= 2, got ...` | Invalid sides value on referenced state |
| (propagated from `deriveRoll`) | `sides` exceeds 2^48 (the rejection sampling 48-bit limit) |
| `Challenger secret provided but no challenger commitment` | `reveal.challengerSecret` is set but no `challenger` argument was passed |
| `Challenger secret does not match challenger commitment` | The challenger's secret does not hash to `challenger.fingerprint` |
| `Claimed roll does not match computed roll` | `deriveRoll(rollHash, secret, sides[, challengerSecret]) !== reveal.claimedRoll` |

#### `verifyChallenge(pool, challenge)`

| Error message | When |
|---|---|
| `No pending challenge` | All commitments have been consumed |
| `Challenge target author does not match pool author` | `challenge.targetAuthor !== pool.author` |
| `Challenge seed does not match next commitment` | Seed does not match the next unconsumed commitment |
| `Challenge seqId does not match next commitment` | `challenge.seqId` does not match the next available `seqId` |
| `Challenge fingerprint does not match next commitment` | `challenge.fingerprint` does not match the next commitment's fingerprint |

#### `verifyPoolFingerprints(pool, opened)`

| Error message | When |
|---|---|
| `Expected ${pool.consumedCount} opened secrets, got ${opened.length}` | Wrong number of opened secrets for the consumed commitments |
| `Opened secret (author=..., seqId=...) not found in pool commitments` | An opened secret does not correspond to any consumed commitment |
| (propagated from `verifyOpenSecret`) | An opened secret's fingerprint does not match its revealed secret |

#### `verifyGame(states, initialCommitments, reveals, openedSecrets, expectedSides?, challengerCommitments?)`

| Error message | When |
|---|---|
| (propagated from `verifyChain`) | Chain validation fails (short-circuits, no further checks) |
| `Author ${author} has reveals but no initial commitments` | A reveal exists for an author not in `initialCommitments` |
| `Author ${author} has opened secrets but no initial commitments` | Opened secrets exist for an author not in `initialCommitments` |
| `Pool reconstruction failed for ${author}: ${msg}` | `reconstructPool` / `processReveal` threw (e.g., wrong secret, bad seqId, invalid `newFingerprint`) |
| `Opened secrets count for ${author}: have ${have}, need ${need}` | Wrong number of opened secrets for the consumed commitments |
| `Pool fingerprint mismatch for ${author}: ${msg}` | `verifyPoolFingerprints` threw (commitment not found or secret mismatch) |
| `Reveal seqId ${n} by ${author} references unknown state ${hash}...` | `reveal.stateHash` is not in the verified chain |
| `Reveal seqId ${n} by ${author} has sides ${sides}, expected ${expected}` | The state's `sides` does not match `expectedSides` |

> `openedSecrets` must contain one `OpenSecret` per consumed commitment (i.e., per reveal that was processed). Passing an empty or mismatched record will trigger a count mismatch error.
>
> All five maps (`initialCommitments`, `reveals`, `openedSecrets`, `challengerCommitments`) are keyed by author (the same string used in `createClosedSecret`). For a single-author game, each map has one entry; for multi-author games, each author has their own entry in each map.
>
> `challengerCommitments[author]` is a parallel array to `reveals[author]` — one entry per reveal, where `undefined` means no challenger for that reveal. Required when any reveal has `challengerSecret` set. The `ChallengerCommitment` must include the same `seed`, `author`, `seqId`, and `fingerprint` that the challenger committed to via `createClosedSecret`.

### Design Decisions

- **Domain-separated hashing**: all hashes use BIP-340-style tagged SHA-256.
  Each record type has a distinct tag: `urd-commit/v1` for commitment
  fingerprints, `urd-state/v1` for game state hashes, and `urd-roll/v1` for
  roll derivation. This prevents cross-domain collision attacks.
- **Roll bound to previous state**: the roll is computed from `state.prevHash ?? state.hash`
  — the previous state's hash (or the state's own hash if it is genesis). This
  prevents the roller from grinding their own state's timestamp to influence
  the outcome, because the roll depends on an already-published, immutable hash.
- **Multi-source derivation (optional)**: when a `challengerSecret` is provided
  in the reveal and a matching `ChallengerCommitment` in the challenge, the roll
  depends on both the roller's and the challenger's secrets. Neither party can
  predict the outcome alone. Single-source mode (no challenger secret) is
  vulnerable to abort-based bias but remains verifiable and attributable.
- **Secret entropy**: secrets must have sufficient entropy to prevent
  brute-force prediction of the fingerprint. The library does not enforce a
  minimum entropy — it is the caller's responsibility to generate strong
  secrets (at least 128 bits, e.g., 32 hex characters from a CSPRNG). Never
  use guessable values like dictionary words or short strings. Multi-source
  derivation mitigates weak secrets because the attacker would need to brute-force
  *both* secrets simultaneously.
- **Witness relays**: the protocol is fully peer-to-peer by default. Optional
  witness relays can accelerate challenge notification, but the protocol does
  not depend on them.

### Repudiation

Events carry a `timestamp` that commits to a point in time. This opens
repudiation opportunities an honest player should avoid and a malicious one
may exploit:

| Opportunity | Risk | Mitigation |
|---|---|---|
| **Future timestamp** — player publishes a state with `timestamp` far in the future | If the game turns unfavorable, the player can claim their clock was wrong and repudiate the state as invalid | Use the median of several relay-observed timestamps; reject timestamps more than N hours ahead of relay time |
| **Late reveal** — player does not reveal within a reasonable window after being challenged | The player can observe others' moves before deciding whether to reveal; if unfavorable, they can stay silent and later claim the challenge expired | Forfeit (loss of turn or game); the challenger proceeds without the roll — the game treats the secret as unrevealable |
| **Missing challenge** — no one challenges a player in time | Without a fingerprint call-out, a player could sit on their secret indefinitely | A consensus round or relay-enforced deadline; the state is considered firm if unchallenged after N events |
| **Clock disagreement** — two relays see different timestamps for the same event | Ambiguity about which state is canonical and which timestamps to use in hash derivation | Use relay-observed time (not event timestamp) for ordering; event timestamp is only used for hash binding |

In a proof-of-concept or small game, these risks are tolerable. A production
deployment should pick a concrete timeout (e.g., 7 days between challenge and
reveal) enforced by social consensus or relay policy.

### Nostr Implementation

Proposed new event kinds (e.g., 31000-31099 for games):
- Kind X: Game Definition (fingerprint pool + rules)
- Kind X+1: Join Game (add own pool)
- Kind X+2: Game State (move + updated state)
- Kind X+3: Commit Roll (intent to roll)
- Kind X+4: Challenge (demand fingerprint reveal)
- Kind X+5: Reveal (reveal secret + result)

Relevant tags:
- `e`: parent event reference (state chain)
- `p`: participant pubkeys
- `fingerprint`: SHA256 hash of `(seed + author + seq_id + secret)` (hex)
- `seq_id`: sequence number within an author's secret pool (integer)
- `roll`: dice type and result (e.g., "d20:15")

## Tasks

1. Formalize the protocol in a whitepaper / specification document
2. Implement a reference library in TypeScript (core functions: hashing,
   dice derivation, verification)
   - [x] State chain types and creation (`GameState`, `createGenesisState`,
     `createNextState`)
   - [x] Chain verification (`verifyChain`)
   - [x] Secret types and commitment (`ClosedSecret`, `OpenSecret`,
     `createClosedSecret`, `createOpenSecret`, `verifyOpenSecret`)
   - [x] Roll derivation with rejection sampling (`deriveRoll`)
   - [x] Challenge / reveal mechanism (`SecretPoolState`, `createPool`,
     `nextChallenge`, `processReveal`, `verifyReveal`)
   - [x] Challenge event type and verification (`ChallengeEvent`,
     `verifyChallenge`)
   - [x] Pool reconstruction from event history (`reconstructPool`)
   - [x] Pool fingerprint verification (`verifyPoolFingerprints`)
   - [x] State lookup in chain (`findStateInChain`)
   - [x] Composite game verification (`verifyGame`)
   - [x] Security tests (farming resistance, non-reusability, determinism,
     distribution uniformity)
3. Build a browser-only demo client that plays a simple game
   (e.g., D&D ability check) over a Nostr test relay; the server is
   just a static file server, no backend logic
4. (future)
