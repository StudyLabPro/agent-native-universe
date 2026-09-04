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
  Still to come: recorded task sources, verdicts and economy (L3b), and
  archival, the supervisor and the `live` command (L3c) — each declared as a
  seam that fails closed today.

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
