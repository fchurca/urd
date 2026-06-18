# EVALUATOR.md — URD Protocol Evaluation Framework

A reusable methodology and prompt for evaluating the URD protocol. Designed
to produce thorough, actionable evaluations that identify gaps between claims
and reality. Inspired by the first evaluation (`URD_Evaluation.md`).

## Inputs Required

- `README.md` — protocol specification
- `PITCH.md` — marketing / summary
- `AGENTS.md` — conventions
- `src/index.ts` — implementation
- `src/index.test.ts` — test suite

Optional: prior evaluations, Nostr NIPs, or outputs from past review cycles.

## Methodology

### Step 1 — Strip to Mechanism

Describe the protocol in 3-4 sentences as it actually works, without
marketing framing. No "trustless", "no farming", "shared-nothing" —
just: what data flows, who sends what, what gets computed.

### Step 2 — Map Claims to Reality

For every headline claim in `README.md` and `PITCH.md`:

1. Quote the claim verbatim.
2. Find the code that implements (or fails to implement) it.
3. State whether it holds, partially holds, or fails — and why.

Do not conflate "this sub-mechanism is cryptographically sound" with
"the system achieves its advertised property." They are different
questions.

### Step 3 — Audience-Fit Analysis

Identify the actual target user (explicitly named or implied). Assess
whether the protocol's real strengths and real weaknesses align with
that user's incentives. Include a three-way split:

- **Good fit** — scenarios where the protocol as-built adds value
- **Irrelevant / unnecessary** — scenarios where simpler primitives
  dominate
- **Bad fit / harmful** — scenarios where the protocol actively
  misleads or creates risk

### Step 4 — Security Walkthrough

Work through each cryptographic property independently:

- Commitment binding
- Dice derivation uniformity
- Bias resistance (farming, grinding, abort)
- Prediction resistance
- Collision / domain separation hygiene
- Consensus / equivocation

For each property: what the spec claims, what the code does, what
an attacker with the listed resources can achieve.

### Step 5 — Prescriptive Output

- For every flaw: exactly **3 concrete fixes**, ordered by impact.
- For every strength: exactly **3 concrete improvements**.
- Each fix must be implementable, not aspirational. Prefer fixes that
  touch only code over fixes that require new infrastructure.

## Output Format

Every evaluation MUST follow this structure. Deviations require
explanation in a preamble.

### TL;DR Verdict

One paragraph summary. One table:

| Dimension | Assessment |
|---|---|
| Engineering quality | Strong / Adequate / Weak |
| Dice derivation (uniformity) | Correct / Incorrect |
| Commitment binding | Sound / Broken |
| Bias-resistance / "no farming" | Holds / Partial / Broken |
| Consensus / fork resistance | Addressed / Partial / Not addressed |
| Fit for marketed use case | Good / Adequate / Poor |
| Fit for actual best use case | Good / Adequate / Poor |
| Ready for value / money at stake | Yes / No |

### 1. What It Actually Is

Neutral mechanism description, 3-4 sentences. No marketing language.

### 2. Does the Crypto Hold?

Subsections, one per claim. Each subsection:

> **Claim:** (verbatim from README or PITCH)
>
> **Reality:** (what the code actually enforces)
>
> **Verdict:** ✅ / ⚠️ / ❌

Include mermaid or ASCII diagrams for attack flows (grinding,
equivocation, abort). Include inline code references
(`src/index.ts:NN`).

### 3. Where This Fits (and Doesn't)

Three subsections: **Good fit** / **Irrelevant / unnecessary** /
**Bad fit / actively harmful**. Each subsection is a bullet list with
one sentence per scenario.

### 4. Good Ideas — Each with 3 Improvements

Label each as **✅ GOOD:** *name*. Three numbered sub-items, each a
concrete change. Prefer small changes over large ones.

### 5. Mistakes — Each with 3 Fixes

Label each as **❌ MISTAKE:** *name*. Three numbered sub-items, each a
concrete fix. Prefer code-level fixes. If the fix is architectural
(e.g. multi-source randomness), say so explicitly.

### 6. Bottom Line

Two or three paths forward. Each path names the tradeoff (e.g.
"reframe: cheap, honest" vs "fix core: more work, stronger"). Include
a clear **do not ship** warning if money is at stake and the protocol
isn't ready.

## Quality Checklist

- [ ] Every headline claim from README and PITCH is addressed
- [ ] Every critique has a concrete fix (not just "this is bad")
- [ ] No rhetorical questions or hand-waving
- [ ] Code references include file path and line numbers
- [ ] Attack flows include a diagram (mermaid or ASCII)
- [ ] The evaluation is reproducible — another evaluator reading the
      same inputs reaches the same conclusions
- [ ] The verdict includes whether the protocol is ready for
      value / money at stake
- [ ] Strengths and weaknesses are balanced: weaknesses outnumber
      strengths only if the protocol genuinely has more flaws

## License for Outputs

Evaluations produced with this framework are project-internal analysis
artifacts. They are prescriptive, not authoritative. They document an
independent reviewer's assessment at a point in time.
