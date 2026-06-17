# URD: URD's Roll Derivation

A Verifiable Randomness Protocol for Decentralized "Play-by-Nostr" Games

**Status:** proof-of-concept — state chain, secret pool, roll derivation, and
challenge/reveal mechanism implemented. Nostr bindings and demo client are
planned but not yet built.

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
- **Farm-resistant**: a player cannot choose whether to keep or discard a result
- **Identity via pubkey**: uses existing Nostr keys for signing and authentication

## Proposed Design

### Components

1. **Pre-committed secret pool**: each player publishes an ordered list of
   fingerprints at game start. Each commitment is a closed secret published
   as `(author, seq_id, fingerprint)` where `fingerprint = hash(author + seq_id + secret)`.
   The initial pool can be as small as one fingerprint; new fingerprints are
   appended during each reveal (with incremented `seq_id`).

2. **Game state chain**: linked Nostr events where each state references the
   previous one (event `e` tag)

3. **Roll derivation**: `roll = hash(state_hash, secret)` mapped to the
   requested range (e.g., 1–20 for a d20) — deterministic derivation from
   state + revealed secret

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
- derived result: `hash(state, secret)` mapped to the requested range

Anyone verifies:
- `hash(author + seq_id + secret) == fingerprint` (initial commitment holds)
- `hash(state, secret)` produces the claimed result
- new fingerprint is appended at end of A's pool with correct `seq_id`

If A does not reveal within a reasonable time: forfeit (inactivity).

**Hidden information**: the same challenge-reveal mechanism serves private
draws (e.g., a hand of cards). A player can ask a peer to reveal a secret
and consume it for their own hidden state. The derived roll is public, but
its mapping to game state (which card was drawn, etc.) stays known only to
the player until later revealed. No extra encryption is needed.

### Security Properties

- **No farming**: the fingerprint determines which secret to use; you cannot
  choose which secret to reveal or discard an unfavorable result
- **No prediction**: the game state is unknown until published, and the secret
  is unknown until revealed
- **One-shot commitment**: the fingerprint pool is published before any game
  state exists; no fingerprints can be altered or reordered mid-game.
  Fingerprints can be appended for later rolls
- **Public verifiability**: any observer with the event chain can replay and
  verify every result

### Design Decisions

- **Witness relays**: the protocol is fully peer-to-peer by default. Optional
  witness relays can accelerate challenge notification, but the protocol does
  not depend on them.

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
- `fingerprint`: SHA256 hash of `(author + seq_id + secret)` (hex)
- `seq_id`: sequence number within an author's secret pool (integer)
- `roll`: dice type and result (e.g., "d20:15")

### Open Questions

1. Penalty for not revealing on time? Auto-forfeit after N events?
   What if the challenger also disappears?

## Tasks

1. Formalize the protocol in a whitepaper / specification document
2. Implement a reference library in TypeScript (core functions: hashing,
   dice derivation, verification)
   - [x] State chain types and creation (`GameState`, `createGenesisState`,
     `createNextState`)
   - [x] Chain verification (`verifyChain`)
   - [x] Secret types and commitment (`ClosedSecret`, `OpenSecret`,
     `createClosedSecret`, `openSecret`, `verifyOpenSecret`)
   - [x] Roll derivation (`deriveRoll`)
    - [x] Challenge / reveal mechanism (`SecretPoolState`, `createPool`,
      `nextChallenge`, `revealSecret`, `verifyReveal`)
3. Build a browser-only demo client that plays a simple game
   (e.g., D&D ability check) over a Nostr test relay; the server is
   just a static file server, no backend logic
4. Write security tests:
   - Verify farming is impossible (same secrets -> same result)
   - Verify secrets cannot be reused
   - Verify results are deterministic wrt game state
5. (future)
