# Genesis-Live

Genesis-Live is not a new runtime. It is the **fourth identity of the existing
laboratory engine**: the same `LogicalUniverse`, the same reducer, the same
hash chain, the same protocol verifier and the same forked `DeterministicRng`
as the scientific track — run under `experimentId: "genesis-live"`,
`mode: "live"`, its own engine version, its own data root and its own machine.
Everything that a seed cannot reproduce (model answers, external tasks,
verdicts, operator physics) enters the chain as a **recorded input**, exactly
the way `cognition.recorded` already does for cognitive cohorts.

This document is the identity and honesty contract. It is written for the
people who read the evidence and for the CI guard that keeps the scientific
track byte-identical while Live grows. Phases are named `L0 … L9`; each is
described by dependencies, transition conditions and completion criteria, never
by calendar units.

## 1. Identities

| Identity | Value | Where it is pinned |
|---|---|---|
| Experiment ids | `genesis-1`, `genesis-live`, `genesis-live-canary` — the complete registry | `LAB_EXPERIMENT_IDS` (`src/lab/types.ts`) |
| Live experiment | `genesis-live` | `LAB_LIVE_EXPERIMENT_ID` |
| Live mode | `mode: "live"` — implies and is implied by `genesis-live` | `RunManifest.mode`, `assertExperimentModeCoupling` (`src/lab/manifest.ts`) |
| Live engine | `genesis-live-v1.0.0` | `LAB_LIVE_ENGINE_VERSION` |
| Live policy literal | `cohort-c-live-idle-v1` — accepted only under `mode: "live"`; cohort letter `C` = external model, which is honest | `LAB_LIVE_POLICY_ID`, `LAB_LIVE_POLICY_PATTERN` |
| Live task source | `live-task-source-v1` | `LAB_LIVE_TASK_SOURCE_ID` |
| Live universe | `U0001` under `<dataRoot>/genesis-live/` | `LIVE_UNIVERSE_ID`, `LIVE_DATA_ROOT_SEGMENT` (`src/lab/live/identity.ts`) |
| Live physics | `GenesisConfig.live` — present exactly for `genesis-live`, part of `configHash` and therefore of `runId` | `validateLiveConfig` (`src/lab/config.ts`) |
| Epoch manifest | built by the shared `createRunManifest` through `createLiveEpochManifest` — no second manifest builder | `src/lab/live/identity.ts` |
| Canary experiment | `genesis-live-canary` — the `genesis-1` cognitive cohort path (`--cohort B\|C`, arm A) under its own name; universes `U0901` upwards; `mode: "cognitive"`, engine `genesis-cognitive-v1.2.0` | `assertCanaryUniverseId`, CLI allowlist (`src/lab/runner.ts`) |

The scientific engines refuse a live manifest fail-closed
(`assertLabManifestImplementation`, `ReplayEngine`, `LabProtocolVerifier`,
`LogicalUniverse`): evidence of engine `genesis-live-v1.0.0` is never projected
as logical or cognitive evidence. The live engine (phase L3) extends the same
gate with its own branch; until then the identity exists so that older builds
fail closed on it.

### Per-command allowlist

| Command | Accepted experiment ids |
|---|---|
| `population`, `run`, `baselines` | `genesis-1` only |
| `genesis-1` | `genesis-1`; `genesis-live-canary` only with `--cohort B\|C`, arm A, universe `U0901+` |
| `live` | `genesis-live` only (the supervisor itself arrives in L3; the command fails closed until then) |
| `replay`, `attest`, `verify-attestation`, `serve` | every registered id — readers never guess |

`runPopulation` refuses non-scientific configs at the library level as well, and
`experiments/genesis-1/aggregate-arms.mjs` refuses any run whose manifest is
not `experimentId: "genesis-1"` (the canary is `mode: "cognitive"` too, so the
filter is on the identity, never on the mode).

## 2. Epoch model

Open-ended life is a **chain of bounded epochs with absolute tick numbering**.

- Epoch `k` is an ordinary run: `run.started` … `run.completed`, replayed and
  attested (`summary.json`, `attestations/final.json`) like any run of the lab.
- Ticks never restart: `config.ticks(k) = genesisFrom.tick + epochTicks`,
  `startTick = genesisFrom.tick`. The reducer's monotonic-time rule, latency
  arithmetic and deadline expiry all keep working across epochs.
