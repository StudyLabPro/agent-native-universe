# Changelog

All notable changes to Agent Native Universe are documented here. The project
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Genesis-Live — phase L0 (identity and science isolation)

- Registered the complete experiment registry `LAB_EXPERIMENT_IDS`
  (`genesis-1`, `genesis-live`, `genesis-live-canary`) and the Genesis-Live
  identity: `mode: "live"`, engine `genesis-live-v1.0.0`, policy literal
  `cohort-c-live-idle-v1` (accepted only in live mode), task source
  `live-task-source-v1`, `GenesisConfig.live` physics validated only for
  `genesis-live`. Experiment and mode imply each other; the canary is the
  cognitive cohort path under its own name and is never a logical arm.
- Every projector of this build (`assertLabManifestImplementation`,
  `ReplayEngine`, `LabProtocolVerifier`, `LogicalUniverse`) refuses a live
  manifest fail-closed; the live engine arrives in a later phase.
- Per-command experiment allowlist in `anu lab`: `population`/`run`/`baselines`
  accept only `genesis-1`; `genesis-1` additionally accepts
  `genesis-live-canary` with `--cohort B|C`, arm A and universes `U0901+`;
  the new `live` command accepts only `genesis-live` and fails closed as
  "not implemented in this build"; evidence readers accept every registered
  id. `runPopulation` and `aggregate-arms.mjs` refuse non-scientific evidence.
- `stateHash` discipline: `WorldState.mode?`/`counters?` are optional and
  absent in non-live states; `external` is a live-only literal outside the
  frozen task families. Logical genesis is byte-identical to the committed
  canonical fixtures.
- Added `experiments/genesis-1/expected/U000{1..5}.json` (the §33 arms on the
  default seed, 600- and 200-tick readouts, verified against the original
  evidence) and the science guard `npm run check:live-isolation`
  (`.github/scripts/check-live-isolation.mjs`: import graph, canonical
  fixtures, task families, live-manifest refusal, CLI allowlist, deterministic
  regeneration of the five runs). It runs in the PR gate and in `npm run check`.
- Documented Genesis-Live (`docs/GENESIS_LIVE.md`), the roadmap amendments
  (`docs/ROADMAP_AMENDMENTS.md`: P0 quarantine instead of deletion for the v2
  cognitive loop and persistent market), and fixed `docs/NETWORK_BFT.md`,
  which described a class, a certificate file and a catch-up protocol that do
  not exist.

### Genesis-Live — phase L1a (provider and gateway hardening)

- `HttpLlmProvider`/`LlmRouter` gained a closed/open/half-open circuit
  breaker: consecutive failures open the circuit, `health()` reports it so the
  router stops selecting that provider, and after `cooldownMs` a single
  half-open probe closes it on success or re-opens it on failure.
- `LlmCognition` gained a per-consultation timeout (`ANU_LLM_TIMEOUT_MS`), an
  `AbortSignal` threaded from `LogicalUniverse.run` so a run's own SIGTERM
  withdraws an in-flight consultation and pauses at the tick boundary instead
  of mid-tick, a byte-accurate content budget (content stays a valid UTF-8
  prefix, actions are parsed from the untruncated answer, `truncated: true`
  and a `:cb<budget>` id suffix mark it), and capture of
  `reasoning_content`, `reasoning_tokens` and `finish_reason`.
  `ANU_LLM_REQUEST_OVERRIDES` merges provider-specific fields into the wire
  body, is hashed into the cognition id as `:ro<hash>`, and cannot override
  `model`, `messages` or `stream`.
- `LlmGateway` gained `--audit-rotate`, `--state-file` (counters and the
  budget window persisted atomically and keyed to the gateway's identity, so
  a mismatched state file is refused), `--budget-window-ms` with
  per-window token and request caps, `--metering-failure-mode latch|exit`
  (`exit` persists state and leaves with code 75/`EX_TEMPFAIL` so a
  supervisor can restart with budgets intact), and the same degrade path for
  a response over `--max-response-bytes`. The state file's decide-then-persist
  crash window is documented as an accepted bounded margin: it under-counts by
  at most one request's tokens and never double-counts.

