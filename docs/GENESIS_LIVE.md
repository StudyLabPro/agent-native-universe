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
`LogicalUniverse`, `EvidenceStore`): evidence of engine `genesis-live-v1.0.0`
is never projected as logical or cognitive evidence. Since phase L3a the same
gates accept live evidence for exactly one caller — the live engine, which
passes an explicit live projection (`ReplayProjectionOptions.live`,
`LabProtocolVerifierOptions.live`, `GenesisRunOptions.live`,
`EvidenceStoreOptions.live`). Every scientific reader calls them without it:
`anu lab replay`, `attest` and `verify-attestation` still refuse a stored live
run, and evidence discovery (`EvidenceStore.openExisting`) still reports it as
an unsupported implementation.

### Per-command allowlist

| Command | Accepted experiment ids |
|---|---|
| `population`, `run`, `baselines` | `genesis-1` only |
| `genesis-1` | `genesis-1`; `genesis-live-canary` only with `--cohort B\|C`, arm A, universe `U0901+` |
| `live` | `genesis-live` only (the epoch engine arrived in L3a as a library; the command and its supervisor arrived in L3c) |
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
- `config.live.genesisFrom` pins the parent's `{runId, engineVersion, tick,
  seq, eventHash, stateHash, runtimeHash, genesisStateHash, runtime,
  compaction}`. It lives inside the config, so it enters `configHash` and
  therefore `runId`: the child's identity is a pure function of what the parent
  left on disk. `runtime` is the parent's final `CheckpointRuntimeState`, which
  the child continues; `compaction` records how the inherited genesis was
  derived; `engineVersion` is what `--accept-parent-engine` has to match when a
  chain crosses an engine change.
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

### 2.1 Engine — how an epoch runs (phases L3a, L3b)

`src/lab/live/epoch.ts` is the whole spine; there is no second runtime.

| Step | Function | What it does |
|---|---|---|
| plan | `planLiveEpoch` | Reads `chain/`, derives `genesisFrom` from the parent's committed evidence (its final checkpoint, cross-checked against its summary; a replay when the checkpoint is missing), builds the epoch's config and manifest. A pure function of the disk state. |
| prepare | `runLiveEpoch` | Writes `manifest.json`, `config.json` and `genesis.json` of the epoch before its first event. |
| run | `runGenesis` (shared) | The same bounded runner the scientific track uses: `LogicalUniverse`, replay-verify, `summary.json`, `attestations/final.json`. |
| link | `LiveChainIndex.writeLink` | `chain/<k>.json`, immutable and dense (epoch `k` needs `k-1`). |
| audit | `verifyLiveChain` | Replays the chain from epoch 0, re-derives every inherited genesis from its parent's replayed final state, recomputes every summary and attestation. |

- The live policy is `CohortPolicy(C, LiveIdlePolicy)`, composed to exactly
  `cohort-c-live-idle-v1`. `genesis.ts` and `protocol-verifier.ts` receive it
  as an injected factory — importing it would break the science guard's rule
  that the scientific instruments never reach `src/lab/live/*`.
- Rules that differ between a bounded run and an epoch live once, in
  `src/lab/epoch-rules.ts`, and are called by both the world and the verifier:
  the calibration stop, the boundary sweep, the inherited `run.started`
  payload and `compactWorldState`. `src/lab/action-rules.ts` holds the rule
  that does not depend on the mode at all — which priced actions this engine
  can actually perform — for the same reason and with the same two callers.
- **The whole action vocabulary is verified, not a scientific subset.** A
  deterministic policy only ever chooses six of the nineteen priced actions; a
  live agent chooses freely, so every type has a deterministic-outcome check:
  the outcome event is regenerated field-for-field from the decision and the
  projected state, and an action the world refused has its refusal regenerated
  word-for-word. `spawn`, `clone`, `merge`, `reserve` and `trade` are priced
  and unimplemented (§9, L8): they can only ever produce the refusal, never a
  successful outcome. `test/lab-protocol-actions.test.mjs` proves each type
  both ways — the honest chain verifies, the tampered one is refused.
- The calibration realization is seeded from the universe (a derived
  `taskStream.realizationSeed`), not from each epoch's `runId`, so the child
  continues the parent's stream instead of starting a new one; the cursor and
  RNG state travel in `genesisFrom.runtime`.
- A live universe may carry an empty `pressures` schedule: its physics arrive
  as recorded operator input, never as a configured schedule.
- `WorldState.counters` are lifetime totals maintained by the one reducer in
  live states only; `metrics.ts` prefers them over map lengths when present,
  which is what will let a bounded world archive settled records without
  changing what a metric means.
- Epoch-0 physics of the universe: `experiments/genesis-live/config.json`.

**Recorded inputs (phase L3b).** Three ports carry into the world what a seed
cannot produce. Their interfaces are `src/lab/live-ports.ts` — outside
`src/lab/live/`, because `world.ts` and `genesis.ts` name them and the science
guard forbids the scientific instruments from importing that directory, even
type-only. Their implementations are `src/lab/live/{task-source,
evaluator-port,physics-inbox}.ts` over the shared inbox reader
`src/lab/live/recorded-inbox.ts`. The rules the world and the verifier must
agree on — the external-task shape and its content-committing id, the price of
a thought, the proportional reward, the exhaustion clock — live once in
`src/lab/epoch-rules.ts`.

| Port | Reads | Commits | How the verifier treats it |
|---|---|---|---|
| `LiveTaskSource` (`FileTaskSource`, `CompositeTaskSource`) | `tasks/inbox.jsonl` | `task.created{source:"external"}` with family `external`, after the tick's calibration work | by form: the payload must be a well-formed external task whose id is `externalTaskId(createdTick, deadlineTick, input)`, admitted within `taskStream.maxBacklog`, never before the tick's calibration work |
| `LiveEvaluatorPort` (`LlmEvaluator`, `InboxEvaluator`) | a grader model, or `verdicts/inbox.jsonl` | `verdict.recorded` (state-neutral, verbatim) immediately before the `task.evaluated{qualityPpm, evaluatorId}` it justifies | by form: `evaluatorId` is the manifest's, `qualityPpm ∈ [0, PPM]`, the verdict precedes its evaluation and grades the next pending submission |
| `LivePressureSource` (`FilePressureSource`) | `physics/inbox.jsonl` | `pressure.applied` on the record's own tick, followed by the retirements it caused | shape by `parsePressureSpec`, effect by `pressureEffect` against the same per-tick `pressureRng.fork(tick)` — an operator cannot aim a `retire_agent_fraction` |

- An inbox record names the **absolute tick** it applies on, so a source is a
  pure function of the file and the tick. There is no cursor to lose: a resume
  re-reads the same file, and a record written for a tick that has already
  passed is never admitted late.
- A record that names an individual agent is **refused by the parser**
  (`assertNotAddressed`), not dropped and not honoured. The control plane sets
  physics only; it never says who does what.
- `external` is the one task family a seed cannot produce, so it is the one
  kind of work that may cross an epoch boundary: it carries no hidden oracle,
  and it expires on its own absolute tick in whatever epoch that tick falls in.
  Calibration work is still swept at the boundary, which is why the full-chain
  sweep is exercised against a task source whose deadlines are unbounded by the
  epoch (`test/lab-live-inputs.test.mjs`).
- The `evaluatorId` is part of the epoch's identity — validated by
  `assertLabManifestImplementation` and hashed into the `runId`, exactly as
  `cognitionId` is. An epoch that grades only calibration work names the hidden
  oracle (`oracle-evaluator-v1`) rather than leaving the field blank. A
  `taskSource` without an `evaluator` is refused up front, and so is an epoch
  that would inherit open external work with no grader.
- An accepted verdict pays `floor(acceptedTaskReward × qualityPpm / PPM)`;
  `qualityPpm = 0` is not an acceptance. Calibration work stays all-or-nothing
  against its oracle, and a calibration `task.evaluated` carries no
  `evaluatorId`.

**The economy of thinking (phase L3b).** A live `cognition.recorded` states the
tier it was consulted at, and the world commits exactly one
`resource.spent{action:"reason"}` **immediately after** it, in the observation
phase, with `causationId` pointing at the record:
`llmTokens = ceil(usage.totalTokens × tiers[tier].pricePpm / PPM)` plus
`costs.reason`, all scaled by the current physics. The verifier recomputes that
price from the recorded usage, the configured tier price and the state's
physics, and refuses anything at all between the record and its debit — so a
run cannot under-charge itself for thinking. A balance that cannot cover the
price is charged to zero and the shortfall is committed as
`violation.recorded{reason:"cognition overdraft"}`; forgiving it silently would
make the balance a fiction. An active agent holding fewer than
`live.exhaustion.minThinkTokens` and no claimed task is *starving*;
`live.exhaustion.graceTicks` consecutive starving ticks retire it in the upkeep
as `agent.retired{reason:"exhausted"}`, with no causal parent because the rule
is regenerated from the states rather than asserted by the event. The clock is
runtime state (`CheckpointRuntimeState.exhaustion`, live-only and therefore
absent from every logical `runtimeHash`) and travels across a boundary in
`genesisFrom.runtime`, so the grace period is continuous over the life of the
universe instead of restarting each epoch.

What the verifier accepts by form here, and cannot do better: the **tier** a
record names. Which tier `LiveCognition` would have chosen depends on
`ANU_LIVE_TIERS` (`maxTokens` per tier), which is port configuration and not
part of `configHash`; the chain carries no `nextTier` either. The tier is
therefore a recorded input like the answer and the token count beside it, and
what the verifier does check is that the debit is exactly the price of the
tier and usage on record.

**The bounded world (phase L3c).** A universe with no end must not have a state
with no end. The upkeep of every live tick commits `submission.archived`,
`task.archived` and `message.archived` for the records that have settled and
aged past `config.live.archive`, and at a boundary `compactWorldState` applies
the same windows once more to the parent's final state. Both call one rule
(`archivableRecords` in `src/lab/epoch-rules.ts`), which the protocol verifier
regenerates instead of trusting: an archival the rule does not name is refused,
and a tick that left an archivable record behind is refused at its
`tick.completed`.

- The plan is ordered and safe by construction: submissions leave first, then
  the tasks whose last submission just left, then delivered mail. The newest
  `PUBLIC_SUBMISSION_WINDOW` submissions and the newest `PUBLIC_INBOX_WINDOW`
  entries of each inbox are never archived while an observation is still built
  from them, a submission leaves only once its task has settled, and a task
  leaves only once every submission naming it leaves in the same plan — so an
  observation can never reach a record that is no longer there. A submission
  takes its verifications with it; archived mail leaves its recipient's inbox.
- **Archival removes state, never evidence.** Every archived record is still in
  the append-only log of the epoch that created it, and `verifyLiveChain`
  replays the chain from epoch 0, so the complete history is always
  reconstructible. The live state is a working set; the chain is the record.
  Lifetime totals survive in the live-only `WorldState.counters`, which
  `metrics.ts` prefers over map lengths, so `tasksCreated` keeps meaning what
  it meant before the world was bounded. Metrics computed over the retained
  maps — mean quality, the latency percentiles — become windowed once archival
  starts, which is honest for an operational readout of one open-ended
  universe and is not comparable across runs anyway.
- The boundary rule is recorded in `genesisFrom.compaction` and is therefore
  part of the child's `runId`: `{kind:"windows", archive:{…}}` carries the
  windows inside itself, so an audit re-derives an inherited genesis from the
  chain link and the parent's replayed state alone. `{kind:"none"}` remains the
  identity rule (`anu lab live --no-compaction true`), and an unknown kind is
  refused by the config and by the derivation rather than degraded to `none`.
- Known remaining growth surfaces, stated rather than hidden: retired agents
  (with their memory) and `capabilityInvocations` have no window in
  `config.live.archive` and are not archived by this phase.

**The supervisor (phase L3c).** `src/lab/live/supervisor.ts` holds two guards
that stop the universe when running on would be worse than not running:

| Guard | Observes | Trips when |
|---|---|---|
| outage | the cognition port's own answers, per tick | `outageTicks` consecutive ticks in which not one consultation came back |
| disk | `statfs` of the evidence root, before each epoch and once per tick | free bytes below `minFreeBytes` |

Both pause **at a tick boundary**: `LogicalUniverse.run` honours an abort by
finishing the tick it is in and checkpointing, so a pause never happens
mid-tick and a paused universe commits nothing at all — no `task.expired`, no
`tick.completed`, no metrics. Recovery is a probe (typically the gateway's
`/readyz`) every `probeIntervalMs`; the epoch then resumes from the boundary it
stopped at and completes. Without the outage guard an epoch whose ticks are normally
paced by real consultations runs at the speed of a replay while the provider is
down, expiring its whole backlog and piling up epochs, chain links and anchors
— evidence of nothing.

**Where the supervisor's observations sit relative to the world's evidence.**
This is the phase's one real tension: the guards must observe free bytes,
provider health and elapsed milliseconds, and none of that may enter the chain.
The boundary is drawn so that the supervisor's observations decide **when the
world is allowed to advance, and nothing else**. It commits no event, holds no
state the reducer reads, and is not a recorded input. It evaluates its guards
on the way *out* of a tick's consultations, so an abort can never withdraw an
in-flight consultation or change what the tick recorded. The consequence is
testable and tested: a paused-and-resumed epoch has the same `runId`, final
event hash, state hash and attestation commitment as an epoch that ran the same
recorded answers and never paused. The inverse holds too — nothing in the chain
says a pause happened. A pause is an operational fact about a process, and
operational facts belong in observability, which is the design's "no wall clock
in evidence" rule applied to the supervisor itself.

**`anu lab live` (phase L3c).** The command resolves the universe's physics,
the live cognition tiers, the three recorded-input ports and the two guards,
then runs epochs and reports each as one JSON line; without `--epochs` it runs
until SIGINT/SIGTERM pauses it at a tick boundary. Two surfaces configure it
and they mean different things: **the config** (`--config`,
`experiments/genesis-live/config.json`) is the universe's physics and is hashed
into every epoch's `runId`; **the flags and `ANU_LIVE_*`** are deployment
(`--outage-ticks`, `--min-free-bytes`, `--probe-interval-ms`, `--tiers`, the
three inbox paths, `--recover-stale-lease`, `--accept-parent-engine`,
`--no-compaction`) and are hashed into nothing. `anu lab live --help` documents
every one of them. The command refuses to start without `--config` (the
built-in config is the scientific one) and without live tiers (a live epoch has
no unsteered fallback).

## 3. Recorded-input rules

A recorded input is a chain event whose content the verifier accepts by form
instead of regenerating it. Live adds exactly these classes, all as branches of
the existing tables, reducer and verifier (single embodiment — no fourth
implementation):

| Input | Source | Event | What the verifier checks |
|---|---|---|---|
| Model answer | `LiveCognition` through the gateway | `cognition.recorded` (+ one `resource.spent{action:"reason"}` charged from `llmTokens` by `usage.totalTokens × pricePpm`) | one record per consulted agent; the debit follows the record immediately and is recomputed from the recorded usage, the tier price and the state's physics; the tier itself is accepted by form (§2.1) |
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
| L3a live engine — epoch chain, inherited genesis, idempotent boundary, live projection | delivered (§2.1) |
| L3b live engine — recorded task sources, verdicts, economy, recorded physics | delivered (§2.1) |
| L3c live engine — archival and compaction, supervisor, `anu lab live` | delivered (§2.1) |
| L6g local drill — a real site bridged to a real Observer over a real multi-epoch chained live universe, on this host, with a real provider | run once; found and fixed four defects across both repositories that no isolated test had reached (protocol-verifier action coverage, `/state` eventHash/stateHash, inherited-epoch genesis, and StudyLabPro's `cognitionHealth` shape check) — see the CHANGELOG entries at `1384df0`, `60b24ba`, `eab3f50` and StudyLabPro `898c009` |
| L5a MWS provisioning — IaC for service accounts/keys, VPC, disks, the VM, the image registry, backup/restore, the Caddy edge, and the Lab-side mirror/tunnel units | IaC authored and reviewed (`deploy/mws/`, `scripts/live/build-push.sh`) — NOT executed; blocked on this phase's own transition condition (owner confirms the resource list, then personally performs the secrets and IAM role-binding steps the CLI cannot do) |
| L5b single-machine live stack — `compose.live.yml`, the host-sized universe config, tiers, bootstrap, systemd units and `deploy/mws/DEPLOY_LIVE.md` | authored, reviewed and measured — NOT deployed and NOT run through Compose. What was actually exercised: `docker compose -f compose.live.yml config -q` passes (and fails loudly without `ANU_LIVE_IMAGE`, `ANU_LIVE_MIN_FREE_BYTES` or `ANU_LIVE_LLM_UPSTREAM`); the sized universe ran end to end twice against a real gateway and a stub provider — two epochs on the `fast` tier (epoch 0: 250 ticks, 23 547 events, 4 000 consultations, ~18.3 MB; epoch 1: last consultation at tick 253, all 16 agents retired `exhausted` at tick 272) and one epoch on `deliberate` (last consultation at tick 22, all retired at tick 40). The stack itself was also exercised for real: the image of this commit was built and the three services were brought up through `docker compose` against a stub provider, running a short epoch to completion — `read_only: true`, the tmpfs file secrets, `user: 1000:1000` and the `internal` network are confirmed by a live run (the runner's `fetch` to the public internet fails, as designed), and the Observer served `/api/live` over the evidence read-only. What was NOT exercised: the image was never pushed to the registry, and nothing has run on the target VM. Blocked on the owner attaching the external address, creating the three secret versions and assigning the IAM role bindings. Five deviations from the multi-host design are recorded in `DEPLOY_LIVE.md` §2, the provider key sharing a host with the evidence first among them |
| C1 canary · remaining L5 infrastructure (roles, secrets, DNS, S3, first real deploy) · L6 site · L7 link inheritance · L8 background extensions | pending; dependencies and criteria in the design |
