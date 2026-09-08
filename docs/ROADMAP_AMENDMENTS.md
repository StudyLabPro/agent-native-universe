# Roadmap amendments

The development plan (revision 2: phases P−1 … P10) is the owner's document
and lives outside this repository. This file records the amendments that the
Genesis-Live design (phases L0 … L9) requires of it, with the evidence in code
for each. Amendments need the owner's confirmation; none of them is applied by
merging this file. No calendar units appear here: every item is described by
dependencies, reversibility and a verifiable completion criterion.

## A1 — P0 "subtract": quarantine, not deletion, for the v2 cognitive loop and persistent market

**Premise in the plan:** `src/v2/persistent-market.ts` and
`src/v2/cognitive-loop.ts` duplicate the live v1 `economy-llm` and can be
deleted with the rest of P0.

**The premise is false.** In code:

- `src/v1/economy-llm.ts` holds `ResourceLedger` — an in-memory ledger without
  reserve/settle or persistence — plus the `LlmRouter`/`OpenAICompatibleProvider`
  adapters. There is no cognitive loop and no scheduler in v1.
- `src/lab/runner.ts` imports only `LlmRouter` and `OpenAICompatibleProvider`
  from v1; the lab does not depend on the v2 loop or market either.
- `experiments/mws-kimi/verify.mjs` and `test/autonomous-runtime.test.mjs`
  exercise `PersistentResourceEconomy`, `MeteredCognitiveLoop` and
  `CognitiveScheduler`; deleting them removes verified behaviour, not a
  duplicate.

**Amendment.** P0 treats `src/v2/cognitive-loop.ts`, `src/v2/persistent-market.ts`
and `src/v2/types.ts` as **quarantined**:

1. excluded from the Genesis-Live import graph — `src/lab/live/**` may not
   import `src/v2/*` (enforced by `npm run check:live-isolation`);
2. kept with their tests;
3. no longer documented as the recommended path in the `./autonomous` import
   surface (README notes the quarantine).

The decision "delete or keep" returns to the owner with the true premise.
Genesis-Live does not depend on the outcome. Reversible.

**Completion criterion:** `check:live-isolation` green; README Imports section
carries the quarantine note; the plan's P0 text names the three files as
quarantined.

## A2 — The remaining P0 deletions stand

`distributed-discovery`, `network-consensus`, `autonomous-node`,
`metaagent-controller` and the v1 WAL/quorum modules are deleted as planned.
Genesis-Live uses none of them. Irreversible once merged; needs the owner's
confirmation on the P0 pull request itself.

## A3 — Documentation drift fixed in the same commit

`docs/NETWORK_BFT.md` described `NetworkBftGraphNode` and a persisted
`certificates.jsonl` with a `bft.sync.request/response` catch-up, none of which
exists in `src/` (the class is `NetworkByzantineNode`; certificates reach the
embedding through `applyCommit` and are not persisted by the node; there is no
sync protocol). The document now describes what the code does. Reversible.

## A4 — Ablation clause

Add to the plan's ablation clause: **"Genesis-Live is an engineering
environment with a separate identity (`genesis-live`, `mode: "live"`,
`genesis-live-v1.0.0`); it is never an arm, never a baseline, never a
population member and never a data point of a readout. Its canary
(`genesis-live-canary`) is a First Light of the plumbing, not a cohort."**

Enforced in code by the per-command allowlist, the library guard in
`runPopulation`, the manifest coupling of experiment and mode, the
`experimentId === "genesis-1"` filter in `aggregate-arms.mjs`, and the
regeneration of `experiments/genesis-1/expected/*` in CI.

## A5 — Engine version bumps belong to the scientific track

Genesis-Live never bumps `LAB_SCHEMA_VERSION`, `LAB_ENGINE_VERSION` or
`LAB_COGNITIVE_ENGINE_VERSION`. The one planned exception was phase L2 (sound
resume for cohort runs), which bumped `LAB_COGNITIVE_ENGINE_VERSION` from
`genesis-cognitive-v1.1.0` to `genesis-cognitive-v1.2.0` and marks earlier
cognitive evidence LEGACY, with the owner's explicit confirmation (Decision
log below, 2026-09-04). `LAB_ENGINE_VERSION` and
`experiments/genesis-1/expected/*` are unaffected — the bump touches only
cognitive-mode evidence. P3–P5 (two-layer link primitive, verifier seam,
protocol in the lab) are executed by the scientific track; Live inherits the
resulting engine at an epoch boundary via a recorded `--accept-parent-engine`.

## Decision log

Owner confirmations recorded here are explicit decisions made by the project
owner in conversation, not an agent's own judgment call. Each entry names the
date, exactly what was asked, and exactly what was confirmed, so the "owner
confirmed" language elsewhere in this file and in `docs/GENESIS_LIVE.md` is
traceable to something concrete instead of being self-certifying.

- **2026-09-04 — A1 and A5 accepted together.** The owner was asked, in these
  words: "Поправка дорожной карты ANU: ... Дизайн предлагает ... бамп
  `LAB_COGNITIVE_ENGINE_VERSION` → v1.2.0 в L2 ради честного resume
  когнитивных прогонов (логический движок и научные данные не меняются)" —
  i.e. whether to accept both (a) the P0 amendment A1 (quarantine, not
  deletion, for `src/v2/cognitive-loop.ts` and `src/v2/persistent-market.ts`)
  and (b) the L2 `LAB_COGNITIVE_ENGINE_VERSION` bump described in A5. The
  owner answered "Принять обе (Recommended)" — both accepted, together, in
  that exchange. Nothing beyond these two items was confirmed by this
  exchange.

### Open, awaiting the owner — the publication boundary of `deploy/**` (raised 2026-09-08, L5b review)

**Not a decision. A question with nothing confirmed yet**, recorded here so it
cannot be lost between phases and so nothing downstream can cite it as settled.

This repository is public and its `AGENTS.md` forbids exposing external
infrastructure context. Phase L5a/L5b introduced `deploy/**`,
`compose.live.yml` and `.env.live.example`, which carried machine addresses,
the cloud project identifier, subnets, firewall rule names with priorities and
a reference to an internal document of a different, closed project. The branch
was never pushed, so nothing was disclosed.

Everything measurable has been removed: those values now live only in
`deploy/mws/target.env` (untracked, from `target.env.example`), the tracked
artefacts carry variable names, and `test/publication-boundary.test.mjs`
enforces the boundary as patterns rather than literals.

What remains is a judgment the agent cannot make: **whether `deploy/**` should
exist in a public repository at all.** Even anonymised, it describes the
topology of a production deployment.

- **A.** Keep it public and anonymised, real values only on the operator's
  machine. This is the branch's current state.
- **B.** Move `deploy/mws/**`, `compose.live.yml` and `.env.live.example` to a
  closed repository and leave a pointer here.

The answer belongs in the Decision log above, in the owner's own words, before
`feat/genesis-live` is pushed.

## Status

| Amendment | Needs owner | Reversible | State |
|---|---|---|---|
| A1 quarantine | yes | yes | accepted 2026-09-04 (Decision log); code-side guard delivered in L0 |
| A2 deletions stand | yes (on the P0 PR) | no | unchanged |
| A3 doc drift | no | yes | delivered in L0 |
| A4 ablation clause | yes | yes | proposed; code-side guards delivered in L0 |
| A5 version bumps | yes (L2 bump) | yes | L2 bump accepted 2026-09-04 (Decision log); delivered in L2 |