### Genesis-Live — phase L2 (sound resume and lease recovery)

- `CohortPolicy` gained `checkpoint()`/`restore()`, delegated verbatim to its
  inner fallback policy — the model's own answer is never regenerated and has
  nothing to checkpoint; the fallback's RNG streams are what make the tick
  schedule reproducible after a restart. `LogicalPolicy`'s checkpoint/restore
  became optional interface members, and both `world.ts` and
  `protocol-verifier.ts` now duck-type on them instead of testing
  `instanceof NeutralPolicy`, so the two engines produce byte-identical
  runtime hashes for the same cohort policy state.
- Fixed unsound resume that affected even plain neutral runs: the evaluator's
  oracle map was never rebuilt on restore, so any task still open at the
  checkpoint boundary failed evaluation with "No oracle registered" and
  corrupted the resumed run's own replay verification.
  `LabProtocolVerifier.pendingOracles()` returns the oracles still open at the
  durable boundary from its own from-genesis replay, carried through
  `ReplayResult` into `LogicalUniverseOptions.pendingOracles`. Oracles are
  recomputed in memory on every resume and never written to any artifact, so
  the observations/events redaction contract is unchanged.
- Added `fsyncEveryTick`: the event log is fsynced after every
  `tick.completed` instead of only at pause or completion. Durability only —
  it cannot change a byte of any run, only when written bytes reach disk.
- `EvidenceStore.acquireWriterLease` gained `recoverStale`. The lock file now
  records `{pid, runId, bootId, startTicks}`, and a lock is judged stale only
  when this process can positively disprove its recorded owner (a different
  boot id, no process holding that pid, or a process whose actual start time
  differs from the recorded one) — never by `kill(pid, 0)`, which cannot
  distinguish a live owner from an unrelated pid reuse. Without the option,
  any existing lock is a conflict exactly as before.
- Bumped `LAB_COGNITIVE_ENGINE_VERSION` to `genesis-cognitive-v1.2.0`:
  evidence made with `v1.1.0` is refused rather than reinterpreted, since it
  was produced by an engine that could not resume soundly. `LAB_ENGINE_VERSION`
  and every `experiments/genesis-1/expected/*.json` fixture are untouched.

### Genesis-Live — phase L1b (live cognition port and idle policy)

- `LiveCognition` implements `CognitionPort` for cohort C: it consults every
  active agent concurrently, tiered across fast/standard/deliberate with
  independent per-tier concurrency, model, prompt budget and price, routed
  through one shared `LlmRouter` via a `tier:<name>` capability tag so an
  unhealthy tier's open circuit can never silently reroute a consultation to
  a different model. `expectedTier(nextTier, balance, prices)` is a pure
  exported function that downgrades toward an affordable tier and returns
  `starved` when even the cheapest is unaffordable — no call and no record
  that tick. The prompt asks for `nextTier` and is bounded by
  `LIVE_OBSERVATION_BUDGET` independently of population size; prompt and
  budget hash into `promptId`, which is part of the port id together with the
  tier spec and gateway identity. It never throws: a provider exception
  becomes an `unavailable` record for that agent, and a 429-shaped error is
  retried twice with backoff first.
- `LiveIdlePolicy` implements `LogicalPolicy` with `decide()` unconditionally
  returning `[]`, so an unsteered live agent does nothing rather than falling
  through to a code-solved answer that the site would then show as real work.
  Construction is gated to `mode: "live"` through the same manifest literal
  the identity layer already enforces.
- `CohortPolicy`'s fallback is typed `LogicalPolicy` rather than the concrete
  `NeutralPolicy`, and asserts the fallback supports checkpoint/restore before
  delegating. `CognitionRecord` gained additive optional `tier`/`nextTier`.
- `createLiveCognition()` parses `ANU_LIVE_TIERS` and wires one router with a
  tier-tagged provider each. The `live` command itself is unchanged and still
  fails closed as "not implemented in this build".

