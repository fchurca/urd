import { describe, it } from "node:test";
import { equal, ok, throws, doesNotThrow } from "node:assert/strict";
import {
  DECK_SAFE_PRIME,
  generateKeypair,
  encrypt,
  decrypt,
  bigintToBase64,
  base64ToBigint,
} from "./sra.ts";
import {
  createInitialDeck,
  shuffleDeck,
  encryptDeck,
  hashDeck,
  verifyDeckShuffle,
  verifyDeckDeclaration,
  drawCard,
  verifyDraw,
  createDrawCommitment,
  verifyDrawCommitment,
  createKeyCommitment,
  verifyKeyCommitment,
  revealCard,
  verifyCardReveal,
} from "./deck.ts";
import type {
  DeckShuffle,
  DeckDeclaration,
  DrawCommitment,
  PartialReveal,
  CardReveal,
  KeyCommitment,
} from "./deck.ts";

const p = DECK_SAFE_PRIME;

describe("Deck creation", () => {
  it("creates an initial deck of 52 cards", () => {
    const deck = createInitialDeck();
    equal(deck.length, 52);
    equal(deck[0], 2n);
    equal(deck[51], 53n);
  });

  it("creates a custom-sized deck", () => {
    const deck = createInitialDeck(10);
    equal(deck.length, 10);
    equal(deck[9], 11n);
  });

  it("shuffleDeck preserves all elements", () => {
    const deck = createInitialDeck(52);
    const shuffled = shuffleDeck(deck);
    equal(shuffled.length, 52);
    const sorted = [...shuffled].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    equal(sorted[0], 2n);
    equal(sorted[51], 53n);
  });

  it("shuffleDeck changes order (probabilistic)", () => {
    const deck = createInitialDeck(52);
    const s1 = shuffleDeck(deck);
    const s2 = shuffleDeck(deck);
    const s3 = shuffleDeck(deck);
    const allSame = s1.every((v, i) => v === s2[i]) && s2.every((v, i) => v === s3[i]);
    ok(!allSame);
  });

  it("hashDeck is consistent for same deck", () => {
    const deck = createInitialDeck(52);
    equal(hashDeck(deck), hashDeck(deck));
  });

  it("hashDeck differs for different decks", () => {
    const a = createInitialDeck(52);
    const b = shuffleDeck(a);
    ok(hashDeck(a) !== hashDeck(b));
  });

  it("verifyDeckDeclaration accepts a valid declaration", () => {
    const decl: DeckDeclaration = {
      deckId: "test-deck",
      prime: bigintToBase64(p),
      participants: ["alice", "bob"],
      cardCount: 52,
    };
    doesNotThrow(() => verifyDeckDeclaration(decl));
  });

  it("verifyDeckDeclaration rejects empty participants", () => {
    const decl: DeckDeclaration = {
      deckId: "test-deck",
      prime: bigintToBase64(p),
      participants: [],
      cardCount: 52,
    };
    throws(() => verifyDeckDeclaration(decl));
  });

  it("verifyDeckDeclaration rejects zero cards", () => {
    const decl: DeckDeclaration = {
      deckId: "test-deck",
      prime: bigintToBase64(p),
      participants: ["alice"],
      cardCount: 0,
    };
    throws(() => verifyDeckDeclaration(decl));
  });

  it("verifyDeckDeclaration rejects unsupported prime", () => {
    const decl: DeckDeclaration = {
      deckId: "test-deck",
      prime: bigintToBase64(7n),
      participants: ["alice"],
      cardCount: 10,
    };
    throws(() => verifyDeckDeclaration(decl));
  });

  it("verifyDeckShuffle rejects shuffle with missing key commitment", () => {
    const deckId = "test-deck";
    const emptyMap = new Map<string, KeyCommitment>();
    const event: DeckShuffle = {
      deckId,
      author: "mallory",
      inputDeckHash: "",
      outputDeck: ["abc"],
      keyCommitment: "nonexistent",
    };
    throws(() => verifyDeckShuffle(event, "", emptyMap));
  });

  it("verifyDeckShuffle rejects wrong input hash", () => {
    const deckId = "test-deck";
    const kc: KeyCommitment = { author: "alice", deckId, commitment: "c1" };
    const map = new Map<string, KeyCommitment>([["alice", kc]]);
    const event: DeckShuffle = {
      deckId,
      author: "alice",
      inputDeckHash: "abc",
      outputDeck: ["x"],
      keyCommitment: "c1",
    };
    throws(() => verifyDeckShuffle(event, "def", map));
  });

  it("verifyDeckShuffle rejects empty output deck", () => {
    const deckId = "test-deck";
    const kc: KeyCommitment = { author: "alice", deckId, commitment: "c1" };
    const map = new Map<string, KeyCommitment>([["alice", kc]]);
    const event: DeckShuffle = {
      deckId,
      author: "alice",
      inputDeckHash: "",
      outputDeck: [],
      keyCommitment: "c1",
    };
    throws(() => verifyDeckShuffle(event, "", map));
  });

  it("verifyDeckShuffle rejects duplicate ciphertexts", () => {
    const deckId = "test-deck";
    const kc: KeyCommitment = { author: "alice", deckId, commitment: "c1" };
    const map = new Map<string, KeyCommitment>([["alice", kc]]);
    const event: DeckShuffle = {
      deckId,
      author: "alice",
      inputDeckHash: "",
      outputDeck: ["a", "a"],
      keyCommitment: "c1",
    };
    throws(() => verifyDeckShuffle(event, "", map));
  });

  it("verifyDeckShuffle rejects key commitment mismatch", () => {
    const deckId = "test-deck";
    const kc: KeyCommitment = { author: "alice", deckId, commitment: "real-commitment" };
    const map = new Map<string, KeyCommitment>([["alice", kc]]);
    const event: DeckShuffle = {
      deckId,
      author: "alice",
      inputDeckHash: "",
      outputDeck: ["x"],
      keyCommitment: "fake-commitment",
    };
    throws(() => verifyDeckShuffle(event, "", map));
  });

  it("verifyDeckShuffle rejects deckId mismatch", () => {
    const kc: KeyCommitment = { author: "alice", deckId: "deck-a", commitment: "c1" };
    const map = new Map<string, KeyCommitment>([["alice", kc]]);
    const event: DeckShuffle = {
      deckId: "deck-b",
      author: "alice",
      inputDeckHash: "",
      outputDeck: ["x"],
      keyCommitment: "c1",
    };
    throws(() => verifyDeckShuffle(event, "", map));
  });
});

