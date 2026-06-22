# URD 🔮 (URD's Roll Derivation): Verifiable Dice for Nostr Games

## 30-Second Pitch

A cryptographic protocol that lets players roll dice over Nostr with publicly
verifiable commitments — no server, no blockchain, no "trust me bro." Each
player pre-commits to hashed secrets. To roll, a player declares which N
secrets (their own or others') feed the result. Once all secrets are revealed,
anyone resolves the roll: `taggedHash("urd-roll/v1", b64(gameHash) + ":" + b64(s1) + ":" + ...)`.
Deterministic, publicly verifiable, delegated. Fully async, shared-nothing,
identity via Nostr keys. Now in proof-of-concept.

## 3-Minute Pitch

### The Problem

You're playing a settlement-building board game over Nostr with friends. You
need to roll for resources. Who generates the random number? If you roll,
nobody trusts the result. If the host rolls, nobody trusts the host.
Provably-fair casino schemes need a central server. On-chain commit-reveal
needs blocks and sync timing. VRFs need external infrastructure.

For peer-to-peer tabletop gaming, there is no simple, async, shared-nothing
way to get verifiable randomness.

At a physical table, trust in randomness is shared: you prepare the dice cup,
another player rolls, and everyone sees the result. URD replicates this
interaction digitally — lock in a pool of secrets, let anyone nominate which
ones feed the roll, and derive the outcome from all of them.

### The Solution

URD (URD's Roll Derivation) is a minimal protocol built on three ideas:

1. **Pre-committed secrets**: each player publishes a pool of `ClosedSecret`
   fingerprints `(author, seq_id, seed, fingerprint)` where
   `fingerprint = taggedHash("urd-commit/v1", seed, author, seqId, secret)`. New commitments can
   be appended at any time.
2. **Roll declaration**: a player publishes a `RollDeclaration` naming the
   game state hash and which fingerprints (from any player's pool) will feed
   the roll. Anyone can request any existing fingerprint.
3. **Multi-secret derivation**: once all named secrets are revealed, the
   roll is `taggedHash("urd-roll/v1", b64(gameHash) + ":" + b64(s1) + ":" + ...)` with rejection
   sampling — deterministic given the state, unpredictable until all secrets
   are known. With N≥2 independent parties, no single party can predict or
   abort-bias the outcome.

The result: fully asynchronous, zero infrastructure, publicly verifiable
randomness over Nostr. Secrets are consumed by fingerprint, not position —
revelations can arrive in any order. Resolution can be delegated.

### Why Now

Nostr is growing as a social/gaming substrate. Relay-as-a-service (Strfry,
etc.) makes running an infra node trivial. What's missing is the
cryptographic primitives for trustless games. URD fills that gap.

### Status

Proof-of-concept. Core types implemented: state chain (reverse-linked list
with SHA-256 integrity), secret commitment (`ClosedSecret` / `OpenSecret`
with per-author sequence numbers), multi-secret roll derivation with
rejection sampling, roll declaration/reveal/resolution mechanism, and
hierarchical verification. Protocol specification and Nostr event kinds
being formalized.
