# LLM gateway

The Universe Lab gateway is the single controlled egress point between a
cognitive universe and an OpenAI-compatible model provider. It is operational
infrastructure, not part of the deterministic evidence projector.

```text
lab-runner-cognitive ── internal llm-control ──> lab-llm-gateway ──> provider
       no egress                                  only egress role
       gateway token                              provider key
       evidence writer                            metadata audit
```

The worker never receives the provider credential. The gateway accepts only
`POST /v1/chat/completions`, refuses streaming and redirects, applies model,
request-rate and in-flight limits, bounds both request and response bodies, and
writes metadata-only audit records. It never writes prompts, responses or
credentials to the audit file.

## Security and metering boundary

The following controls are enforced before forwarding:

- exact client Bearer authentication on any non-loopback bind;
- model allowlist;
- process-lifetime request count;
- sliding request rate;
- simultaneous in-flight request count;
- 1 MiB request-body and configurable response-body limits;
- HTTPS upstreams, except explicit loopback development endpoints;
- no upstream credentials, query or fragment in the configured URL;
- no redirects.

Successful provider responses must contain non-negative, internally consistent
OpenAI-style `usage` fields. Missing or invalid usage degrades readiness and
stops subsequent forwarding. Audit-write failure also fails closed.

`--max-total-tokens` is a post-response stop threshold, not a hard billing cap.
With non-streaming completions, authoritative usage arrives only after the
provider has performed the work. The response that crosses the threshold is
returned and recorded; later requests receive `429`. Concurrent requests can
cross the threshold as a bounded burst, and a provider may ignore its requested
output limit. Configure a provider-side hard currency quota on the dedicated
provider key. `--max-in-flight` and `--max-requests` bound exposure between
accounting updates.

Gateway counters are process-local by default. Restarting the gateway resets
them, so an experiment-wide cap must be enforced at the provider unless
`--state-file` is configured (see below); the Compose canary profile therefore
uses `restart: "no"` and does not set it. The audit log is append-only
operational metadata, bounded by `--max-audit-bytes` (or rotated with
`--audit-rotate`); it is neither hash-chained scientific evidence nor an
external trust anchor.

`--budget-window-ms` together with `--max-tokens-per-window` and/or
`--max-requests-per-window` adds a sliding-window budget on top of the
process-lifetime `--max-total-tokens`/`--max-requests` caps: once the window's
accounted usage (or request count) reaches the threshold, further requests
receive `429` until the oldest entries slide out of the window. Like
`--max-total-tokens`, the token variant is a post-response stop threshold, not
a hard cap — the response that crosses it is still returned and accounted.

## HTTP surface

| Route | Authentication | Purpose |
| --- | --- | --- |
| `GET /healthz` | none | process liveness, no counters |
| `GET /readyz` | none | audit and metering readiness |
| `GET /identity` | none | manifest-safe hash of configured upstream and model allowlist |
| `POST /v1/chat/completions` | Bearer when configured | bounded non-streaming completion |

The identity response contains no provider URL. Its `gateway-v1-…` identifier
hashes the normalized configured upstream; the cognitive runner reads it before
creating the run manifest. Changing the upstream URL therefore changes
`cognitionId` and `runId`, even though the worker connects to the same gateway
hostname. A provider that changes routing behind one unchanged URL remains an
external provenance limitation and should receive a new endpoint or explicit
treatment identity.

## Local command

Build, inspect help, and start a loopback-only gateway:

```bash
npm run build
node dist/lab/runner.js gateway --help
node dist/lab/runner.js gateway \
  --upstream https://provider.example/v1 \
  --api-key-file /run/secrets/provider-key \
  --auth-token-file /run/secrets/gateway-token \
  --models model-id \
  --max-requests 250 \
  --max-total-tokens 1000000 \
  --rate-per-minute 30 \
  --max-in-flight 4 \
  --audit ./runs/gateway.jsonl \
  --audit-rotate 5 \
  --state-file ./runs/gateway-state.json \
  --budget-window-ms 3600000 \
  --max-tokens-per-window 200000 \
  --metering-failure-mode latch
```

`--api-key-env NAME` is available for local operation, but the Compose profile
uses `--api-key-file`. Secret values are never accepted as CLI arguments.

## Audit rotation, persisted state, and the metering-failure-mode exit path

By default the gateway is deliberately fragile at two points: the audit file
fails closed once it reaches `--max-audit-bytes`, and its counters live only
in process memory. Both defaults keep a short-lived experimental run honest
without any extra configuration. A long-lived deployment (the C1 canary and
beyond) needs the opposite properties, so both are opt-in:

