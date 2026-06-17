# URD (URD's Roll Derivation): Verifiable Dice for Nostr Games

## 30-Second Pitch

A cryptographic protocol that lets strangers roll dice over Nostr without
trusting each other — no server, no blockchain, no "trust me bro." Each
player pre-commits to hashed secrets. To roll, a peer challenges you to
reveal the next secret in line. The result is `hash(game_state, secret)`,
deterministic and publicly verifiable. Fully async, shared-nothing,
identity via Nostr keys. Now in proof-of-concept.

## 3-Minute Pitch

### The Problem

You're playing D&D over Nostr with friends. You need to roll a skill check.
Who generates the random number? If you roll, nobody trusts the result. If
the DM rolls, nobody trusts the DM. Provably-fair casino schemes need a
central server. On-chain commit-reveal needs blocks and sync timing. VRFs
need external infrastructure.

For peer-to-peer tabletop gaming, there is no simple, async, shared-nothing
way to get verifiable randomness.

At a physical table, trust is built by sharing custody: you shuffle the
deck, another player cuts it, and everyone takes turns dealing. URD
replicates this interaction digitally — lock in a shuffled pool of secrets,
let a peer cut by selecting which one to reveal, and deal the result using
the public game state.

### The Solution

URD (URD's Roll Derivation) is a minimal protocol built on three ideas:

1. **Pre-committed secrets**: before the game starts, each player publishes
   a list of closed secrets `(author, seq_id, fingerprint)` where
   `fingerprint = hash(author + seq_id + secret)`. This locks in their
   randomness without revealing it.
2. **State-anchored derivation**: a roll is `hash(game_state, secret)` —
   deterministic given the state, unpredictable until both are known.
3. **FIFO consumption with challenges**: secrets are consumed in order by
   ascending `seq_id`. Any player can demand a reveal by citing the next
   unused fingerprint from your pool. You cannot cherry-pick which secret
   to reveal.

The result: fully asynchronous, zero infrastructure, publicly verifiable
randomness over Nostr.

### Why Now

Nostr is growing as a social/gaming substrate. Relay-as-a-service (Strfry,
etc.) makes running an infra node trivial. What's missing is the
cryptographic primitives for trustless games. URD fills that gap.

### Status

Proof-of-concept. Core types implemented: state chain (reverse-linked list
with SHA-256 integrity), secret commitment (`ClosedSecret` / `OpenSecret`
with per-author sequence numbers), roll derivation, and challenge/reveal
mechanism with FIFO pool consumption and replenish. Protocol specification
and Nostr event kinds being formalized.