### Genesis-Live — phase L3a (epoch spine: chain, inherited genesis, idempotent boundary)

- A live universe is now a chain of bounded epochs on one absolute tick axis.
  `config.ticks(k) = genesisFrom.tick + epochTicks`, `run.started{inherited}`
  is committed at the parent's final tick, and an inherited epoch creates no
  genesis population — it continues the parent's agents, links, tasks and
  treasury. `LiveGenesisFrom` pins the parent's `runId`, engine, tick, seq,
  event hash, state hash, runtime (with its hash) and the compaction rule, and
  lives inside `GenesisConfig.live`, so it enters `configHash` and therefore
  the child's `runId`: an epoch's identity is a pure function of what its
  parent left on disk.
- `src/lab/live/epoch.ts` builds the chain: `planLiveEpoch` derives the next
  epoch from the disk state alone, `runLiveEpoch`/`runLiveUniverse` run and
  link it, `verifyLiveChain` performs the full audit by replaying the chain
  from epoch 0 — re-deriving every inherited genesis from its parent's
  replayed final state and recomputing every summary and attestation rather
  than trusting them. `chain/<epoch>.json` (`LiveChainIndex`, immutable and
  dense) is an index, not a source of truth.
- The boundary `k → k+1` is idempotent at every point: `run.completed`,
  `summary.json`/`attestations/final.json`, `chain/<k>.json`,
  `manifest.json`+`genesis.json` of `k+1`, `run.started{inherited}`. Each step
  is re-derived and writes only what is missing; identical bytes are tolerated,
  differing bytes are an `EvidenceConflictError`. `kill -9` at any of the four
  points converges to the same `runId(k+1)` and the same first-tick state hash
  (`test/lab-live-boundary.test.mjs` kills real processes to prove it).
- Live-mode projection, and only for the live engine:
  `assertLabManifestImplementation`, `ReplayEngine`, `LabProtocolVerifier`,
  `LogicalUniverse` and `EvidenceStore` accept a live manifest when — and only
  when — the caller passes an explicit live projection. Every scientific
  reader calls them without it and keeps refusing live evidence fail-closed,
  including `anu lab replay`/`attest`/`verify-attestation` and evidence
  discovery. The live idle policy is injected as a factory rather than
  imported, so the science guard's import rule holds unchanged.
- Shared live rules live once in `src/lab/epoch-rules.ts` and are called by
  both the world and the verifier (single embodiment): calibration generation
  stops `deadlineTicks + 1` ticks before an epoch ends, the final upkeep
  expires anything still open as `task.expired{reason: "epoch_boundary"}`
  (a live-only reducer rule), and `compactWorldState` derives an inherited
  genesis — refusing any compaction kind this build does not implement.
  No calibration oracle can cross a boundary; oracles exist only in memory.
- `WorldState.counters` are maintained by the one reducer in live states only,
  and `metrics.ts` prefers them over map lengths when present, so a bounded
  world can archive settled records later without changing what a metric
  means. A logical or cognitive state still carries neither `mode` nor
  `counters` — asserted on the keys of the canonical JSON.
- A live universe may carry an empty `pressures` schedule (its physics arrive
  as recorded operator input), its calibration realization is seeded from the
  universe rather than from each epoch's `runId` so the stream continues
  across boundaries, and `CohortPolicy` composition is idempotent for a
  fallback that already carries the cohort-qualified live literal.
- Added `experiments/genesis-live/config.json` (the epoch-0 physics of the
  live universe) and the tests `test/lab-live-{epochs,boundary}.test.mjs`.
  Still to come at the time: recorded task sources, verdicts and economy
  (delivered in L3b below), and archival, the supervisor and the `live`
  command (L3c) — each declared as a seam that fails closed.

### Genesis-Live — phase L3b (recorded inputs, verdicts, the economy of thinking)

