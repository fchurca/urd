# URD: URD's Roll Derivation

A Verifiable Randomness Protocol for Decentralized Turn-Based Games

**Status:** proof-of-concept — state chain, secret pool, roll declaration/reveal/resolution,
full game verification, and shared hidden deck protocol implemented. Nostr bindings
and a demo game client are planned but not yet built.

**URD** 🔮 (pronounced "urd") shares its name with [Urðr](https://en.wikipedia.org/wiki/Ur%C3%B0r),
one of the Norns who weave the threads of fate in Norse mythology — fitting for a protocol
that derives deterministic outcomes from committed secrets.

Demonstrator: [Vesta](https://github.com/fchurca/vesta) — a decentralized
settlement-building board game built on URD, running on Nostr.

License: see [LICENSE](./LICENSE) file (BSD 2-Clause).

![URD](./doc/urd.jpeg)

## Problem

In peer-to-peer multiplayer games without a central server (e.g., play-by-mail
over Nostr, email, or any async transport), trust in randomness is the weak link. "I rolled a natural 20,
trust me bro" is not verifiable. Casino provably-fair schemes require a
central server. On-chain commit-reveal requires blocks and synchronous timing.
VRFs and randomness beacons require external infrastructure.

## Goal

Design and implement a protocol for verifiable random outcomes in tabletop
games over any async transport, with these properties:

- **Asynchronous**: players respond in hours/days, no rounds or deadlines
- **Shared-nothing**: no central server, no specialized relay, no blockchain
- **Deterministic and verifiable**: given the game state and committed secrets,
  anyone can replay and verify every result
- **Farm-resistant**: a player cannot choose which secret to reveal; abort (forfeit) is detectable
- **Identity via public key**: uses existing keypairs (e.g., Nostr keys) for signing and authentication

At a physical table, trust in randomness is shared: you prepare the dice cup,
another player rolls, and everyone sees the result. URD replicates this
interaction digitally — each player locks in a pool of secrets, a peer
nominates which ones feed the roll, and the outcome is derived from the
public game state.

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

2. **Game state chain**: a reverse-linked list where each state references the
   previous one by its hash (the transport layer is responsible for
   delivering states in order).

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

Phase 0 — Setup: GM publishes rules + their fingerprint pool. Each player
responds adding their own pool. All commitments are live from publication
onward — new ones can be appended at any time.

Phase 1 — Roll declaration: A player publishes a `RollDeclaration` containing
`gameHash` (the current game state hash), `sides`, and a list of
`SecretRequest`s. Each request identifies a pool commitment by author, seqId,
and fingerprint. A player can request their own commitments (self-draw,
delayed reveal) or any other player's (public roll). Multiple requests =
multi-source (no party can predict alone).

Phase 2 — Secret reveal: Each requested secret's owner publishes the raw
secret. Reveals reference fingerprints, not positions — they can arrive in
any order and at any time.

Phase 3 — Roll resolution: Once all requested secrets are revealed, anyone
publishes the computed result. The roll is
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
9. `verifyDeckDeclaration(decl)` — deck declaration validity
10. `verifyDeckShuffle(event, inputDeckHash, deckKeyCommitments)` — shuffle integrity
11. `verifyDraw(deck, drawCiphertext)` — FIFO draw position
12. `verifyDrawCommitment(commit, ciphertext, player, nonce)` — draw commitment hash
13. `verifyKeyCommitment(commit, e, nonce)` — key commitment hash
14. `verifyCardReveal(reveal, deckKeyCommitments, prime)` — revealed card correctness

**Hidden information / private draws:** A player publishes a roll declaration
naming their own commitment. They reveal privately (keep the reveal event
off-chain), compute the roll, and only publish the resolution later when
the hidden information must be revealed (e.g., playing a development card in a settlement builder). No
extra encryption needed — hiding is achieved by delaying publication of the
reveal event. A peer's secret can be requested the same way for the same
purpose; the protocol does not care who owns the secret.

**Private draws from shared decks** (e.g., a shared deck of cards drawn by
multiple players without revealing the remainder to each other) is handled
by the [Deck Protocol](#shared-hidden-decks-sra-protocol) below, using
commutative encryption (SRA).

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

### Quick Start (Deck)

A complete deck lifecycle — create, shuffle/encrypt with 3 parties, draw a
card, and publicly reveal it:

```ts
import {
  DECK_SAFE_PRIME, generateKeypair, bigintToBase64, base64ToBigint,
  createInitialDeck, shuffleDeck, encryptDeck, hashDeck,
  drawCard, revealCard, createKeyCommitment, createDrawCommitment,
  verifyDeckDeclaration, verifyDeckShuffle, verifyDraw,
  verifyCardReveal,
} from "urd";
import type {
  DeckDeclaration, DeckShuffle, KeyCommitment, DrawCommitment,
  CardReveal, PartialReveal,
} from "urd";

const p = DECK_SAFE_PRIME;
const deckId = "game-1";
const players = ["alice", "bob", "carol"];

// Deck declaration
const declaration: DeckDeclaration = {
  deckId,
  prime: bigintToBase64(p),
  participants: players,
  cardCount: 52,
};
verifyDeckDeclaration(declaration);

// Each participant generates a keypair and commits to their public key
const keyCommitments = new Map<string, KeyCommitment>();
const keypairs = new Map<string, { e: bigint; d: bigint }>();
const nonces = new Map<string, string>();
for (const player of players) {
  const kp = generateKeypair(p);
  keypairs.set(player, kp);
  const nonce = Math.random().toString(36).slice(2);
  nonces.set(player, nonce);
  const kc = createKeyCommitment(player, deckId, kp.e, nonce);
  keyCommitments.set(player, kc);
}

// Each participant shuffles and encrypts in sequence
let currentDeck = createInitialDeck(52);
let prevHash = "";
for (const player of players) {
  const kp = keypairs.get(player)!;
  currentDeck = shuffleDeck(currentDeck);
  currentDeck = encryptDeck(currentDeck, kp.e, p);
  const deckHash = hashDeck(currentDeck);
  const event: DeckShuffle = {
    deckId, author: player, inputDeckHash: prevHash,
    outputDeck: currentDeck.map(c => bigintToBase64(c)),
    keyCommitment: keyCommitments.get(player)!.commitment,
  };
  verifyDeckShuffle(event, prevHash, keyCommitments);
  prevHash = deckHash;
}

// Alice draws the first card
const { card: ciphertext } = drawCard(currentDeck);
const ctB64 = bigintToBase64(ciphertext);
verifyDraw(currentDeck.map(c => bigintToBase64(c)), ctB64);

// Alice publishes a draw commitment
const drawNonce = Math.random().toString(36).slice(2);
const drawCommit = createDrawCommitment(deckId, "alice", ctB64, drawNonce);

// Later, Alice reveals the card publicly.
// Participants publish PartialReveal events in sequence,
// each removing one layer of encryption:
const partialReveals: PartialReveal[] = [];
let input = ctB64;
for (const player of players) {
  const kp = keypairs.get(player)!;
  const output = bigintToBase64(
    decrypt(base64ToBigint(input), kp.d, p),
  );
  partialReveals.push({
    deckId,
    drawCiphertext: ctB64,
    author: player,
    e: bigintToBase64(kp.e),
    inputCiphertext: input,
    outputCiphertext: output,
    nonce: nonces.get(player)!,
  });
  input = output;
}

// Alice decrypts the card privately using d values obtained out-of-band
const allD = players.map(player => keypairs.get(player)!.d);
const cardValue = revealCard(ciphertext, allD, p);

// Anyone can verify the public reveal chain
const cardReveal: CardReveal = {
  deckId,
  drawCommitment: drawCommit,
  card: Number(cardValue),
  partials: partialReveals,
};
verifyCardReveal(cardReveal, keyCommitments, p);
console.log(`Card revealed: ${cardValue}`);

> **Note:** the `nonce` in `PartialReveal` must be the **same nonce** used
> when the participant created their `KeyCommitment`. The verifier checks
> `taggedHash("urd-key/v1", b64(e), nonce)` against the stored commitment,
> so a different nonce would fail verification.

### Reimplementing

The protocol uses only SHA-256 via the BIP-340 tagged hash construction:

```
SHA256(SHA256(tag) ++ SHA256(tag) ++ msg)
```

The TypeScript implementation in this repository is a **reference
implementation** — the protocol is designed to be reimplemented in any
language with a SHA-256 library. Readers are welcome and encouraged to
write implementations in Python, Go, C, Common Lisp, or any other language.

The following domain tags are used for domain separation:

| Construction | Tag | Used for |
|---|---|---|
| `taggedHash("urd-commit/v1", seed, author, seqId, secret)` | `urd-commit/v1` | Commitment fingerprints |
| `taggedHash("urd-state/v1", data, prevHash, timestamp, sides?)` | `urd-state/v1` | Game state hashes |
| `taggedHash("urd-roll/v1", b64(gameHash) + ":" + b64(s1) + ":" + ...)` | `urd-roll/v1` | Roll derivation |
| `taggedHash("urd-deck/v1", ...b64(cards))` | `urd-deck/v1` | Deck hashes |
| `taggedHash("urd-key/v1", b64(e), nonce)` | `urd-key/v1` | Key commitments |
| `taggedHash("urd-draw/v1", ciphertext, player, nonce)` | `urd-draw/v1` | Draw commitments |

All hash comparisons use string equality (`===`). The roll derivation uses
rejection sampling on 48-bit extracts from the hash output. Maximum sides
value is `2^48` (281,474,976,710,656).

**Deck protocol primitives:** the deck extension requires modular exponentiation
(`x^y mod p`) and modular inverse (`e^{-1} mod (p-1)`) over a safe prime group.
The reference uses the 2048-bit MODP group #14 from RFC 3526 as `DECK_SAFE_PRIME`.
Encryption and decryption are the same operation: `E(x, k) = x^k mod p`.
Key generation picks a random odd `e > 2` and computes `d = e^{-1} mod (p-1)`.
Bigint values are serialized as unpadded base64 of their big-endian hex
representation.

### Security Properties

- **No farming**: the declaration names specific fingerprints before any secret
  is revealed. The declarer cannot change the request list after seeing
  outcomes. Committing to a set of fingerprints upfront eliminates secret
  selection after the fact. This means a player cannot choose *which* secret
  to reveal — abort (refuse to reveal) is detectable as a forfeit.
- **Multi-source by construction**: a roll declaration can request any number
  of secrets from any players. With N≥2 independent parties, no single party
  can predict or abort-bias the outcome. Single-source rolls (N=1) are
  detectable as a game-level choice — game implementors have the traceable
  opportunity to require multi-source rolls if they want bias resistance.
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
  The protocol targets turn-based games where each round takes seconds or
  hours — microsecond timing leaks are irrelevant to the threat model.
- **Verifiable in a shared log**: URD assumes a shared, ordered event log
  visible to all participants. The protocol does not provide byzantine
  fault-tolerant consensus; fork detection is delegated to the transport layer.

#### Fork Handling

URD assumes a total order of events. If the transport delivers events in
different orders to different participants (a fork), the protocol cannot
determine which fork is canonical. This is a deliberate scope boundary:

- URD verifies chain integrity — if a state's `prevHash` does not match the
  previous state, `verifyChain` rejects it.
- URD does not resolve forks. Two contradictory states at the same position
  in the chain are both rejected by the integrity check; the transport layer
  must decide which event is authoritative.
- Fork detection and resolution are the responsibility of the transport
  (e.g., a Nostr relay with deduplication, email threading rules, or social
  agreement among participants).
- An attacker who controls the transport can create forks. Mitigations
  include using multiple independent transports, relays with storage
  guarantees, or a transport that enforces total order (e.g., a blockchain,
  if you must).

As long as all participants see the same ordered event log, URD's
cryptographic guarantees hold. The protocol makes the fork problem
transparent rather than solving it.

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
| `Secret author does not match expected author` | `reveal.author` does not match the corresponding request |
| `Secret does not match fingerprint` | `taggedHash("urd-commit/v1", seed, author, seqId, secret)` does not match the reveal's fingerprint |
| `Claimed roll does not match computed roll` | `deriveRoll(gameHash, secrets[], sides)` !== `resolution.roll` |

#### `consumeSecrets(pool, rollId, reveals)`

| Error message | When |
|---|---|
| `Secret author does not match expected author` | A reveal targets a different author than the pool |
| `Fingerprint ${fp}... does not match next unconsumed commitment for ${author} (expected ${fp}...)` | A reveal's fingerprint does not match `commitments[0]` — either wrong secret or already consumed |

#### `verifyGame(states, commitmentMaps, resolutions, expectedSides?)`

Returns `VerifyGameResult { valid: boolean, errors: string[] }`.

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

### Shared Hidden Decks (SRA Protocol)

The deck protocol enables a shared deck where multiple players can draw
privately without revealing the remaining deck to each other. It uses the
[Shamir-Rivest-Adleman](https://en.wikipedia.org/wiki/Shamir%27s_three-pass_protocol)
(SRA) three-pass protocol with commutative encryption over a safe prime group.

**Approach:**

Instead of ZK proofs or cut-and-choose, the protocol defers all verification
to the point when a card becomes public. Each participant generates an RSA-like
keypair `(e, d)` where `e * d ≡ 1 mod (p-1)` over a 2048-bit safe prime.
Encryption and decryption are the same operation: `E(x, k) = x^k mod p`.
Because `E(E(x, a), b) = E(E(x, b), a)` (commutativity), applying all keys in
any order and then removing them in reverse order yields the original value.

**Initial values are offset by +2** because 0 and 1 are fixed points of
modular exponentiation: `0^e ≡ 0` and `1^e ≡ 1` for any `e`. Deck values
range from `2` to `cardCount + 1`.

**Flow:**

1. **Deck Declaration**: the game master publishes a `DeckDeclaration`
   specifying the deck `deckId`, `prime` (the safe prime), `participants`,
   and `cardCount`.

2. **Key Commitment**: each participant generates a keypair `(e, d)` and
   publishes a `KeyCommitment` binding their public key `e` with a random
   `nonce`: `taggedHash("urd-key/v1", b64(e), nonce)`.

3. **Shuffle and Encrypt**: in sequence, each participant shuffles the current
   deck (Fisher-Yates), encrypts every card with their `e`, hashes the
   ciphertext deck, and publishes a `DeckShuffle` with the `outputDeck` and
   the `inputDeckHash` (hash of the deck before their turn).

4. **Draw**: to draw a card, a player publishes a `DrawCommitment` binding
   the front ciphertext to their identity. To learn the card value, each
   other participant privately computes a partial decryption
   `partialDraw = ciphertext^d mod p` and sends it to the drawer
   (out-of-band, or encrypted via transport). With all partial decryptions,
   `revealCard(ciphertext, keysD, prime)` decrypts the card locally. The
   drawer's own partial decryption is computed using the `d` values they
   obtained out-of-band from each participant.

5. **Public Card Reveal**: when the drawn card must be revealed publicly
   (e.g., played in the game), participants publish `PartialReveal` events
   in sequence — each one removes one layer of encryption. The first
   partial takes the draw ciphertext as input and outputs
   `ciphertext^d_p1 mod p`; the second takes that output and decrypts
   further, and so on. The verifier checks:

   - The draw commitment matches the published ciphertext
   - Each `(e, nonce)` matches the participant's original `KeyCommitment`
   - `partialOutput^e ≡ partialInput (mod p)` — proves the participant
     correctly removed their encryption layer without revealing `d`
   - The chain links: each partial's input equals the previous partial's
     output, and the first partial's input equals the draw ciphertext
   - The final partial's output equals the claimed card value

**No private keys are ever disclosed.** Unlike a design that publishes
`(e, d)` directly, this protocol reveals only the result of decrypting a
*single, specific ciphertext*. Participants keep their private exponent
`d` secret throughout the game. A public card reveal exposes only the
partial decryption of that one card — the remaining deck stays encrypted
even after any number of public reveals.

**Deck types:**

```ts
interface KeyCommitment {
  author: string;
  deckId: string;
  commitment: string; // taggedHash("urd-key/v1", b64(e), nonce)
}

interface DeckDeclaration {
  deckId: string;
  prime: string;         // base64 of the safe prime
  participants: string[];
  cardCount: number;
}

interface DeckShuffle {
  deckId: string;
  author: string;
  inputDeckHash: string;
  outputDeck: string[];     // base64 ciphertexts
  keyCommitment: string;    // commitment hash from KeyCommitment
}

interface DrawCommitment {
  deckId: string;
  player: string;
  ciphertext: string;       // the drawn card's ciphertext
  nonce: string;
  commitment: string;       // taggedHash("urd-draw/v1", ciphertext, player, nonce)
}

interface PartialReveal {
  deckId: string;
  drawCiphertext: string;
  author: string;
  e: string;                // base64 public key
  inputCiphertext: string;  // base64 ciphertext before this participant's decryption
  outputCiphertext: string; // base64 ciphertext after this participant's decryption
  nonce: string;            // same nonce used in KeyCommitment
}

interface CardReveal {
  deckId: string;
  drawCommitment: DrawCommitment;
  card: number;             // the claimed plaintext value
  partials: PartialReveal[];
}
```

**SRA primitives (for custom deck operations):**

- `encrypt(value, key, prime)` — modular exponentiation `value^key mod prime`
- `decrypt(value, key, prime)` — same operation (SRA is commutative: encrypt = decrypt)
- `generateKeypair(prime)` — returns `{e, d}` such that `(e * d) ≡ 1 mod (prime-1)`
- `bigintToBase64(n)` — bigint to unpadded base64
- `base64ToBigint(s)` — base64 to bigint

**Deck functions:**

- `createInitialDeck(cardCount)` — creates `[2, 3, ..., cardCount+1]`
- `shuffleDeck(deck)` — Fisher-Yates shuffle
- `encryptDeck(deck, key, prime)` — applies `encrypt(card, key, prime)` to each card
- `hashDeck(deck)` — `taggedHash("urd-deck/v1", ...b64(cards))`
- `drawCard(deck)` — returns `{card, remaining}` (FIFO from front)
- `revealCard(ciphertext, keysD, prime)` — applies all `d` values to decrypt
- `createKeyCommitment(author, deckId, e, nonce)` — returns `KeyCommitment`
- `createDrawCommitment(deckId, player, ciphertext, nonce)` — returns `DrawCommitment`

**Deck verification functions and error messages:**

#### `verifyDeckDeclaration(decl)`

| Error message | When |
|---|---|
| `Deck must have at least 1 card` | `cardCount < 1` |
| `Deck must have at least one participant` | `participants` is empty |
| `Unsupported prime` | `prime` does not match the known safe prime |

#### `verifyDeckShuffle(event, inputDeckHash, deckKeyCommitments)`

| Error message | When |
|---|---|
| `Deck shuffle input hash does not match: expected ${expected}..., got ${actual}...` | `inputDeckHash` parameter does not match event's `inputDeckHash` |
| `Deck shuffle output is empty` | `outputDeck` has length 0 |
| `Duplicate ciphertext in shuffled deck: ${ct}...` | `outputDeck` contains the same ciphertext more than once |
| `No key commitment found for shuffle author ${author}` | `event.author` has no entry in `deckKeyCommitments` |
| `Key commitment mismatch for ${author}` | `event.keyCommitment` does not match the stored key commitment for this author |
| `Key commitment deckId mismatch for ${author}` | The stored key commitment has a different `deckId` than the shuffle event |

#### `verifyDraw(deck, drawCiphertext)`

| Error message | When |
|---|---|
| `Drawn ciphertext does not match front of deck` | `drawCiphertext` is not the first element of the current `deck` (FIFO enforcement) |

#### `verifyDrawCommitment(commit, ciphertext, player, nonce)`

| Error message | When |
|---|---|
| `Draw commitment does not match` | `taggedHash("urd-draw/v1", ciphertext, player, nonce)` does not equal `commit.commitment` |

#### `verifyKeyCommitment(commit, e, nonce)`

| Error message | When |
|---|---|
| `Key commitment does not match` | `taggedHash("urd-key/v1", b64(e), nonce)` does not equal `commit.commitment` |

#### `verifyCardReveal(reveal, deckKeyCommitments, prime)`

| Error message | When |
|---|---|
| (propagated from `verifyDrawCommitment`) | Draw commitment validation fails |
| `Card reveal must include at least one partial reveal` | `partials` is empty |
| `Partial reveal deckId mismatch for ${author}` | A partial's `deckId` does not match the reveal's `deckId` |
| `Partial reveal ciphertext does not match draw commitment` | A partial's `drawCiphertext` does not match the draw commitment's `ciphertext` |
| `Partial reveal input chain broken for ${author}` | A partial's `inputCiphertext` does not match the previous partial's `outputCiphertext` (or the draw ciphertext for the first partial) |
| `No key commitment found for ${author}` | The partial's `author` has no entry in `deckKeyCommitments` |
| `Key commitment does not match` | `verifyKeyCommitment` fails for the partial's `(e, nonce)` |
| `Invalid partial decryption for ${author}` | `outputCiphertext^e mod p` does not equal `inputCiphertext` — the participant did not correctly remove their encryption layer |
| `Revealed card ${result} does not match claimed card ${card}` | The final partial decryption output does not equal the claimed card value |

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
  pool is enforced naturally — you always consume from the front of the
  array. As a result, the same commitment fingerprint can never be used
  twice: once consumed, a second request for the same fingerprint will
  find it missing from the front of the pool and fail verification.
- **Delegated resolution**: `resolveRoll` is a pure computation. Anyone
  with the declaration and reveals can compute the result. This enables
  patterns like "I toss the die and you reveal it."
- **Secret entropy**: secrets must have sufficient entropy to prevent
  brute-force prediction of the fingerprint. The library takes secrets as
  arbitrary strings with no maximum length — use completely random strings
  (the longer the better). Generate from a CSPRNG: 32+ hex characters, a
  UUID, or an even longer passphrase. Multi-source rolls mitigate weak
  secrets because the attacker would need to brute-force *all* secrets
  simultaneously.
- **Maximum sides**: the protocol supports dice with up to 2^48
  (281,474,976,710,656) faces, defined as `MAX_SIDES` in the reference
  implementation.
- **SRA for shared decks**: commutative encryption (SRA) was chosen over
   cut-and-choose or ZK proofs because it enables private draws with a single
   message per participant per round. The verification model uses a
   *partial decryption chain*: each participant reveals only the result of
   decrypting a specific ciphertext (`partialDecrypt = input^d mod p`),
   which is verified by re-encrypting with the public key
   (`partialDecrypt^e mod p == input`). No private exponent `d` is ever
   disclosed — the remaining deck stays encrypted even after any number of
   public card reveals.
- **Offset by +2**: deck values start at 2 instead of 0 or 1 because `0^e ≡ 0`
   and `1^e ≡ 1` for any exponent. These fixed points would leak information
   about the card value through the ciphertext. Offsetting also eliminates the
   need to handle 0-values in the game logic (card 0 is unused).
- **Partial decryption chain**: participants decrypt a card sequentially in
   public `PartialReveal` events. Each reveal removes one layer of encryption
   and is independently verifiable via `output^e ≡ input (mod p)`. The chain
   is ordered: the first partial's input is the draw ciphertext, each
   subsequent partial's input is the previous partial's output, and the
   final output is the plaintext card value. This avoids exposing private keys
   while keeping verification simple — no ZK proofs needed.

### Repudiation

Events carry a `timestamp` that commits to a point in time. This opens
repudiation opportunities an honest player should avoid and a malicious one
may exploit:

| Opportunity | Risk | Mitigation |
|---|---|---|
| **Future timestamp** — player publishes a state with `timestamp` far in the future | If the game turns unfavorable, the player can claim their clock was wrong and repudiate the state as invalid | Use median of multiple observed timestamps; reject timestamps more than N hours ahead of reference time |
| **Late reveal** — player does not reveal for a requested secret within a reasonable window | The player can observe others' moves before deciding whether to reveal; if unfavorable, they can stay silent | Forfeit (loss of turn or game); the roll remains unresolved and the declarer can abort it |
| **Missing request** — no one requests a player's secret in time | A player could sit on their secret indefinitely | A timeout enforced by social consensus or transport policy; the secret expires if unused after N events |
| **Clock disagreement** — two observers see different timestamps for the same event | Ambiguity about which state is canonical and which timestamps to use in hash derivation | Use observed time (not event timestamp) for ordering; event timestamp is only used for hash binding |

In a proof-of-concept or small game, these risks are tolerable. A production
deployment should pick a concrete timeout (e.g., 7 days between challenge and
reveal) enforced by social consensus or transport policy.

### Known Limitations

- **Non-integer dice**: only integer-sided dice are supported (d2 through
  d2^48). Fudge/Fate dice or weighted outcomes must be mapped to integer
  ranges by the game client.
- **Browser compatibility**: the reference implementation currently uses
  Node.js `node:crypto`. Browsers have the Web Crypto API baked in
  (`crypto.subtle.digest("SHA-256", ...)`) which provides the same SHA-256
  primitive. A browser-compatible build is a matter of baking in the right
  dependency — not yet done.
- **Partial decryption chaining**: public card reveals require sequential
  `PartialReveal` events — each participant must see the previous partial
  before computing their own. This adds latency compared to the batch reveals
  used in the key-revelation design. For turn-based games the delay is
  acceptable; for real-time games it may be a constraint.

### Nostr Binding (Proposed)

URD was designed with Nostr in mind as a first-class transport — the protocol
is Nostr-optional, Nostr-encouraged. Below is a proposed event kind mapping
for Nostr-based games. Kind numbers are TBD pending NIP registration.

Proposed event kinds (range 31000-31099):
- Kind X: Game Definition (fingerprint pool + rules)
- Kind X+1: Join Game (add own pool, or replenish)
- Kind X+2: Game State (move + updated state)
- Kind X+3: Roll Declaration (intent to roll, names N secrets)
- Kind X+4: Secret Reveal (reveal a single secret for one fingerprint)
- Kind X+5: Roll Resolution (computed result, published by declarer or delegate)
- Kind X+6: Deck Declaration (deck creation with prime, participants, card count)
- Kind X+7: Deck Shuffle (shuffle + encrypt step by one participant)
- Kind X+8: Key Commitment (public key commitment for a deck)
- Kind X+9: Draw Commitment (ciphertext drawn from deck)
- Kind X+10: Card Reveal (public reveal of a drawn card with partial keys)

Relevant tags:
- `e`: parent event reference (state chain)
- `p`: participant pubkeys
- `fingerprint`: `taggedHash("urd-commit/v1", seed, author, seqId, secret)` (hex)
- `seq_id`: sequence number within an author's secret pool (integer)
- `roll`: dice type and result (e.g., "d20:15")
- `deck`: deck identifier (string)
- `draw`: draw commitment hash (hex)
- `card`: the claimed card value (integer)

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
   - [x] Shared hidden decks via SRA commutative encryption (`DeckDeclaration`,
     `DeckShuffle`, `DrawCommitment`, `PartialReveal`, `CardReveal`,
     `verifyDeckShuffle`, `verifyDeckDeclaration`, `verifyDraw`,
     `verifyDrawCommitment`, `verifyKeyCommitment`, `verifyCardReveal`)
3. Articulate with [Vesta](https://github.com/fchurca/vesta) as a
   work-in-progress demonstrator — a decentralized settlement-building
   board game built on URD
4. Formal protocol specification / whitepaper
5. ???