describe("Other verifier rejections", () => {
  it("verifyDraw rejects card not at front", () => {
    throws(() => verifyDraw(["a", "b", "c"], "b"));
  });

  it("verifyKeyCommitment rejects wrong nonce", () => {
    const kc = createKeyCommitment("alice", "d1", 3n, "real-nonce");
    throws(() => verifyKeyCommitment(kc, 3n, "wrong-nonce"));
  });

  it("verifyCardReveal rejects empty partials", () => {
    const drawCommit: DrawCommitment = { deckId: "d1", player: "alice", ciphertext: "x", nonce: "n", commitment: "ignored" };
    const reveal: CardReveal = { deckId: "d1", drawCommitment: drawCommit, card: 5, partials: [] };
    throws(() => verifyCardReveal(reveal, new Map(), p));
  });

  it("verifyCardReveal rejects partial reveal deckId mismatch", () => {
    const drawCommit: DrawCommitment = { deckId: "d1", player: "alice", ciphertext: "x", nonce: "n", commitment: "ignored" };
    const partials: PartialReveal[] = [{ deckId: "d2", drawCiphertext: "x", author: "alice", e: bigintToBase64(3n), inputCiphertext: "x", outputCiphertext: "y", nonce: "n" }];
    const reveal: CardReveal = { deckId: "d1", drawCommitment: drawCommit, card: 5, partials };
    throws(() => verifyCardReveal(reveal, new Map(), p));
  });
});