- Three recorded-input ports carry into a live epoch what a seed cannot
  produce. Their interfaces are `src/lab/live-ports.ts`, deliberately OUTSIDE
  `src/lab/live/`: `world.ts` and `genesis.ts` name them, and the science guard
  forbids the scientific instruments from importing that directory even
  type-only. The implementations are `src/lab/live/{task-source,evaluator-port,
  physics-inbox}.ts` over the shared reader `src/lab/live/recorded-inbox.ts`.
- `external` is the live-only task family of work that entered from
  `tasks/inbox.jsonl`. Its id is a commitment to its own content
  (`externalTaskId`), so the verifier checks a recorded task against itself
  without ever reading the inbox, a byte-identical record cannot enter twice,
  and a swapped prompt or deadline is refused at replay. External work is
  admitted after the tick's calibration work, within `taskStream.maxBacklog`,
  and never touches `learning`/`taskCounts` — specialization is still measured
  over exactly the frozen eight families, and external work is counted in the
  live-only `WorldState.counters`. Because it carries no hidden oracle it is
  the one kind of work allowed to cross an epoch boundary, and it expires on
  its own ABSOLUTE tick in whatever epoch that tick falls in.
- `LiveEvaluatorPort` grades what no oracle can. A verdict is committed
  verbatim as a state-neutral `verdict.recorded` immediately BEFORE the
  `task.evaluated{qualityPpm, evaluatorId}` it justifies — the same treatment
  `cognition.recorded` gets, for the same reason — and an accepted verdict pays
  `floor(acceptedTaskReward × qualityPpm / PPM)`. `LlmEvaluator` puts a grader
  model behind the existing completion surface (`temperature 0`, JSON only, an
  unparsable answer grades zero and stays on record); `InboxEvaluator` reads
  `verdicts/inbox.jsonl`. Replay reads the recorded verdict and never asks a
  grader again. `RunManifest.evaluatorId` is present exactly in live mode and
  hashed into the `runId`, as `cognitionId` is; an epoch that grades only
  calibration work names the hidden oracle (`oracle-evaluator-v1`).
- Thinking is paid for inside the world. A live `cognition.recorded` states its
  tier, and exactly one `resource.spent{action:"reason"}` follows it
  immediately in the observation phase, caused by it:
  `ceil(usage.totalTokens × tiers[tier].pricePpm / PPM)` plus `costs.reason`,
  scaled by the current physics. The verifier recomputes that price from the
  recorded usage and refuses anything between the record and its debit. An
  uncoverable price is charged to zero and committed as
  `violation.recorded{reason:"cognition overdraft"}`. An active agent below
  `live.exhaustion.minThinkTokens` holding no claimed task starves; after
  `graceTicks` consecutive starving ticks it is retired in the upkeep as
  `agent.retired{reason:"exhausted"}`, with no causal parent because
  `LiveExhaustionTracker` regenerates the rule from the states. That clock is
  live-only runtime state (`CheckpointRuntimeState.exhaustion`), so logical and
  cognitive `runtimeHash`es are byte-identical to what they were, and it
  travels in `genesisFrom.runtime` so the grace period is continuous across
  boundaries.
- `physics/inbox.jsonl` is the whole control surface of a live universe. A
  record applies on its own absolute tick; a record ADDRESSED TO AN AGENT is
  refused by the parser with a message naming the invariant, rather than
  dropped or honoured — the control plane sets physics only, never who does
  what. `retire_agent_fraction` still draws its victims from
  `pressureRng.fork(tick)`, and the verifier recomputes the whole payload with
  `pressureEffect`, so an operator cannot aim a retirement.
- Single embodiment throughout: the shape of a pressure is `parsePressureSpec`
  and its effect is `pressureEffect` (both in `pressure-engine.ts`), used by
  the configured schedule, the recorded inbox and the verifier alike; the
  external-task shape, the thinking price, the proportional reward and the
  exhaustion clock live once in `src/lab/epoch-rules.ts`. An inbox record names
  its absolute tick, so a source needs no cursor to survive a crash.
- Added `test/lab-live-{inputs,economy}.test.mjs`; the recorded-input seams of
  `runLiveEpoch` no longer fail closed, while `archive` and `supervisor` (L3c)
  still do and `anu lab live` still exits "not implemented in this build".

