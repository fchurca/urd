# URD: URD's Roll Derivation

A Verifiable Randomness Protocol for Decentralized "Play-by-Nostr" Games

**Status:** proof-of-concept — state chain, secret pool, roll declaration/reveal/resolution,
and full game verification implemented. Nostr bindings and demo client are
planned but not yet built.

**URD** 🔮 (pronounced "urd") shares its name with [Urðr](https://en.wikipedia.org/wiki/Ur%C3%B0r),
one of the Norns who weave the threads of fate in Norse mythology — fitting for a protocol
that derives deterministic outcomes from committed secrets.

Demonstrator: [Vesta](https://github.com/fchurca/vesta) — a decentralized
settlement-building board game built on URD, running on Nostr.

License: see [LICENSE](./LICENSE) file (BSD 2-Clause).

![URD](./doc/urd.jpeg)

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
   fingerprints at game start. Each commitment is a `ClosedSecret` published
   as `(author, seq_id, seed, fingerprint)` where `fingerprint = taggedHash("urd-commit/v1", seed, author, seqId, secret)`.
   The pool tracks consumption — when a secret is revealed and resolved, the
   commitment is removed from `commitments[]` and pushed to `consumed[]` along
   with the raw secret and roll id that consumed it. New commitments can be
   appended at any time via `addToPool`, e.g., every time a player reveals a
   secret.

   The `seed` is a per-game identifier that binds all commitments within a
   pool to the same game. It prevents cross-game replay: a secret revealed
   in game X cannot be reused in game Y because the fingerprints differ
   (the seed is part of the hash). All commitments in a pool share the same
   seed — `createPool` and `addToPool` enforce this.

2. **Game state chain**: linked Nostr events where each state references the
   previous one (event `e` tag).

3. **Roll declaration**: a player declares intent to roll N dice by publishing
   a `RollDeclaration` containing the game state hash (salt) and a list of
   `SecretRequest`s identifying which pool commitments feed the roll. Anyone
   can request any existing fingerprint — their own or another player's.
   Multiple secrets produce a multi-source roll where no single party can
   predict the outcome.

4. **Secret reveal**: each secret's owner publishes a `SecretReveal` with
   the raw secret matching their commitment. Reveals are identified by
   fingerprint, not position — they can arrive in any order.

5. **Roll resolution**: once all requested secrets are published, anyone
    resolves the roll via `resolveRoll` (or a delegate authorized by the
    declarer). The roll is `taggedHash("urd-roll/v1", b64(gameHash) + ":" + b64(s1) + ":" + ...)`
    with rejection sampling into the requested range.

### Flow

Phase 0 — Setup: GM publishes kind:XXXXX with rules + their fingerprint pool.
Each player responds with kind:XXXXX adding their own pool. All commitments
are live from publication onward — new ones can be appended at any time.

Phase 1 — Roll declaration: Player A publishes kind:XXXXX "roll declaration"
with a `RollDeclaration` containing `gameHash` (the current game state hash),
`sides`, and a list of `SecretRequest`s. Each request identifies a pool
commitment by author, seqId, and fingerprint. A can request their own
commitments (self-draw, delayed reveal) or any other player's (public roll).
Multiple requests = multi-source (no party can predict alone).

Phase 2 — Secret reveal: Each requested secret's owner publishes kind:XXXXX
"secret reveal" with the raw secret. Reveals reference fingerprints, not
positions — they can arrive in any order and at any time.

Phase 3 — Roll resolution: Once all requested secrets are revealed, anyone
publishes kind:XXXXX "roll resolution" with the computed result. The roll is
`taggedHash("urd-roll/v1", b64(gameHash) + ":" + b64(s1) + ":" + b64(s2) + ...)` mapped to
the requested range via rejection sampling. The verifier consumes the revealed
secrets (removes from `commitments[]`, appends to `consumed[]`) to enforce
FIFO ordering and prevent reuse.

**Verification hierarchy (each level independently usable):**
1. `verifyChain(states)` — game state chain integrity (hashes, links, timestamps)
2. `verifyOpenSecret(open)` — a single opened secret matches its commitment
3. `verifySecretReveal(author, expectedFingerprint, reveal)` — one secret matches its expected fingerprint
4. `verifyRollDeclaration(declaration, pools)` — all requested fingerprints are next in line in their pools
5. `verifyRollResolution(resolution, pools)` — full roll: declaration + reveals + computation
6. `consumeSecrets(pool, rollId, reveals)` — move revealed commitments to consumed
7. `verifyGame(states, commitmentMaps, resolutions, expectedSides?)` — full game replay
8. `lookupSides(states, stateHash)` — look up the sides value for a state hash

**Hidden information / private draws:** A player publishes a roll declaration
naming their own commitment. They reveal privately (keep the reveal event
off-chain), compute the roll, and only publish the resolution later when
the hidden information must be revealed (e.g., playing a drawn card). No
extra encryption needed — hiding is achieved by delaying publication of the
reveal event. A peer's secret can be requested the same way for the same
purpose; the protocol does not care who owns the secret.

**Private draws from shared decks** (e.g., a common pool of advancement cards
drawn by multiple players without revealing the remaining deck) will be
addressed in a future release using commutative primitives (Soon™).

### Multi-source Derivation (Bias Prevention)

The roller alone can compute the outcome before publishing and may choose to
abort (forfeit) rather than reveal. To eliminate this advantage, a roll
declaration can request secrets from multiple parties so that no single party
can predict the roll alone.

A roll declaration lists any number of `SecretRequest`s, each targeting a
specific fingerprint in any player's pool. The roll is derived from all
revealed secrets combined — N parties must all cooperate to compute the
outcome. The declarer chooses the request list, so they control the balance
between bias risk and coordination cost.

### State Binding (Grinding Prevention)

The roll derivation uses the game state hash directly (`gameHash`). This hash
is the hash of the referenced `GameState` — an already-published, immutable
record. The declarer cannot grind timestamps to influence the outcome because
the state must exist in the verified chain before the declaration.

### Quick Start

A complete round — create a pool, declare a roll, reveal secrets, resolve,
and verify:

```ts
import {
  createPool, createClosedSecret, createOpenSecret,
  createGenesisState, deriveRoll,
  addToPool, verifySecretReveal, verifyRollDeclaration,
  verifyRollResolution, resolveRoll, verifyGame,
  consumeSecrets,
} from "urd";
import type {
  RollDeclaration, SecretReveal, SecretRequest, RollResolution,
} from "urd";

// Player A commits to a secret pool
const a0 = createClosedSecret("alice", 0, "a1b2c3d4e5f6g7h8i9j0klmnopqrstuv", "game-1");
const poolAlice = createPool("alice", [a0]);
const pools = { alice: poolAlice };

// Game state is established
const state = createGenesisState("start", 1001, 20);

// Someone declares a d20 roll requesting Alice's secret
const declaration: RollDeclaration = {
  gameHash: state.hash,
  sides: 20,
  requests: [{ author: "alice", seqId: 0, fingerprint: a0.fingerprint }],
};

// Alice reveals the secret
const revealA: SecretReveal = {
  seed: "game-1", author: "alice", seqId: 0,
  secret: "a1b2c3d4e5f6g7h8i9j0klmnopqrstuv",
  fingerprint: a0.fingerprint,
};

// Anyone resolves and publishes the roll
const resolution = resolveRoll(declaration, [revealA]);

// Any observer can verify after the fact
verifyRollDeclaration(declaration, pools);
verifySecretReveal("alice", a0.fingerprint, revealA);
verifyRollResolution(resolution, pools);

// Full game verification
const result = verifyGame(
  [state],
  { alice: [a0] },
  [resolution],
);
console.log(result.valid); // true
```

### Security Properties

- **No farming**: the declaration names specific fingerprints before any secret
  is revealed. The declarer cannot change the request list after seeing
  outcomes. Committing to a set of fingerprints upfront eliminates secret
  selection after the fact.
- **Multi-source by construction**: a roll declaration can request any number
  of secrets from any players. With N≥2 independent parties, no single party
  can predict or abort-bias the outcome. Single-source rolls (N=1) are
  detectable as a game-level choice.
- **No prediction**: the game state hash is unknown until published, and the
  secrets are unknown until revealed.
- **One-shot commitment**: the fingerprint pool is published before any game
  state exists; no fingerprints can be altered or reordered mid-game. New
  commitments can be appended at any time for replenishment.
- **Public verifiability**: any observer with the event chain can replay and
  verify every result using the verification hierarchy.
- **Out-of-order reveals**: reveals reference fingerprints, not pool positions.
  They can arrive in any order over the async transport.
- **Delegated resolution**: anyone can compute the roll once all secrets are
  revealed. The declarer can authorize a third party to resolve ("I toss, you
  reveal").
- **Timing-safe comparisons**: hash comparisons use string equality (`===`).
  The protocol targets turn-based games over Nostr where each round takes
  seconds or hours — microsecond timing leaks are irrelevant to the threat
  model.
- **Verifiable in a shared log**: URD assumes a shared event log (e.g., a Nostr
  relay) visible to all participants. The protocol does not provide byzantine
  fault-tolerant consensus; fork detection requires relay-level deduplication or
  social coordination between participants.

### Verification Reference

All verifier functions in the library throw distinct errors on rejection. The
table below documents every rejection reason across the API.

#### `verifyChain(states)`

| Error message | When |
|---|---|---|
| `Chain is empty` | `states` array has length 0 |
| `State abc... has invalid timestamp` | A state's `timestamp` is not a finite number (e.g., `NaN` or `Infinity`) |
| `State abc... hash is invalid` | A state's `hash` field does not match `hashState(data, prevHash, timestamp, sides)` |
| `Chain broken at abc...: prevHash does not match previous state` | A non-genesis state's `prevHash` does not reference the previous state's hash |
| `Genesis state abc... has prevHash, expected null` | The first state has a non-null `prevHash` |

#### `verifyOpenSecret(open)`

| Error message | When |
|---|---|
| `Secret does not match fingerprint` | `taggedHash("urd-commit/v1", seed, author, seqId, secret)` does not equal `open.fingerprint` |

#### `verifySecretReveal(author, expectedFingerprint, reveal)`

| Error message | When |
|---|---|
| `Secret author does not match expected author` | `reveal.author` does not match the `author` parameter |
| `Secret does not match fingerprint` | `taggedHash("urd-commit/v1", seed, author, seqId, secret)` does not match the expected fingerprint |

#### `verifyRollDeclaration(declaration, pools)`

| Error message | When |
|---|---|
| `Roll sides must be a finite integer >= 2 and ≤ 2^48` | `declaration.sides` is not a valid roll range |
| `Roll declaration must request at least one secret` | `declaration.requests` is empty |
| `gameHash must be a 64-char hex string` | `declaration.gameHash` is not valid hex |
| `Author ${author} has no pool` | The requested author has no pool record in the `pools` map |
| `Fingerprint ${fp}... does not match next unconsumed commitment for ${author} (expected ${fp}...)` | The requested fingerprint is not the next unconsumed commitment in the author's pool (FIFO violation) |
| `seqId mismatch for fingerprint ${fp}...` | The requested `seqId` does not match the commitment's `seqId` |

#### `verifyRollResolution(resolution, pools)`

| Error message | When |
|---|---|
| (propagated from `verifyRollDeclaration`) | Declaration validation fails |
| `Expected ${n} reveals, got ${m}` | Wrong number of reveals for the declared requests |
| `Reveal ${i} fingerprint does not match request` | Reveal's fingerprint does not match the corresponding request |
| `Reveal ${i} author does not match request` | Reveal's author does not match the corresponding request |
| `Secret does not match fingerprint for reveal ${i}` | `taggedHash("urd-commit/v1", seed, author, seqId, secret)` does not match the reveal's fingerprint |
| `Claimed roll does not match computed roll` | `deriveRoll(gameHash, secrets[], sides)` !== `resolution.roll` |

#### `consumeSecrets(pool, rollId, reveals)`

| Error message | When |
|---|---|
| `Reveal author does not match pool author` | A reveal targets a different author than the pool |
| `Fingerprint ${fp}... does not match next unconsumed commitment for ${author}` | A reveal's fingerprint does not match `commitments[0]` (either wrong secret or commitment was already consumed) |
| `Index ${i} out of bounds` | More reveals than remaining commitments in the pool |

#### `verifyGame(states, commitmentMaps, resolutions, expectedSides?)`

| Error message | When |
|---|---|
| (propagated from `verifyChain`) | Chain validation fails (short-circuits, no further checks) |
| `Pool creation failed for ${author}: ${msg}` | `createPool` threw for an author's commitment list |
| `Resolution ${i} failed: ${msg}` | A resolution's `verifyRollDeclaration` or `verifyRollResolution` check failed |
| `Resolution ${i} references unknown state ${hash}...` | `declaration.gameHash` does not match any state in the chain |
| `Resolution ${i} has sides ${sides}, expected ${expectedSides}` | The state referenced by `gameHash` has a different `sides` than `expectedSides` |

> Pools are `Record<string, ClosedSecret[]>` keyed by author, containing all commitments ever published by that author (initial + any replenishments). Empty arrays are skipped. Consumption is tracked via `consumeSecrets`: consumed commitments move from `commitments[]` to `consumed[]` with the raw secret and roll id.
>
> Resolutions are self-contained — each `RollResolution` includes the full `RollDeclaration` and the `SecretReveal[]` in request order. This makes each resolution independently verifiable. The verifier calls `consumeSecrets` only for passing resolutions.

#### `lookupSides(states, stateHash)`

| Error message | When |
|---|---|
| `State ${hash}... not found in chain` | No state with the given hash exists in the chain |
| `State ${hash}... does not define sides` | The state exists but has no `sides` field |
| `State ${hash}... sides must be a finite integer >= 2 and <= 2^48, got ${val}` | The state's `sides` is invalid (NaN, Infinity, <2, or >2^48) |

### Design Decisions

- **Domain-separated hashing**: all hashes use BIP-340-style tagged SHA-256.
  Each record type has a distinct tag: `urd-commit/v1` for commitment
  fingerprints, `urd-state/v1` for game state hashes, and `urd-roll/v1` for
  roll derivation. This prevents cross-domain collision attacks.
- **Roll uses N secrets**: the derivation formula is
  `taggedHash("urd-roll/v1", b64(gameHash) + ":" + b64(s1) + ":" + ...)`.
  Any number of secrets (N≥1) can contribute, in declaration order. The
  base64-encoded `:`-separated format provides domain separation within
  the roll tag.
- **Multi-source by construction**: a roll declaration requests N secrets
  from any players' pools. With N≥2 independent parties, no single party
  can predict or abort-bias the outcome. Single-source rolls (N=1) are
  a game-level choice — the protocol treats them identically.
- **Pool consumption tracking**: the pool tracks its own consumption via
  `consumeSecrets`. Each consumed commitment is removed from `commitments[]`
  and pushed to `consumed[]` with the raw secret and roll id. The verifier
  advances pool state only for passing resolutions. FIFO order within each
  pool is enforced naturally — you always consume from the front of the array.
- **Delegated resolution**: `resolveRoll` is a pure computation. Anyone
  with the declaration and reveals can compute the result. This enables
  patterns like "I toss the die and you reveal it."
- **Secret entropy**: secrets must have sufficient entropy to prevent
  brute-force prediction of the fingerprint. The library does not enforce a
  minimum entropy — it is the caller's responsibility to generate strong
  secrets (at least 128 bits, e.g., 32 hex characters from a CSPRNG). Never
  use guessable values like dictionary words or short strings. Multi-source
  rolls mitigate weak secrets because the attacker would need to brute-force
  *all* secrets simultaneously.

### Repudiation

Events carry a `timestamp` that commits to a point in time. This opens
repudiation opportunities an honest player should avoid and a malicious one
may exploit:

| Opportunity | Risk | Mitigation |
|---|---|---|
| **Future timestamp** — player publishes a state with `timestamp` far in the future | If the game turns unfavorable, the player can claim their clock was wrong and repudiate the state as invalid | Use the median of several relay-observed timestamps; reject timestamps more than N hours ahead of relay time |
| **Late reveal** — player does not reveal for a requested secret within a reasonable window | The player can observe others' moves before deciding whether to reveal; if unfavorable, they can stay silent | Forfeit (loss of turn or game); the roll remains unresolved and the declarer can abort it |
| **Missing request** — no one requests a player's secret in time | A player could sit on their secret indefinitely | A consensus round or relay-enforced deadline; the secret expires if unused after N events |
| **Clock disagreement** — two relays see different timestamps for the same event | Ambiguity about which state is canonical and which timestamps to use in hash derivation | Use relay-observed time (not event timestamp) for ordering; event timestamp is only used for hash binding |

In a proof-of-concept or small game, these risks are tolerable. A production
deployment should pick a concrete timeout (e.g., 7 days between challenge and
reveal) enforced by social consensus or relay policy.

### Nostr Implementation

Proposed new event kinds (e.g., 31000-31099 for games):
- Kind X: Game Definition (fingerprint pool + rules)
- Kind X+1: Join Game (add own pool, or replenish)
- Kind X+2: Game State (move + updated state)
- Kind X+3: Roll Declaration (intent to roll, names N secrets)
- Kind X+4: Secret Reveal (reveal a single secret for one fingerprint)
- Kind X+5: Roll Resolution (computed result, published by declarer or delegate)

Relevant tags:
- `e`: parent event reference (state chain)
- `p`: participant pubkeys
- `fingerprint`: `taggedHash("urd-commit/v1", seed, author, seqId, secret)` (hex)
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
   - [x] Roll derivation with N secrets and base64-encoded separator
     (`deriveRoll`)
   - [x] Pool management with consumption tracking (`SecretPoolState`,
      `ConsumedSecret`, `createPool`, `addToPool`, `consumeSecrets`)
   - [x] Roll declaration and secret reveal (`RollDeclaration`,
     `SecretReveal`, `verifySecretReveal`, `verifyRollDeclaration`)
   - [x] Roll resolution with multi-secret derivation (`RollResolution`,
     `resolveRoll`, `verifyRollResolution`)
   - [x] State lookup in chain (`findStateInChain`, `lookupSides`)
   - [x] Composite game verification (`verifyGame`)
   - [x] Security tests (determinism, multi-secret non-predictability,
     distribution uniformity, non-reusability)
3. Articulate with [Vesta](https://github.com/fchurca/vesta) as a
   demonstrator to showcase the protocol in a decentralized
   settlement-building board game running on Nostr
4. Private draws from shared decks using commutative primitives
5. ???
6. Profit!
