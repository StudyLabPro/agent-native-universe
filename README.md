# Agent Native Universe

[![CI](https://github.com/StudyLabPro/agent-native-universe/actions/workflows/ci.yml/badge.svg)](https://github.com/StudyLabPro/agent-native-universe/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/StudyLabPro/agent-native-universe)](https://github.com/StudyLabPro/agent-native-universe/releases)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-5FA04E)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-87f5bd.svg)](LICENSE)

**An agent-native runtime where autonomous NanoAgents discover one another, negotiate stateful relationships, think through interchangeable LLM providers, pay for their own resource use, reach distributed agreement, and recursively organize into MetaAgents.**

The project is built around two primitives:

- **NanoAgent** — a bounded local world with its own objective, state, capabilities, needs, policy, memory, budget and behavior.
- **LinkProtocol** — a durable, adaptive relationship jointly controlled by its participants.

The graph is not merely a diagram of the system. **The live graph is the system.**

> **Local sequential consistency. Global parallel evolution.**

## Runtime layers

### Local living graph

NanoAgents can:

- advertise what they accept, produce and need;
- discover useful peers;
- accept, reject or counter relationship proposals;
- expose only a negotiated boundary rather than private state;
- synchronize LinkProtocols through alternating turns;
- adapt communication frequency and payload shape from observed utility;
- strengthen, weaken, sleep, reactivate and retire relationships;
- clone, split and merge while preserving lineage.

### Autonomous encrypted mesh

The `agent-native-universe/autonomous` entrypoint adds the missing end-to-end connections:

- live capability discovery across different processes and machines;
- bilateral cross-machine relationship negotiation;
- alternating remote boundary synchronization;
- X25519 key agreement and AES-256-GCM payload encryption;
- Ed25519 authentication and tamper detection;
- replay protection and identity pinning;
- real length-framed TCP transport.

Plaintext agent state is not present in network frames.

### Network Byzantine agreement

Committee members keep their own private keys and exchange proposals and votes through the encrypted mesh.

For `n` committee members the runtime tolerates:

```text
f = floor((n - 1) / 3)
quorum = 2f + 1
```

A leader cannot manufacture the other replicas' votes. Each replica independently validates and signs its decision. A commit certificate is applied only after a valid quorum, and view-change votes can move leadership after failure.

### Durable resource economy

The persistent economy tracks:

- credits;
- compute time;
- model tokens;
- storage;
- bandwidth.

Both sides of a market order are reserved immediately:

- seller resources move into offer escrow;
- buyer credits move into bid escrow;
- price improvement is refunded;
- trade resources and payment settle atomically;
- cancellation and expiry return unused escrow;
- balances, orders, trades and the journal survive restart.

This prevents the same resource from being offered twice.

### Metered LLM cognition

`MeteredCognitiveLoop` makes an LLM invocation part of an agent's actual thought cycle.

The runtime:

1. serializes the agent's objective and local state;
2. reserves model tokens and optional credits;
3. routes the request through a provider-neutral completion interface;
4. settles actual usage to the provider account;
5. refunds unused reservation;
6. applies validated private, exposed, durable and ephemeral state changes;
7. dispatches requested actions through an explicit action handler.

The existing OpenAI-compatible, Anthropic and Ollama adapters can be used through the same interface.

### Continuous fractal organization

Stable strongly connected clusters can be folded automatically into MetaAgents. Weak MetaAgent boundaries can be unfolded automatically.

The controller supports:

- stability windows before folding;
- hysteresis before unfolding;
- recursive higher-order MetaAgents;
- deterministic MetaAgent identities;
- optional BFT-gated fold and unfold operations.

A cluster can therefore become one externally visible agent without losing its internal members, links, lineage or reversibility.

## High-level composition

`AutonomousMeshNode` connects the complete runtime:

```text
local NanoAgents
      ↓
encrypted distributed discovery
      ↓
remote relationship negotiation
      ↓
alternating boundary synchronization
      ↓
LLM cognition + automatic resource settlement
      ↓
network BFT for shared decisions
      ↓
persistent economy and graph-side effects
      ↓
continuous fractal MetaAgent formation
```

The same encrypted transport carries discovery, relationship and committee traffic while each subsystem retains independent local failure containment.

## Quick start

Requires Node.js 22 or newer. CI verifies the minimum Node.js 22 line and the
Node.js 24 Active LTS line.

```bash
npm ci
npm run build
npm test
npm run demo:living
```

The repository has zero runtime npm dependencies.

Stable releases include an npm-compatible archive and a hardened Linux/amd64
Universe Lab image:

```bash
docker pull ghcr.io/andrewhakmi/agent-native-universe-lab:v1.0.0
```

Start a local read-only Observer after producing evidence:

```bash
node dist/lab/runner.js genesis-1 --data-dir ./runs --agents 16 --ticks 500
node dist/lab/runner.js serve --data-dir ./runs --host 127.0.0.1 --port 8787
```

Open http://127.0.0.1:8787/. The v1 Observer includes a searchable evidence
catalogue, outcome and structural metrics, deterministic attestation status, and
a bounded redacted event window. See [ANU Observer](docs/OBSERVER.md).

## Universe Lab and Genesis-1

The repository now includes a deterministic, event-sourced laboratory for
role-neutral agent populations. The logical Genesis-1 runner provides finite
resource physics, hidden-oracle task evaluation, external pressure, hash-chained
JSONL evidence, evaluator-backed rewards, checkpoints, exact replay, fixed-point
metrics, bounded parallel populations, and a read-only Observer API.

The current manifest-bound engine identity is `genesis-logical-v1.1.0`.
Accepted messages now produce an explicit causal
`message.sent` → `message.delivered` pair and enter the recipient's inbox; each
observation exposes a deterministic window of at most 64 delivered messages.
Agents can publish independent submission attestations without changing hidden
evaluator truth, and can execute a bounded, side-effect-free JSON capability DSL
(`copy`, `sum`, `concat`, and `literal`) with the declared resource payment.

Long-run evidence uses a non-retaining recorder and streaming full-chain replay.
Each immutable run identity has an isolated `experiment/universe/runId`
directory. Replay requires `--run-id` when more than one compatible run exists,
rejects incompatible engine identities, and uses the stored config to regenerate
the deterministic neutral-policy decision stream and complete terminal protocol
rather than trusting hash-valid event semantics.
Each completed run now also receives an immutable deterministic final
attestation. Publishing its `sha256:` commitment in an independently controlled
append-only system makes later full-evidence rewrites detectable; the local
attestation file alone is not an external trust anchor.
The policy hot path now builds one immutable, redacted per-tick observation
snapshot instead of rescanning the complete historical task table for every
active agent. Structural sharing stays internal, policy code receives an
isolated deeply frozen observation clone, and golden regressions preserve the
exact pre-optimization event and state hashes.
The Observer keeps a bounded, sparse in-memory cursor index so high `after`
cursors can be served from logs larger than 64 MiB without changing the public
`after`/`limit` API. These changes reduce memory and scan pressure; they are not
yet evidence that the full reference population runs within production limits.
The internal Observer remains unauthenticated on its isolated control network.
The opt-in edge role loads a strong Bearer token from a Docker-mounted file and
enforces it inside the application as well as retaining Traefik authentication.
The human UI keeps a directly entered Bearer token in memory only; it never
stores the token in browser persistence.

Run a conservative local experiment and verify it by replay:

```bash
npm run build
node dist/lab/runner.js genesis-1 --data-dir ./runs --agents 16 --ticks 500
node dist/lab/runner.js replay --data-dir ./runs --universe-id U0001

# Publish the returned commitment outside the evidence host, then verify it:
node dist/lab/runner.js attest \
  --data-dir ./runs --universe-id U0001 --run-id '<RUN_ID>'
node dist/lab/runner.js verify-attestation \
  --data-dir ./runs --universe-id U0001 --run-id '<RUN_ID>' \
  --expected 'sha256:<EXTERNALLY_PUBLISHED_HASH>'
```

Run the full reference configuration explicitly:

```bash
node dist/lab/runner.js population \
  --config ./experiments/genesis-1/config.json \
  --data-dir ./runs \
  --universes 32 \
  --parallel 2
```

For a 2 GB runner limit, `--parallel 2` is a starting engineering estimate,
not a completed live benchmark of 32 universes with 64 agents × 10,000 ticks.

See [Universe Lab](docs/UNIVERSE_LAB.md) for the scientific boundary, evidence
model, commands, and current logical-v1.1 limitations. See
[Lab deployment](docs/LAB_DEPLOYMENT.md) for the hardened Docker/Traefik stand.
See [Lab capacity](docs/LAB_CAPACITY.md) for the runnable current-checkout
profile, completed single-reference-universe canary, storage measurements, and
remaining steps before the full population can be considered validated.

## Imports

```ts
import { Universe } from "agent-native-universe";

import {
  DistributedGraphNode,
  PersistentGraphStore,
  ByzantineQuorum,
  ResourceLedger,
  LlmRouter,
  FractalUniverse,
} from "agent-native-universe/distributed";

import {
  AutonomousMeshNode,
  MeshIdentity,
  EncryptedTcpTransport,
  DistributedDiscoveryMesh,
  NetworkByzantineNode,
  PersistentResourceEconomy,
  MeteredCognitiveLoop,
  CognitiveScheduler,
  ContinuousMetaAgentController,
} from "agent-native-universe/autonomous";
```

## Runtime laws, not prompt requests

The deterministic runtime prevents a participant from:

- writing twice in succession on a strict-alternation relationship;
- changing fields owned by another participant;
- silently rewriting relationship history;
- accepting a forged or replayed encrypted message;
- committing a committee decision without enough unique signatures;
- spending a negative balance;
- selling resources that have already been reserved;
- consuming LLM resources without settlement;
- folding unstable clusters immediately.

## Repository map

```text
src/core/       NanoAgent and LinkProtocol primitives
src/runtime/    local living topology
src/v1/         signed distributed graph, persistence, economy and provider adapters
src/v2/         autonomous encrypted mesh and integrated runtime
src/lab/        deterministic Universe Lab, Genesis-1 and Observer API
experiments/    immutable experiment configurations
test/           deterministic, network and recovery tests
docs/           architecture and operating semantics
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [LinkProtocol semantics](docs/PROTOCOL.md)
- [Living graph runtime](docs/LIVING_GRAPH.md)
- [Distributed v1](docs/DISTRIBUTED_V1.md)
- [Multi-machine operation](docs/MULTI_MACHINE.md)
- [Network BFT](docs/NETWORK_BFT.md)
- [Autonomous encrypted mesh](docs/AUTONOMOUS_MESH.md)
- [ANU Observer](docs/OBSERVER.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

## Status

Version 1.0.0 is the first stable API and operating release. It includes real
encrypted networking, persistent recovery, distributed voting, durable resource
settlement, metered cognition, continuous fractal organization, deterministic
Universe Lab evidence, and a production-oriented read-only Observer.

“Stable release” describes the documented interfaces and verified invariants; it
does not claim formal verification, an independent security audit, or completion
of the full 32 × 64 × 10,000 capacity target. Those boundaries remain explicit
in [Lab capacity](docs/LAB_CAPACITY.md) and [Security policy](SECURITY.md).