describe("3-party deck creation", () => {
  function createPartyDeck(): { deck: bigint[]; keyCommitments: Map<string, KeyCommitment>; keypairs: Map<string, { e: bigint; d: bigint }>; nonces: Map<string, string> } {
    const players = ["alice", "bob", "carol"];
    const keypairs = new Map<string, { e: bigint; d: bigint }>();
    const keyCommitments = new Map<string, KeyCommitment>();
    const nonces = new Map<string, string>();
    const deckId = "deck-1";

    for (const player of players) {
      const kp = generateKeypair(p);
      keypairs.set(player, kp);
      const nonce = Math.random().toString(36).slice(2);
      nonces.set(player, nonce);
      const kc = createKeyCommitment(player, deckId, kp.e, nonce);
      keyCommitments.set(player, kc);
    }

    let currentDeck = createInitialDeck(52);
    let prevHash = "";

    for (const player of players) {
      const kp = keypairs.get(player)!;
      currentDeck = shuffleDeck(currentDeck);
      currentDeck = encryptDeck(currentDeck, kp.e, p);
      const deckHash = hashDeck(currentDeck);
      const event: DeckShuffle = {
        deckId,
        author: player,
        inputDeckHash: prevHash,
        outputDeck: currentDeck.map(c => bigintToBase64(c)),
        keyCommitment: keyCommitments.get(player)!.commitment,
      };
      if (prevHash !== "") doesNotThrow(() => verifyDeckShuffle(event, prevHash, keyCommitments));
      prevHash = deckHash;
    }

    return { deck: currentDeck, keyCommitments, keypairs, nonces };
  }

  it("creates a deck encrypted under 3 keys", () => {
    const { deck } = createPartyDeck();
    equal(deck.length, 52);
    const allEncrypted = deck.every(c => c > 53n);
    ok(allEncrypted);
  });

  it("full decrypt yields [2..53]", () => {
    const { deck, keypairs } = createPartyDeck();
    const players = ["alice", "bob", "carol"];
    const decrypted = deck.map(c => {
      let result = c;
      for (const player of players) {
        const kp = keypairs.get(player)!;
        result = decrypt(result, kp.d, p);
      }
      return result;
    });
    const sorted = [...decrypted].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    for (let i = 0; i < 52; i++) equal(sorted[i], BigInt(i + 2));
  });
});