### Genesis-Live — phase L3c (the bounded world, the supervisor, `anu lab live`)

- **The bounded world.** A universe with no end must not have a state with no
  end. The upkeep of every live tick commits `submission.archived`,
  `task.archived` and `message.archived` for the records that have settled and
  aged past `config.live.archive`, and `compactWorldState` applies the same
  windows once more at a boundary. Both go through one rule
  (`archivableRecords`, `src/lab/epoch-rules.ts`), which the protocol verifier
  regenerates rather than trusts: an archival the rule does not name is
  refused, and a tick that left an archivable record behind is refused at its
  `tick.completed`. The plan is ordered so it is always safe to apply —
  submissions first, then the tasks their departure frees, then delivered mail
  — and never touches a record an observation is still built from (the newest
  `PUBLIC_SUBMISSION_WINDOW` submissions, the newest `PUBLIC_INBOX_WINDOW`
  entries of each inbox). A submission takes its verifications with it;
  archived mail leaves its recipient's inbox.
- **Archival removes state, never evidence.** An archived record is still in
  the append-only log of the epoch that created it, and `verifyLiveChain`
  replays the chain from epoch 0, so the whole history stays reconstructible.
  Lifetime totals live on in `WorldState.counters`, which `metrics.ts` already
  prefers over map lengths, so `tasksCreated` means after archival what it
  meant before. Measured: 16 agents over 5 000 absolute ticks in ten chained
  epochs hold a flat checkpoint — the working set stops growing while the
  lifetime totals keep climbing.
- The boundary rule is recorded in `genesisFrom.compaction` and is therefore
  part of the child's `runId`. `{kind:"windows", archive:{…}}` carries the
  windows inside itself, so an audit re-derives an inherited genesis from the
  chain link and the parent's replayed final state alone; `{kind:"none"}`
  remains the identity rule; an unknown kind is refused by the config and by
  the derivation instead of degrading to `none`.
- **The supervisor** (`src/lab/live/supervisor.ts`): an outage guard that
  pauses after `outageTicks` consecutive ticks in which not one consultation
  came back, and a disk guard that pauses when the evidence volume drops below
  `minFreeBytes`. Both pause **at a tick boundary** — the tick finishes, its
  checkpoint reaches disk, and a paused universe commits nothing at all, so an
  outage can no longer race a 500-tick epoch to its end and expire the whole
  backlog. Recovery is a probe every `probeIntervalMs`; the epoch resumes from
  the boundary it stopped at.
- **Where the supervisor's observations sit relative to the evidence.** The
  guards observe free bytes, provider health and elapsed milliseconds — none of
  which may enter a chain. They decide *when the world advances and nothing
  else*: the supervisor commits no event, holds no state the reducer reads and
  is not a recorded input, and it evaluates its guards on the way out of a
  tick's consultations so an abort can never withdraw one in flight. Tested,
  not asserted: a paused-and-resumed epoch has the same `runId`, final event
  hash, state hash and attestation commitment as an epoch that ran the same
  recorded answers and never paused. Nothing in the chain says a pause
  happened; a pause is an operational fact and belongs in observability.
- **`anu lab live` is a real command.** It resolves the universe's physics, the
  live cognition tiers, the three recorded-input ports and the two guards, runs
  epochs and reports each as one JSON line, and without `--epochs` runs until
  SIGINT/SIGTERM pauses it at a tick boundary. Flags: `--data-dir`,
  `--experiment`, `--universe-id`, `--config`, `--epoch-ticks`, `--epochs`,
  `--tiers`, `--task-inbox`, `--verdict-inbox`, `--physics-inbox`,
  `--outage-ticks`, `--min-free-bytes`, `--probe-interval-ms`,
  `--recover-stale-lease`, `--accept-parent-engine`, `--no-compaction`, with
  `ANU_LIVE_*` defaults; `anu lab live --help` documents every one. The config
  is the universe's identity and is hashed into every epoch's `runId`; the
  flags and the environment are deployment and are hashed into nothing. The
  command refuses to start without `--config` (the built-in config is the
  scientific one) and without live tiers (a live epoch has no unsteered
  fallback). The per-command allowlist is unchanged: `live` accepts
  `genesis-live` and nothing else, and `check-live-isolation` now proves that
  in both directions.