- `config.live.genesisFrom` pins the parent's `{runId, tick, seq, eventHash,
  stateHash, runtimeHash, genesisStateHash}`. It lives inside the config, so it
  enters `configHash` and therefore `runId`: the child's identity is a pure
  function of what the parent left on disk.
- The boundary `k → k+1` is **idempotent**: each step (`run.completed`,
  summary and attestation, `chain/<k>.json`, `genesis.json` and
  `manifest.json` of `k+1`, `run.started{inherited}`) checks for its artifact
  and writes only what is missing; identical bytes are tolerated, differing
  bytes are an `EvidenceConflictError`. A `kill -9` at any point converges to
  the same `runId(k+1)`.
- `chain/` in the universe root is an index, not a source of truth; the truth
  is the events and attestations of every epoch. `anchors/<k>.json` records
  the external anchors (object storage plus the mandatory mirror pull).
- A full audit is a replay of the chain from epoch 0.

Calibration oracles never cross a boundary: calibration tasks stop being
generated `deadlineTicks + 1` ticks before the epoch ends and the last upkeep
expires what is still open (`task.expired{reason:"epoch_boundary"}`). External
tasks have no oracle and may cross.

## 3. Recorded-input rules

A recorded input is a chain event whose content the verifier accepts by form
instead of regenerating it. Live adds exactly these classes, all as branches of
the existing tables, reducer and verifier (single embodiment — no fourth
implementation):

| Input | Source | Event | What the verifier checks |
|---|---|---|---|
| Model answer | `LiveCognition` through the gateway | `cognition.recorded` (+ one `resource.spent{action:"reason"}` charged from `llmTokens` by `usage.totalTokens × pricePpm`) | one record per consulted agent; spend follows the record; tier = `expectedTier(nextTier, balance, prices)` |
| External task | `tasks/inbox.jsonl` | `task.created{source}` with family `external` | form, deadline ≥ tick, forbidden fields; the parser **rejects addressed entries** |
| Verdict | grader model or `verdicts/inbox.jsonl` | `verdict.recorded` (state-neutral, verbatim) before `task.evaluated{qualityPpm, evaluatorId}` | `evaluatorId ∈ manifest`, `qualityPpm ∈ [0, PPM]` |
| Physics | `physics/inbox.jsonl` | `pressure.applied` | multipliers and fractions only; `retire_agent_fraction` still drawn from `pressureRng` |

Rules that never bend:

- **The control plane sets physics only** — prices, capacities, load, shares.
  It never assigns roles, tasks, partners or models. The thinking tier is the
  agent's own recorded decision (`nextTier`); the control plane prices it.
- **No wall clock in evidence.** Time in the chain is the tick. Durations are
  measured outside the chain (observability) and may become physics
  parameters, never event content.
- **Every recorded input is bounded**: content ≤ 65 536 bytes (budget hashed
  into `cognitionId` as `cb65536`), observation budget hashed into `promptId`.
- **Randomness comes only from `rootRng`**; model answers are inputs, never a
  source of randomness for the world.
- **Secrets never touch the evidence process.** The universe has no provider
  key and no egress; only the gateway holds the key; the Observer never writes.

## 4. Science-isolation contract (`stateHash` discipline)

`stateHash = hashValue(state)` and every checkpoint is verified against it, so
a field added to `WorldState` would silently change every scientific hash
without an engine bump. Therefore:

- Every live field of `WorldState` is optional and **absent** in non-live
  states: `mode?: "live"`, `counters?`. They are set only by the live genesis of
  a `mode: "live"` manifest.
- `external` is a live-only literal (`LiveTaskFamily`). It is **not** a
  `TaskFamily`, not in `TASK_FAMILIES` of `config.ts` and not in the frozen list
  of eight families in `metrics.ts`; specialization is still computed over
  exactly eight families and external work is counted separately.
- Agents' `learning` and `taskCounts` never receive an `external` key.
- `initialWorldState(logical manifest)` and `createGenesisAgents` are
  byte-identical to the committed canonical fixtures.
- The five §33 logical runs `U0001..U0005` regenerate byte-identically from the
  default config: `experiments/genesis-1/expected/U000{1..5}.json` pin their
  run ids, event and state hashes, metrics hash, commitment and latest metrics
  for both the 600-tick and the 200-tick readouts.
- Live data never enters `runs/genesis-1`, the population, the baselines, the
  Pareto readout or `BASELINES.md`; `genesis-1` data is never mounted into a
  Live container.
- Live imports nothing from `src/core/*` runtime code, `src/runtime/*` or
  `src/v2/*`; the scientific instruments import nothing from `src/lab/live/*`.

All of this is enforced by `npm run check:live-isolation`
(`.github/scripts/check-live-isolation.mjs`), which runs in the PR gate and in
`npm run check`, and by `test/lab-live-identity.test.mjs`.

Relationships stay **flat** (`LabLinkState`) until the scientific track
delivers the two-layer link primitive (P3–P5). Live inherits that engine at an
epoch boundary through an explicit, recorded `--accept-parent-engine`; it never
implements a link protocol of its own.

## 5. Honesty contract (what the site may say)

- **LIVE** only when the Observer head advanced within the freshness window
  **and** the cognition health window shows consulted answers
  (`consulted > unavailable + starved`), **and** the hash chain of the served
  pages was verified by the site (`verifyNextEvent`).
- **STALE** carries a reason: `no progress`, `provider outage` (all records in
  the window are `unavailable`/`starved`), `epoch boundary` (replay and
  attestation in progress).
- **OFFLINE**: one real frame "OBSERVER OFFLINE", then a fallback that is
  visibly marked `simulated`; simulated rows are never labelled real.
- **SYNCING** while the site rebuilds its projection from a checkpoint.
- **verified** applies only to the sequence range the site itself verified;
  **attested** only to a completed epoch with a self-consistent attestation and
  a recorded anchor.
- The canary is always labelled "engineering canary · code fallback possible":
  its unsteered agents fall back to the neutral solver (`CohortPolicy` over
  `NeutralPolicy`), so a row may be code, not model. Live epochs steer every
  consulted agent and idle the rest (`LiveIdlePolicy`, phase L2).
- Model names appear in the evidence (`cognitionId`) and may be shown in
  evidence panels; the site's own assistant does not name its provider.
- Nothing about patents: undisclosed layers are described as undisclosed, not
  as pending.

## 6. What is NOT science

- Genesis-Live is an **engineering environment**. It is never an arm, never a
  baseline, never a population member, never a data point of the §33 readouts
  and never an input to the scientific hypothesis (§0).
- The canary is a First Light of the plumbing (gateway, evidence, Observer,
  site), not an epoch of Live and not a cohort of the experiment plan.
- Live metrics are operational: they describe one universe under recorded
  external inputs and cannot be compared across seeds, arms or engines.
- A model's recorded answer is an input; replaying it proves the chain, not the
  model.
- The scientific engine versions (`genesis-logical-v1.1.0`,
  `genesis-cognitive-v1.2.0`) are bumped only by the scientific track. The
  single planned exception was the L2 sound-resume change: it bumped
  `LAB_COGNITIVE_ENGINE_VERSION` from `genesis-cognitive-v1.1.0` and marks
  earlier cognitive evidence LEGACY, delivered with the owner's explicit
  confirmation — recorded, with the date and exactly what was asked and
  answered, in `docs/ROADMAP_AMENDMENTS.md`'s Decision log (2026-09-04, A5).

## 7. Canary — First Light (phase C1)

Placeholder. Filled in when C1 runs: gateway identity and the proof that the
canary path goes through the gateway, `compose.canary.yml`, `U0901+` runs,
observed cadence per tick, share of `unavailable`/`starved` records, share of
invalid claims, and the exact wording the site shows for canary rows.

Phase C1 is non-blocking and reversible; connecting the production site to
the canary bridge is a container recreate and needs the owner's confirmation.

## 8. Operational facts to record at first launch

To be filled by the phases that discover them (kept here so the unknowns are
visible, not assumed): MWS Secret Manager `get-data` field format, per-key
quota, object-storage endpoint and whether versioning/object-lock is honoured,
IAM role bindings applied by hand, ACME path for the Observer edge.

## 9. Phase status

| Phase | State |
|---|---|
| L0 identity, isolation contract, roadmap amendment, expected fixtures | delivered (this document, `docs/ROADMAP_AMENDMENTS.md`, the science guard — `ed1c30e`) |
| L1a provider/gateway hardening (circuit breaker, LLM cognition budgets, gateway persistence) | delivered (`9f58c29`) |
| L2 sound cohort/neutral resume, oracle rebuild, fsync option, lease recovery | delivered (`ac789cb`) |
| L1b live cognition port, `LiveIdlePolicy`, observation budget | delivered (`5f1097b`) |
| L4 Observer live surface — `/api/live`, run head/state, ETag/304 | delivered (`fb0c1bc`, merged `aa677f3`) |
| L9 permanent CI gate — hardened science-isolation guard | delivered (`3a6ab0a`, merged `3ad5dd1`) |
| C1 canary · L3 live engine · L5 infrastructure · L6 site · L7 link inheritance · L8 background extensions | pending; dependencies and criteria in the design |