- **`--audit-rotate N`** (requires `--audit`): once the active audit file
  would exceed `--max-audit-bytes`, it is rotated to `<path>.1` (shifting any
  existing `.1 … .(N-1)` up by one and dropping `.N`) and a fresh active file
  is started, instead of the gateway refusing further requests.
- **`--state-file PATH`**: the accounted token/request counters and the
  sliding budget window are written to `PATH` after every metered response and
  on `close()`, and loaded back in `listen()`. A restart therefore continues
  the same budget instead of granting a new one. The file is written
  atomically (temp file + `fsync` + rename) and is keyed to the gateway's
  identity (`gatewayId`, derived from the upstream URL); pointing a
  differently-configured gateway at someone else's state file is refused
  rather than silently adopted. The in-memory counters update before that
  write completes, so a crash inside that narrow window under-counts the most
  recent response by up to one request's tokens on restart (never
  double-counts) — an accepted, bounded margin for a file that is operational
  metering, never evidence.
- **`--metering-failure-mode latch|exit`** (default `latch`): decides what
  happens when audit or metering can no longer be trusted (audit write
  failure, unmetered or invalid usage, an oversized response). `latch` keeps
  the process alive answering `503` until an operator restarts it — the
  existing behaviour. `exit` additionally persists the state file and hands
  the process to its supervisor once the failing response has already been
  sent, exiting with code `75` (`EX_TEMPFAIL`, exported as
  `LLM_GATEWAY_FATAL_EXIT_CODE`): a signal to retry after a restart, not a
  misconfiguration. Combined with `--state-file`, a supervisor can restart the
  gateway immediately and it continues the same budget rather than resetting
  it.

## Compose cognitive profile

Create two files outside the repository: a provider-scoped credential with a
provider-side spend cap and an independent random gateway client token. The
gateway token must contain 32–4096 token68 bytes. Make both files readable by
container UID 1000, then point these environment variables at them:

```text
ANU_LLM_PROVIDER_KEY_FILE=/absolute/path/provider-key
ANU_LLM_GATEWAY_TOKEN_FILE=/absolute/path/gateway-token
ANU_LLM_UPSTREAM=https://provider.example/v1
ANU_LLM_MODEL=model-id
```

Validate both the default and cognitive models before starting anything:

```bash
docker compose --env-file .env.example -f compose.lab.yml config
docker compose --env-file .env.example -f compose.lab.yml \
  --profile cognitive config
```

Start one gateway and one cognitive runner:

```bash
docker compose --env-file /absolute/path/anu-cognitive.env \
  -f compose.lab.yml --profile cognitive up --build \
  --abort-on-container-exit --exit-code-from lab-runner-cognitive \
  lab-runner-cognitive
```

The checked-in defaults are a bounded canary: `50` ticks × `4` consulted
agents per tick plans at most `200` requests against a `250`-request gateway
cap. When changing either workload input, keep
`ANU_LLM_GATEWAY_MAX_REQUESTS >= ANU_LLM_TICKS * ANU_LLM_AGENTS_PER_TICK`.
The token threshold cannot be proven from those inputs because prompt usage is
provider-tokenizer-dependent and a provider can ignore output limits. If a
threshold is reached, later consultations are recorded as provider failures and
the run is a pressure/fallback treatment, not a clean full-LLM treatment.

The checked-in `/dev/null` secret defaults intentionally make this profile fail
closed. The gateway joins `llm-control` and `llm-egress`; the cognitive worker
joins only the internal `llm-control` network. Neither service publishes a host
port or joins the Traefik edge network.

## Failure semantics

- rejected requests never reach the provider and receive a structured JSON
  error;
- provider timeouts/unavailability become `504`/`502` and are audited; a
  provider may still bill ambiguous work for which no usage response reached
  the gateway, so only its own hard account limit is authoritative;
- a successful but unmetered response becomes `502`, readiness becomes `503`,
  and subsequent completions fail closed (`latch`) or the process exits with
  code `75` after persisting the state file (`--metering-failure-mode exit`);
- an oversized successful response also degrades metering because its usage is
  unknowable after truncation, and takes the same `latch`/`exit` path;
- a sliding-window budget (`--budget-window-ms`) refusal is a plain `429`, not
  a metering degradation — the window itself remains trustworthy and slides
  back open on its own;
- shutdown aborts tracked upstream requests, closes client connections, drains
  the serialized audit queue, persists the state file when one is configured,
  and emits `listening → stopping → stopped` JSON lifecycle records.

Provider failure is still captured by the cognitive universe as a recorded
fallback event. The gateway audit is complementary operational evidence; it
must not be substituted for the universe's hash-chained cognition records.
