# Changelog

All notable changes to Agent Native Universe are documented here. The project
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/AndrewHakmi/agent-native-universe/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/AndrewHakmi/agent-native-universe/releases/tag/v1.0.0
