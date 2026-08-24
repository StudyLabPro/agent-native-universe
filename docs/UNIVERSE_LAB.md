# Universe Lab

Universe Lab is an event-sourced experimental layer above the Agent Native
Universe runtime. Its first experiment, Genesis-1, asks a narrow question:

> Can initially role-neutral agents produce useful organization under finite
> resources and externally verified tasks without being assigned human job
> titles, teams, services, or workflows?

The lab does not treat an agent's self-description as evidence. Functional
specialization is inferred only from observable actions, accepted submissions,
resource flows, topology, and capability use.

## Boundary of authority

`LogicalUniverse` owns only the world's physics: logical time, public tasks,
hidden evaluator oracles, prices, finite resource balances, external pressures,
and append-only evidence. Every Genesis agent starts from the same role-free
state and runs the same `NeutralPolicy`; each agent receives an independent
seeded random stream and only its permitted observation.

The world never exposes expected task results. Agents submit candidate results,
and `IndependentEvaluator` records quality and latency independently. The
control plane cannot tell an agent what role to assume. A different agent may
publish a submission attestation based on its own computed result, but that
public attestation is stored separately and cannot rewrite evaluator acceptance,
quality, or reward.

## Deterministic tick pipeline

Genesis state is created at tick 0. Experiment ticks are numbered from 1 through
the configured limit and execute these phases in order:

1. apply configured external pressures;
2. expire overdue work and generate public tasks;
3. create an immutable local observation for every active agent;
4. obtain role-free policy decisions;
5. resolve simultaneous decisions in a seeded shuffled order;
6. evaluate submissions against hidden immutable oracles;
7. record fixed-point metrics, a tick boundary, and scheduled checkpoints.

No scientific ID, event, seed, or state hash depends on wall-clock time,
`Math.random`, process scheduling, or host locale. Population workers derive
each universe seed from the base seed and universe ID, so changing `--parallel`
does not change results.

The manifest also binds the logical engine, policy, task-generator identity,
and execution mode. The current engine identity is
`genesis-logical-v1.1.0`. A semantic engine change therefore produces a
different run identity even when seed and experiment JSON stay the same.

## Causal collaboration

An accepted send over an active link records `message.sent`, followed by a
`message.delivered` event whose `causationId` points to the send event. Delivery
adds the message to the recipient's inbox. The world retains that history, while
each agent observation exposes only the latest 64 delivered messages in
deterministic order and applies the same oracle-field redaction boundary used by
other observations. Inbox consumption and acknowledgement are not implemented.

Submission verification is an agent-authored public attestation, not a second
evaluator. A verifier cannot attest to its own submission, attest twice, or
publish a verdict inconsistent with its supplied computed result. The
attestation records whether that result matches the submitted value; it remains
independent from the hidden oracle and evaluator truth.

Published capabilities use a bounded, side-effect-free JSON transformation DSL
with `copy`, safe-integer `sum`, bounded `concat`, and `literal` steps. Plans
have a fixed step bound, require observable test vectors, and cannot contain
source code, recursion, dynamic dispatch, or I/O. A valid invocation pays the
capability's declared resource vector exactly once: to its owner for cross-agent
use, or to the treasury for self-use. Invalid input and insufficient resources
waive that declared capability payment and produce a recorded failure; the base
`useCapability` primitive action cost is still charged for the attempted
operation. This execution model applies only to the logical laboratory; it is
not a general capability sandbox for the distributed runtime.

## Evidence and replay

Each run is stored under:

```text
runs/genesis-1/U0001/<run-id>/
├── manifest.json
├── config.json
├── events.jsonl
├── metrics.jsonl
├── summary.json
└── checkpoints/
    └── <tick>.json
```

A completed population has a separate deterministic catalogue address:

```text
runs/genesis-1/populations/population-<sha256>/population.json
```

The population digest binds the complete Genesis configuration, requested
universe count, logical engine, policy, task generator, and versioned
population protocol. `--parallel` and the data directory are deliberately not
part of that identity because they are scheduling and storage choices, not
scientific inputs. Distinct configurations therefore coexist in one durable
volume, while an identical rerun resolves to the same immutable summary.
Publication uses atomic no-overwrite semantics: concurrent differing bytes for
one identity fail closed. The former `<experiment>/population.json` location is
retained as a legacy read path but is no longer a write target.