- `experiments/genesis-live/config.json` is pinned by a test: 32 agents,
  `epochTicks 500`, `checkpointEvery 25`, `metricEvery 10`,
  `initialResources.llmTokens 200000`, `acceptedTaskReward {credits 5,
  llmTokens 5000}`, tiers priced x1/x3/x8, `exhaustion {minThinkTokens 1500,
  graceTicks 20}`, `taskStream {tasksPerTick 8, deadlineTicks 60, maxBacklog
  256}`, `archive {tasks 100, messages 100, submissions 200}`, `pressures []`.
- Known remaining growth surfaces, stated rather than hidden: retired agents
  (with their memory) and `capabilityInvocations` have no window in
  `config.live.archive` and are not archived by this phase.
- Added `test/lab-live-{archive,supervisor}.test.mjs`. The bounded-world
  measurement executes and then semantically replays 5 000 ticks of a
  sixteen-agent world and is by a wide margin the most expensive test in the
  suite; it dominates the suite's wall clock.

### Genesis-Live — phase L4 (Observer live surface)

- `GET /api/live` returns the live universe head: `currentRunId`, epoch,
  the epoch chain merged with anchor timestamps, a boundary flag, and
  cognition health (consulted/unavailable/starved over the trailing 50
  ticks). `chain/` and `anchors/` do not exist until later phases; every
  field degrades to null/false/zero instead of failing when they, or the
  universe itself, are absent.
- `GET /api/runs/:id/head` returns stat-based `lastSeq`/`lastTick` from a
  bounded tail read, `eventsBytes`, `latestCheckpointTick` from checkpoint
  filenames only, and `completed`.
- `GET /api/runs/:id/state` projects `WorldState` from the latest checkpoint
  plus the event tail through the same `applyWorldEventMutable` the engine and
  replay use. Checkpoint reads cap at 8 MiB and the redacted response at
  4 MiB; both are bearer-gated and redacted like every other evidence route.
- Added `ETag`/`If-None-Match` → 304 for events, head and state, computed from
  a stat-only peek so a match short-circuits before any scan or projection.
- Run discovery now skips the reserved live-universe directories so a growing
  epoch index is never mistaken for a run.

### Genesis-Live — phase L9 (permanent science-isolation gate)

- Extended `check-live-isolation.mjs` into the permanent guard: an import-graph
  check (`src/lab/live/**` may not reach the core runtime, `src/runtime/*` or
  `src/v2/*`; the scientific instruments may not reach `src/lab/live/*`),
  in-memory and stored-evidence proof that this build's projector, replay
  engine, protocol verifier and evidence readers all refuse a live or canary
  manifest, and proof that `runPopulation`, `runGenesis` and
  `aggregate-arms.mjs` refuse non-scientific evidence.
- The PR gate runs the guard twice by name, at the default 600 ticks and at
  200 ticks, so both fixture sets in `experiments/genesis-1/expected/*.json`
  are regenerated and hash-compared on every pull request rather than
  shape-checked. Both steps stay inside the single required PR Gate job.
- The CLI-allowlist check reads a refused case on the child's `close`, not its
  `exit`: the exit code is known before the child's stderr pipe has drained in
  the guard process, so the refusal message was intermittently read as empty
  and a refusal that did happen was reported as a failure.

### Protocol verifier action coverage

- `LabProtocolVerifier` regenerated the deterministic outcome of only six of
  the nineteen priced action types (`claimTask`, `execute`, `submit`,
  `connect`, `send`, `verify`) and threw
  `unsupported action <type> in the manifest-bound policy` on every other one,
  killing the process. The violation branch had the matching gap: an action
  refused by the world (`disconnect` without a link, `retrieve` of an unknown
  key, an unaffordable `transfer`, an unknown capability, and the five priced
  but unimplemented actions) was refused as "cannot be replaced by a
  violation". Nothing in the scientific track reaches the gap — its
  deterministic policies only ever choose those six — so it was a live-only
  defect and was found by a real epoch against a real model, not by review: a
  live agent chose `store`, and the whole universe stopped.
