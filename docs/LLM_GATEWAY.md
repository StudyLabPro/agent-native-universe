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

Gateway counters are process-local in this version. Restarting the gateway
resets them, so an experiment-wide cap must be enforced at the provider and the
gateway must not be restarted as a way to extend a treatment. The Compose
service therefore uses `restart: "no"`. The audit log is append-only
operational metadata, bounded by `--max-audit-bytes`; it is neither hash-chained
scientific evidence nor an external trust anchor.

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
  --audit ./runs/gateway.jsonl
```

`--api-key-env NAME` is available for local operation, but the Compose profile
uses `--api-key-file`. Secret values are never accepted as CLI arguments.

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
  and subsequent completions fail closed;
- an oversized successful response also degrades metering because its usage is
  unknowable after truncation;
- shutdown aborts tracked upstream requests, closes client connections, drains
  the serialized audit queue, and emits `listening → stopping → stopped` JSON
  lifecycle records.

Provider failure is still captured by the cognitive universe as a recorded
fallback event. The gateway audit is complementary operational evidence; it
must not be substituted for the universe's hash-chained cognition records.