Events are canonical JSONL with a monotonic sequence, deterministic event ID,
previous hash, and SHA-256 event hash. Writes are serialized through one
recorder. The Genesis run path disables the recorder's in-memory event copy, and
file replay reads one record at a time while verifying the complete hash chain.
Genesis completion additionally compares replayed and live state hashes.
Immutable artifacts refuse conflicting replacement. An incomplete stream is
resumed only when it ends at a verified `tick.completed` boundary and its latest
checkpoint matches independently replayed world state, event-chain tail, task
generator state, and per-agent neutral-policy RNG streams. Mid-tick evidence,
legacy checkpoints without runtime state, and mismatches remain preserved for
diagnosis and fail closed instead of being truncated or rewritten.

Authoritative replay requires the stored `config.json`; the config hash, seed,
experiment, deterministic run ID, and manifest implementation identity must all
agree. It then regenerates the exact genesis population, pressures, task stream
and hidden task oracles, neutral-policy observations and decisions, deterministic
resolution order, evaluator results, rewards, metric schedule, tick/phase state
machine, and action-payment causality. A terminal `run.completed` is mandatory.
`--until-tick` changes only the returned projection: replay still validates the
complete event file so a valid prefix cannot hide a forged suffix.

Evidence I/O is Linux-specific by design. Directory components are opened from
the filesystem root and held through `/proc/self/fd` with `O_DIRECTORY` and
`O_NOFOLLOW`; final reads, appends, atomic links, and unlinks remain anchored to
the held parent descriptor. Concurrent parent rename-plus-symlink replacement
therefore cannot redirect an in-flight write into the replacement target.

The event writer and authoritative replay readers enforce the same 256 KiB
maximum canonical event size. Replay rejects non-canonical JSONL, blank records,
CRLF records, missing final newlines, chain gaps, and incompatible manifest
implementation identities. Evidence written directly below the universe
directory by logical v1.0 remains discoverable as a legacy layout, but v1.1 does
not reinterpret it with the new projector; replay it with its matching
historical engine.

Checkpoints still serialize the complete projected world state. Frequent
checkpoints can therefore amplify disk use even though event recording and
replay no longer materialize the complete event log in memory.
SIGINT or SIGTERM requests a boundary pause: the active tick completes, a
durable checkpoint is flushed, and the writer lease is released. Re-running
the same deterministic command automatically resumes that run; a completed run
remains idempotent. Production population universes execute in separate Node.js
processes bounded by `--parallel`, while result ordering and scientific hashes
remain independent of process scheduling.
Manifest, config, summary, attestation, and metrics reads are bounded; an
individual checkpoint above 64 MiB is rejected instead of being materialized
into process memory. The reference configuration remains below that per-file
guard, but larger experiments must validate checkpoint size explicitly.

The chain makes accidental corruption, truncation, and ordinary tampering
detectable. Every completed run also receives the immutable canonical artifact
`attestations/final.json`. It commits, with domain-separated SHA-256, to the
manifest, config, full metrics history, reconstructed summary, terminal event
hash, terminal state hash, tick, and sequence. `anu lab attest` independently
performs strict semantic replay before creating or returning it.

The local attestation is not itself an external signature or transparency log:
an attacker with write access to every artifact could replace the manifest,
recompute a new chain, and replace the local commitment. Publish the returned
`runId + sha256:commitment` in an independently controlled append-only or signed
store, then use `anu lab verify-attestation --expected ...` to detect rewrite or
rollback. No timestamp, hostname, path, credential, or signature is included in
the deterministic artifact.

Verification opens manifest, config, events, metrics, and summary through one
fd-anchored run directory, keeps those file handles for the complete replay,
and fails closed if an opened artifact changes during the pass. This prevents a
pathname swap from redirecting one phase of verification to a different file;
it does not replace the independently published expected commitment.

## Resource physics and pressure

Credits, model tokens, compute milliseconds, storage bytes, and bandwidth bytes
are non-negative safe integers. An action cost is transferred from the agent to
the world treasury, never destroyed. Every tick checks conservation across all
agents and the treasury. An externally accepted task transfers the configured
reward back from treasury; cumulative gross action spend is tracked separately
from the current balances. Genesis-1 applies exactly one instance of each
logical pressure:

- resource-price multiplier;
- bandwidth-capacity multiplier;
- deterministic fractional agent retirement;
- task-load multiplier.

The reference configuration in `experiments/genesis-1/config.json` contains 64
agents, 10,000 ticks, the specified finite global budget, and pressures at ticks
2,000, 3,500, 5,000, and 6,500.