- Every action type now has a real check. `store`, `retrieve`, `disconnect`,
  `transfer`, `publishCapability` and `useCapability` are regenerated
  field-for-field from the decision and the projected state, including all
  four ways an invocation ends (accepted to the owner, accepted to the
  treasury, rejected by its own bounded plan, rejected for want of resources).
  A forged outcome the reducer alone would accept — a transfer of 300 credits
  where 3 were decided, a capability published at a price nobody agreed to, an
  invocation recorded against an input the caller never chose — is now refused.
- `spawn`, `clone`, `merge`, `reserve` and `trade` remain priced and
  unimplemented (their implementation is background work of a later phase).
  The verifier now regenerates the world's refusal verbatim and refuses any
  successful outcome event claiming one of them, rather than crashing on both.
- The unsupported-action rule moved to `src/lab/action-rules.ts` so the world
  and the verifier read one definition instead of two, the way `epoch-rules.ts`
  already holds the live rules. The verifier builds an expected publication
  with the same `createCapabilityState` the world publishes with, and runs a
  capability plan through the same `executeCapabilityPlan`.
- The outcome switch is exhaustive at compile time: a new action type now fails
  the build instead of reaching production as an unverified outcome.
- Added `test/lab-protocol-actions.test.mjs`: real epochs in which each action
  is actually chosen, each verified, and each then re-signed with a tampered
  outcome and refused.

### Controlled LLM egress

- Added a dependency-free OpenAI-compatible gateway and `anu lab gateway` CLI
  command. The gateway holds the provider credential, exposes only bounded
  non-streaming chat completions, requires strong client authentication for
  non-loopback binds, enforces model/request/rate/concurrency limits, validates
  usage fail-closed, and writes a bounded metadata-only audit trail.
- Added an opt-in Compose cognitive topology: the universe worker has only an
  internal route to the gateway, while the gateway alone joins the egress
  network and receives the file-mounted provider secret. The worker reads a
  separate file-mounted gateway token.
- Gateway identity hashes the configured upstream and is read before the
  cognitive manifest is created, preventing two upstream URLs behind the same
  gateway hostname from silently sharing evidence identity.
- Documented the metering boundary explicitly: the local accounted-token value
  is a post-response stop threshold, while the hard financial cap belongs to
  the provider-scoped key/account.

### Universe Lab

- Genesis runs can now put a model in the loop: cognition cohorts record every
  answer as replay input (`cognition.recorded`), fall back to the neutral
  policy on provider failure, and take a separate engine identity
  (`genesis-cognitive-v1.1.0`) so cognitive evidence can never be mistaken for
  seed-reproducible evidence. The manifest binds the consulted model through
  `cognitionId` — model, endpoint host and consultation budget are hashed into
  the runId, so rerunning a cohort against a different model can never recover
  another model's completed evidence.
- Added the experiment plan's §33 control arms (`baselines` command): central
  dispatch, fixed roles, no link adaptation, free physics — each a
  manifest-bound deterministic policy producing evidence of the same grade as
  the treatment. The comparison pins one task realization for every arm via
  `taskStream.realizationSeed`; without the field the task stream stays bound
  to the run identity, byte-for-byte as before.
- Population comparison is now multi-objective (Pareto dominance, NSGA-II
  style ranks and crowding in integer ppm) instead of a single score. A flat
  objective axis no longer grants arbitrary boundary points infinite crowding.
- Recorded the first two §33 readouts in `experiments/genesis-1/BASELINES.md`,
  including the 600-tick crisis run in which the fixed-roles arm collapses
  under a ×4 load spike while every other arm absorbs it.

### Metered cognition

