# Changelog

All notable changes to Agent Native Universe are documented here. The project
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