describe("Draw and reveal one card", () => {
  it("draws from the front of the deck", () => {
    const deck = createInitialDeck(10);
    const { card, remaining } = drawCard(deck);
    equal(card, 2n);
    equal(remaining.length, 9);
    equal(remaining[0], 3n);
  });

  it("cannot draw from an empty deck", () => {
    throws(() => drawCard([]));
  });

  it("draw commitment is verifiable", () => {
    const commit = createDrawCommitment("d1", "alice", "base64data", "nonce123");
    doesNotThrow(() => verifyDrawCommitment(commit, "base64data", "alice", "nonce123"));
  });

  it("draw commitment rejects wrong nonce", () => {
    const commit = createDrawCommitment("d1", "alice", "base64data", "nonce123");
    throws(() => verifyDrawCommitment(commit, "base64data", "alice", "wrong-nonce"));
  });

  it("end-to-end: draw and reveal one card", () => {
    const players = ["alice", "bob", "carol"];
    const keypairs = new Map<string, { e: bigint; d: bigint }>();
    const keyCommitments = new Map<string, KeyCommitment>();
    const deckId = "deck-2";
    const nonces = new Map<string, string>();

    // Setup: 3-party deck creation
    for (const player of players) {
      const kp = generateKeypair(p);
      keypairs.set(player, kp);
      const nonce = Math.random().toString(36).slice(2);
      nonces.set(player, nonce);
      const kc = createKeyCommitment(player, deckId, kp.e, nonce);
      keyCommitments.set(player, kc);
    }

    let currentDeck = createInitialDeck(52);
    let prevHash = "";
    for (const player of players) {
      const kp = keypairs.get(player)!;
      currentDeck = shuffleDeck(currentDeck);
      currentDeck = encryptDeck(currentDeck, kp.e, p);
      const deckHash = hashDeck(currentDeck);
      const event: DeckShuffle = {
        deckId,
        author: player,
        inputDeckHash: prevHash,
        outputDeck: currentDeck.map(c => bigintToBase64(c)),
        keyCommitment: keyCommitments.get(player)!.commitment,
      };
      if (prevHash !== "") doesNotThrow(() => verifyDeckShuffle(event, prevHash, keyCommitments));
      prevHash = deckHash;
    }

    // Alice draws the first card
    const { card: drawnCiphertext, remaining } = drawCard(currentDeck);
    const ctB64 = bigintToBase64(drawnCiphertext);
    const drawNonce = Math.random().toString(36).slice(2);
    const drawCommit = createDrawCommitment(deckId, "alice", ctB64, drawNonce);

    // Verify draw
    doesNotThrow(() => verifyDraw(currentDeck.map(c => bigintToBase64(c)), ctB64));

    // PartialReveal uses the same nonce as the KeyCommitment
    const partialReveals: PartialReveal[] = [];
    let current = ctB64;
    for (const player of players) {
      const kp = keypairs.get(player)!;
      const input = current;
      const output = bigintToBase64(decrypt(base64ToBigint(input), kp.d, p));
      const pr: PartialReveal = {
        deckId,
        drawCiphertext: ctB64,
        author: player,
        e: bigintToBase64(kp.e),
        inputCiphertext: input,
        outputCiphertext: output,
        nonce: nonces.get(player)!,
      };
      partialReveals.push(pr);
      current = output;
    }

    // Alice applies all d values to learn the card
    const allD = players.map(player => keypairs.get(player)!.d);
    const revealedCard = revealCard(drawnCiphertext, allD, p);
    ok(revealedCard >= 2n && revealedCard <= 53n, `Card ${revealedCard} out of range`);

    // Alice publishes CardReveal
    const cardReveal: CardReveal = {
      deckId,
      drawCommitment: drawCommit,
      card: Number(revealedCard),
      partials: partialReveals,
    };

    // Verifier checks
    doesNotThrow(() => verifyCardReveal(cardReveal, keyCommitments, p));
  });

  it("verifyCardReveal rejects wrong claimed card", () => {
    const players = ["alice", "bob"];
    const keypairs = new Map<string, { e: bigint; d: bigint }>();
    const keyCommitments = new Map<string, KeyCommitment>();
    const deckId = "deck-3";
    const nonces = new Map<string, string>();

    for (const player of players) {
      const kp = generateKeypair(p);
      keypairs.set(player, kp);
      const nonce = Math.random().toString(36).slice(2);
      nonces.set(player, nonce);
      const kc = createKeyCommitment(player, deckId, kp.e, nonce);
      keyCommitments.set(player, kc);
    }

    let currentDeck = createInitialDeck(10);
    let prevHash = "";
    for (const player of players) {
      const kp = keypairs.get(player)!;
      currentDeck = shuffleDeck(currentDeck);
      currentDeck = encryptDeck(currentDeck, kp.e, p);
      const deckHash = hashDeck(currentDeck);
      const event: DeckShuffle = {
        deckId,
        author: player,
        inputDeckHash: prevHash,
        outputDeck: currentDeck.map(c => bigintToBase64(c)),
        keyCommitment: keyCommitments.get(player)!.commitment,
      };
      if (prevHash !== "") doesNotThrow(() => verifyDeckShuffle(event, prevHash, keyCommitments));
      prevHash = deckHash;
    }

    const { card: drawnCiphertext } = drawCard(currentDeck);
    const ctB64 = bigintToBase64(drawnCiphertext);
    const drawNonce = Math.random().toString(36).slice(2);
    const drawCommit = createDrawCommitment(deckId, "alice", ctB64, drawNonce);

    const partialReveals: PartialReveal[] = [];
    let current = ctB64;
    for (const player of players) {
      const kp = keypairs.get(player)!;
      const input = current;
      const output = bigintToBase64(decrypt(base64ToBigint(input), kp.d, p));
      partialReveals.push({
        deckId,
        drawCiphertext: ctB64,
        author: player,
        e: bigintToBase64(kp.e),
        inputCiphertext: input,
        outputCiphertext: output,
        nonce: nonces.get(player)!,
      });
      current = output;
    }

    const badReveal: CardReveal = {
      deckId,
      drawCommitment: drawCommit,
      card: 999,
      partials: partialReveals,
    };

    throws(() => verifyCardReveal(badReveal, keyCommitments, p));
  });
});