- A reservation can now be enforced as a real spending ceiling through
  `CognitiveBillingPolicy.overrunPolicy: "reject"`. The provider is still paid
  for work it genuinely performed, but only up to the reservation, and the
  breach is raised as `CognitiveOverrunError` carrying the unbilled remainder.
  The previous behaviour — drawing the difference from the agent's balance —
  remains the default under `"topUp"`.
- Overruns are reported in `ThoughtResult.overruns` even when they are absorbed,
  so an exceeded bound can no longer pass unobserved.
- A thought that fails *after* the provider has answered now settles the
  delivered usage instead of refunding it, and declares any part it could not
  bill. A thought that never reached the provider is still refunded in full.
  Previously both cases were refunded, letting the ledger record zero for tokens
  that had really been consumed.
- Added `experiments/mws-kimi`, a live falsification harness that established
  the above against a reasoning model on MWS Cloud, where the provider ignores
  the requested `max_tokens` entirely.

### Toolchain

- Adopted the stable native TypeScript 7 compiler after the complete Node.js 22
  runtime and production-container checks passed.
- Updated the official checkout and Node setup actions to v7.
- Kept Node.js 22 as the verified minimum and added a complete runtime lane on
  the Node.js 24 Active LTS line.
- Constrained `@types/node` major updates to the declared minimum-runtime
  boundary; future major type upgrades must move the runtime, image, and CI
  contracts together.

## [1.0.0] - 2026-08-19

The first stable release establishes ANU as an executable agent-native runtime
and a reproducible laboratory for studying emergent organization.

### Runtime

- Stable NanoAgent, LinkProtocol, living-graph, distributed, autonomous, and
  laboratory package entrypoints.
- Authenticated and encrypted multi-machine discovery, relationship negotiation,
  synchronization, network BFT, and deterministic view change.
- Durable double-entry resource economy with reservations, atomic settlement,
  recovery, and metered provider-neutral LLM cognition.
- Continuous reversible NanoAgent-to-MetaAgent organization.

### Universe Lab

- Role-neutral Genesis-1 world with finite resource physics, hidden-oracle
  evaluation, deterministic pressures, capability creation, messaging, and
  externally measured specialization.
- Canonical hash-chained JSONL evidence, strict semantic replay, immutable run
  identities, deterministic final attestations, and independently verifiable
  commitments.
- Durable tick-boundary checkpoint/resume and process-isolated population
  workers with deterministic scheduling-independent results.
- Bounded, descriptor-anchored evidence I/O that rejects traversal, symlink
  replacement, oversized artifacts, mutation during verification, and ambiguous
  run identities.

### Observer

- Production-grade, dependency-free read-only UI served by the Observer itself.
- Accessible run catalogue, outcome metrics, metric history, structural signals,
  attestation status, and redacted event-window inspection.
- In-memory Bearer-token session for the opt-in edge; no browser persistence of
  the application token.
- New bounded GET /api/runs/:runId/metrics endpoint and machine-readable
  service contract at GET /api.
- Strict CSP and cross-origin, framing, referrer, permissions, MIME, and cache
  response policies.

### Operations

- Hardened multi-stage Node.js 22 Docker image and fail-closed Compose roles for
  internal observation, authenticated edge observation, and one-shot runners.
- Stable CI and tag-driven release workflow; obsolete self-modifying upgrade
  workflows removed.
- Versioned hardened Universe Lab image published to GitHub Container Registry.
- GitHub Release archives include a CycloneDX SBOM and SHA-256 checksums.
- Release, security, contribution, deployment, capacity, and Observer contracts
  documented.

### Known boundary

One 64-agent × 10,000-tick reference universe completed with full semantic
replay and attestation. The complete 32-universe population remains an explicit
capacity target, not a v1.0.0 throughput guarantee. Scientific correctness,
recovery, evidence integrity, and process isolation are covered; the measured
single-universe envelope is in docs/LAB_CAPACITY.md.

[Unreleased]: https://github.com/StudyLabPro/agent-native-universe/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/StudyLabPro/agent-native-universe/releases/tag/v1.0.0
