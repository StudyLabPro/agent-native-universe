# ANU Observer

The Observer is the human and machine read-only surface for Universe Lab
evidence. It is served by the same dependency-free Node.js process as the JSON
API and performs no mutations.

## Human interface

Open / in a browser. The v1 interface provides:

- a searchable catalogue of completed and in-progress runs;
- evaluator-backed outcome metrics;
- metric history for success, quality, and graph density;
- structural signals for centralization, specialization, inequality, components,
  turnover, and latency;
- deterministic attestation status and copyable evidence commitments;
- a bounded, redacted event window with event-type filtering. Completed runs
  open near the tail; active runs open from the first valid page because they
  have no trusted terminal event count yet.

The chart has an accessible data table. Navigation and controls are keyboard
operable, layouts adapt to narrow viewports, and non-essential motion respects
prefers-reduced-motion.

The UI does not fabricate agent positions or role labels. Structural panels are
computed from recorded metrics. Event payloads are rendered as text, never as
HTML.

## Authentication

The internal Observer omits application authentication and must remain on the
isolated Compose control network.

When --auth-token-file is configured, all /api/runs... evidence routes require
one exact Bearer token. The routes /, /assets, /api, /healthz, and /readyz remain
public so the UI and infrastructure probes can load. The UI then asks for the
token and keeps it only in JavaScript memory:

- no cookie;
- no localStorage;
- no sessionStorage;
- no URL parameter;
- no log output.

Closing or locking the page clears the UI's reference. The edge deployment still
requires an independent ForwardAuth/SSO middleware; that middleware must not
consume the application's Authorization header.

## HTTP contract

All routes are GET only and reject request bodies.

| Route | Auth | Purpose |
| --- | --- | --- |
| / | No | Observer HTML |
| /assets/observer.css | No | Self-contained stylesheet |
| /assets/observer.js | No | Self-contained UI application |
| /api | No | Machine-readable service and link contract |
| /healthz | No | Process liveness |
| /readyz | No | Evidence-volume readiness |
| /api/live | Conditional | Universe head for the live experiment (`genesis-live`/`U0001`) |
| /api/runs | Conditional | Bounded run catalogue |
| /api/runs/:runId | Conditional | Manifest, summary, and attestation |
| /api/runs/:runId/metrics | Conditional | Bounded validated metric history |
| /api/runs/:runId/events?after=N&limit=N | Conditional | Cursor-paginated redacted events |
| /api/runs/:runId/head | Conditional | Stat-based head: last seq/tick, event bytes, latest checkpoint tick, completed |
| /api/runs/:runId/state | Conditional | WorldState projected from the latest checkpoint plus the event tail |

Metric history is limited to 8 MiB per Observer response. Oversized history is
rejected with 413 artifact_too_large; the underlying evidence verifier retains
its separately documented 64 MiB validation boundary. Event pages allow at most
1,000 records and 4 MiB of response data.

### Live universe head (`/api/live`)

`/api/live` reports the head of the single live universe (`genesis-live`
experiment, universe `U0001`) as
`{experimentId, universeId, currentRunId, epoch, head:{lastSeq,lastTick},
boundary, cognitionHealth:{window,consulted,unavailable,starved}, chain}`.
`chain` is read from the universe's `chain/*.json` index (one entry per
completed epoch: `{epoch, runId, commitment, engineVersion, anchoredAt}`), with
`anchoredAt` merged in from `anchors/<epoch>.json` when that anchor has been
recorded. `cognitionHealth` tallies `cognition.recorded` events by
`data.provider` (`unavailable`/`starved` vs. every other value, counted as
`consulted`) over the trailing 50 ticks of the head run.

Neither `chain/` nor `anchors/` need exist yet — the live engine that writes
them is a later phase. Every field on this route degrades to `null`, `false`,
or zero instead of failing: an unstarted universe, a run mid-epoch-boundary
(the current epoch has a `summary.json` but is not yet in `chain/`), or an
unreadable head run all produce a well-formed, empty-ish response rather than
an error. Run discovery (here and everywhere else) skips the reserved live
directory names `chain`, `anchors`, `tasks`, `verdicts`, and `physics` so a
growing epoch index never counts against the catalogue's scan bounds and is
never mistaken for a run.

### Run head and state (`/api/runs/:runId/head`, `/api/runs/:runId/state`)

`/head` is stat-based: `lastSeq`/`lastTick` come from the final line of
`events.jsonl` (a bounded tail read, not a full scan), `eventsBytes` from a
single `stat`, `latestCheckpointTick` from the `checkpoints/` directory's
filenames (no checkpoint file is opened), and `completed` from whether
`summary.json` exists.

`/state` projects a `WorldState` from the latest checkpoint (or, absent one,
from genesis) plus every event after it, applied with the same reducer
(`applyWorldEventMutable`) evidence and replay use. The checkpoint read is
capped at 8 MiB (413 artifact_too_large beyond that); the final redacted
response is capped at 4 MiB, matching `/events` (413 state_too_large beyond
that). The response is otherwise redacted exactly like every other route.

### Conditional requests

`/api/runs/:runId/events`, `/head`, and `/state` return an `ETag` derived from
the run's `events.jsonl` identity (device, inode, size, and both timestamps —
never its content). A matching `If-None-Match` short-circuits to `304` before
any scan or projection work. The ETag is intentionally shared across all three
routes for one run: if the event log has not changed, none of them have.

## Response security

The Observer sets a same-origin content security policy and denies framing,
cross-origin resource use, MIME sniffing, DNS prefetch, ambient browser
permissions, and referrer disclosure. Evidence responses are no-store.

These headers are defense in depth. TLS, HSTS, SSO, edge rate limits, and
in-flight request limits remain the reverse proxy's responsibility.