## Control arms and baselines

A treatment number means nothing alone. The `baselines` command runs the
experiment plan's §33 control arms on one seed and one config, and writes a
multi-objective comparison next to the evidence:

```bash
node dist/lab/runner.js baselines \
  --data-dir ./runs \
  --ticks 200 \
  --arms A,C,D,E,F
```

| Arm | Treatment | Implementation |
| --- | --------- | -------------- |
| A | self-organizing network | the manifest-bound neutral policy |
| B | no metaagents | rejected: the logical engine has no metaagents to remove |
| C | no resource economy | `zeroCostConfig` — every action cost becomes zero |
| D | no link adaptation | `baseline-no-links-v1`: neutral decisions, topology actions suppressed |
| E | central orchestrator | `baseline-central-dispatch-v1`: fixed hash routing, no discovery |
| F | preassigned human roles | `baseline-fixed-roles-v1`: fixed verifier/solver split, fixed routing |

A single arm can also be run directly: `genesis-1 --arm E`.

Baseline runs produce evidence of exactly the same grade as the treatment.
Each control policy is registered in the manifest, regenerated by the protocol
verifier during replay, and hashed into its own `runId`, so control evidence
can never be confused with treatment evidence. Roles and dispatch tables live
inside the policies; genesis agents remain role-neutral state.

Universe ids are bound to arm identity (A→U0001 … F→U0005), so rerunning a
subset of arms reuses the same run identities instead of redoing evidence.

The comparison pins one task realization for every arm: the command sets
`taskStream.realizationSeed` (to the base seed, unless the config supplies its
own), which seeds the task stream independently of each arm's run identity.
Every arm therefore faces byte-identical tasks and oracles, and metric gaps
are attributable to the architecture rather than to per-arm task luck. A
config without the field keeps the historical run-bound derivation, which is
what every existing run hash depends on.

Two caveats still ship inside every `comparison.json` and bear repeating:
with one run per arm, differences smaller than seed-to-seed variance are not
interpretable; and arm F verification coverage is bounded by the public
observation window — a tick producing more than 64 submissions evicts the
overflow before its only verifiable tick.