describe("Draw and reveal entire deck", () => {
  it("multiple players draw and reveal all cards", () => {
    const drawPlayers = ["alice", "bob", "carol"];
    const deckPlayers = ["alice", "bob", "carol"];
    const keypairs = new Map<string, { e: bigint; d: bigint }>();
    const keyCommitments = new Map<string, KeyCommitment>();
    const deckId = "deck-full";
    const nonces = new Map<string, string>();

    for (const player of deckPlayers) {
      const kp = generateKeypair(p);
      keypairs.set(player, kp);
      const nonce = Math.random().toString(36).slice(2);
      nonces.set(player, nonce);
      const kc = createKeyCommitment(player, deckId, kp.e, nonce);
      keyCommitments.set(player, kc);
    }

    let currentDeck = createInitialDeck(52);
    let prevHash = "";
    for (const player of deckPlayers) {
      const kp = keypairs.get(player)!;
      currentDeck = shuffleDeck(currentDeck);
      currentDeck = encryptDeck(currentDeck, kp.e, p);
      const deckHash = hashDeck(currentDeck);
      const event: DeckShuffle = {
        deckId,
        author: player,
        inputDeckHash: prevHash,
        outputDeck: currentDeck.map(c => bigintToBase64(c)),
        keyCommitment: keyCommitments.get(player)!.commitment,
      };
      if (prevHash !== "") doesNotThrow(() => verifyDeckShuffle(event, prevHash, keyCommitments));
      prevHash = deckHash;
    }

    const allReveals: CardReveal[] = [];
    const deckStr = currentDeck.map(c => bigintToBase64(c));

    for (let i = 0; i < 52; i++) {
      const cardCiphertext = currentDeck[0]!;
      currentDeck = currentDeck.slice(1);
      const ctB64 = bigintToBase64(cardCiphertext);

      const drawer = drawPlayers[i % drawPlayers.length]!;

      doesNotThrow(() => verifyDraw(deckStr.slice(i), ctB64));

      const drawNonce = Math.random().toString(36).slice(2);
      const drawCommit = createDrawCommitment(deckId, drawer, ctB64, drawNonce);

      const partialReveals: PartialReveal[] = [];
      let current = ctB64;
      for (const player of deckPlayers) {
        const kp = keypairs.get(player)!;
        const input = current;
        const output = bigintToBase64(decrypt(base64ToBigint(input), kp.d, p));
        partialReveals.push({
          deckId,
          drawCiphertext: ctB64,
          author: player,
          e: bigintToBase64(kp.e),
          inputCiphertext: input,
          outputCiphertext: output,
          nonce: nonces.get(player)!,
        });
        current = output;
      }

      const allD = deckPlayers.map(player => keypairs.get(player)!.d);
      const cardValue = revealCard(cardCiphertext, allD, p);

      const cardReveal: CardReveal = {
        deckId,
        drawCommitment: drawCommit,
        card: Number(cardValue),
        partials: partialReveals,
      };

      doesNotThrow(() => verifyCardReveal(cardReveal, keyCommitments, p));
      allReveals.push(cardReveal);
    }

    equal(allReveals.length, 52);
    const allCards = allReveals.map(r => r.card).sort((a, b) => a - b);
    for (let i = 0; i < 52; i++) equal(allCards[i], i + 2);
  });
});