Baseline runs do not support checkpoint resume — their runtime policy state
is recorded as `null`, and the world refuses to resume it rather than guess.
An interrupted arm therefore cannot be continued: delete that arm's run
directory and rerun the command, which redoes the arm from genesis under the
same deterministic identity. Resuming interrupted *neutral* runs currently has
a known engine defect (the evaluator's oracle map is not rebuilt on restore),
so prefer restarting interrupted arms of any kind from genesis.

Recorded readouts — including the 600-tick crisis run in which the
fixed-roles arm collapses under the ×4 load spike, and the five-seed series
that validates the collapse arithmetic quantitatively — live in
[`experiments/genesis-1/BASELINES.md`](../experiments/genesis-1/BASELINES.md),
together with the analysis scripts that produced the tables.

## Commands

Build first, then use either the package binary or the dedicated runner:

```bash
npm run build

node dist/lab/runner.js genesis-1 \
  --data-dir ./runs \
  --config ./experiments/genesis-1/config.json \
  --universe-id U0001

node dist/lab/runner.js population \
  --data-dir ./runs \
  --config ./experiments/genesis-1/config.json \
  --universes 32 \
  --parallel 2

node dist/lab/runner.js replay \
  --data-dir ./runs \
  --universe-id U0001 \
  --until-tick 5000

# Required when more than one compatible run exists for the universe:
node dist/lab/runner.js replay \
  --data-dir ./runs \
  --universe-id U0001 \
  --run-id '<RUN_ID>'

node dist/lab/runner.js attest \
  --data-dir ./runs \
  --universe-id U0001 \
  --run-id '<RUN_ID>'

node dist/lab/runner.js verify-attestation \
  --data-dir ./runs \
  --universe-id U0001 \
  --run-id '<RUN_ID>' \
  --expected 'sha256:<EXTERNALLY_PUBLISHED_HASH>'

node dist/lab/runner.js serve --data-dir ./runs --host 0.0.0.0 --port 3000

# Application auth for a shared or public network:
node dist/lab/runner.js serve --data-dir ./runs --host 0.0.0.0 --port 3000 \
  --auth-token-file /run/secrets/anu_lab_observer_token
```

The same surface is available as `anu lab ...`. With no `--config`, the runner
uses a conservative 16-agent, 500-tick configuration suitable for a smoke run.
Under the Compose 2 GB memory ceiling, population parallelism 2 is a starting
engineering estimate pending a concurrent process-worker benchmark. One
parallelism-1 reference universe has completed; this is not a multi-universe
capacity guarantee.

The policy scheduler now creates one immutable, redacted per-tick observation
snapshot. Structural sharing stays internal, while policy code receives an
isolated deeply frozen observation clone. A historical one-off baseline at
commit `926ab5f6a8c6c189c43eb882d09788832a08f113` measured about 1,127 ms for
the target-shaped tick-10,000 policy sample; the current profile measured about
279 ms, with an immediate repeat at 283 ms, while preserving exact historical
event/state hashes. The checked-in
command reproduces only the current profile, not that historical baseline or
the derived ratio. This microbenchmark excludes reducer work, event I/O,
checkpoints, replay, and process scheduling; it is not full-capacity proof. See
`docs/LAB_CAPACITY.md` for the method and remaining bottlenecks.

The observer exposes only read methods: its dependency-free human UI, health,
readiness, the run catalogue, run summaries/final attestations, bounded metric
history, and paginated events. Run detail labels the
optional attestation as `missing`, `invalid`, or `self_consistent`; only the CLI
with an external expected commitment performs authoritative semantic
verification. Event pagination remains
`GET /api/runs/:runId/events?after=<seq>&limit=<count>`. A bounded sparse cursor
index lets the process seek into logs larger than the 64 MiB per-request scan
budget instead of repeatedly scanning from byte zero. The index is in-memory,
bounded, lazily learned, and discarded on restart; it is not a durable evidence
artifact. The Observer cannot mutate or steer a universe.

Discovery is also fail-closed. A catalogue larger than 1,000 runs or any
incomplete bounded scan returns 503 instead of exposing a partial selection;
duplicate run IDs return 409 instead of choosing one directory.

When `--auth-token-file` is omitted, the API is suitable only for the isolated
internal control network. When it is present, the Observer reads the strong
token once at startup and requires an exact Bearer header on catalogue, detail,
metric, and event routes using a timing-safe comparison. The UI keeps a token
entered by its operator in memory only. UI assets, the service contract,
liveness, and readiness remain unauthenticated so the shell and container
probes can load. The edge Compose profile requires this application check and
retains an independent Traefik authentication middleware to prevent
shared-network routing bypasses.

Observer pagination performs bounded parsing, redaction, and local sequence
checks; it deliberately does not verify the complete hash prefix for each HTTP
page. Use `anu lab replay` as the integrity authority before treating viewed
records as verified evidence.

Replay selects the only compatible run automatically. If a universe contains
multiple compatible run IDs, the CLI refuses to guess and requires `--run-id`.

## Scope of logical v1.1

The current implementation establishes the deterministic experimental control
plane, not a positive result for the research hypothesis. It includes role-free
deterministic cognition, eight task families, external evaluation, primitive
action costs, topology changes, capability contracts, population execution,
metrics, pressure, replay, delivered messages, submission attestations, bounded
capability execution, and read-only observation.

Several experiments remain intentionally separate:

- local and external LLM cohorts with inference responses captured as replay
  inputs;
- physical four-node universes for transport, BFT, partition, and crash tests;
- LLM gateway egress, provider billing, and provider-failure pressure;
- evolutionary selection, recombination, and control populations;
- signed external anchoring of final evidence hashes;
- implementation of logical-v1.1 `spawn`, `clone`, `merge`, `reserve`, and `trade`
  actions (they are currently charged and recorded as unsupported attempts).

Current operational limits are equally important:

- one 64-agent × 10,000-tick reference universe has completed with full replay
  and attestation, but the 32-universe population has not; see the measured
  envelope in `docs/LAB_CAPACITY.md`;
- Observer cursor checkpoints are process-local and are rebuilt after restart;
- inbox entries have no consume or acknowledgement lifecycle;
- the capability DSL is restricted to logical mode;
- complete-state checkpoints can dominate disk use at short intervals;
- application token rotation requires an edge-container recreate because the
  secret is deliberately read only once.

Consequently, a successful run proves reproducible execution and measurement;
it does not by itself prove emergence. Claims of specialization or organization
require repeated populations, action-derived labels, controls, and a
multidimensional comparison rather than one aggregate score.
