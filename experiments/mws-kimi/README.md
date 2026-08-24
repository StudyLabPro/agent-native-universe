# Live metering audit — MWS Cloud (Kimi K2.6)

A falsification run of the metered-cognition claims against a real reasoning
model, rather than a stub. Nothing here is mocked: the agent is a real
`NanoAgent`, the economy is `PersistentResourceEconomy`, the loop is
`MeteredCognitiveLoop`, and the model is a live deployment on MWS Cloud.

## Running it

```bash
npm run build
MWS_API_KEY=<service-account API key> node experiments/mws-kimi/verify.mjs
```

| Variable | Default |
|---|---|
| `MWS_API_KEY` | required — the run refuses to start without it |
| `MWS_BASE_URL` | `https://gpt.mwsapis.ru/projects/project-vxgxs2/openai/v1` |
| `MWS_MODEL` | `kimi-k2-6` |

The process exits non-zero if any hypothesis is refuted. A run costs a few
thousand model tokens and takes several minutes, because a reasoning model
spends most of its output budget on tokens you never see.

## What the run established

Kimi reached the runtime through the stock `OpenAICompatibleProvider` with no
new adapter code: only a base URL, a key and a model name. Metering, double-entry
settlement, conservation and mutation of the agent's bounded local world all
behaved as documented, including billing for reasoning tokens the caller never
sees — in one run 1,676 of 1,831 completion tokens were invisible reasoning, and
the agent paid for all of them.

Three claims did not survive first contact.

**The requested output cap is advisory.** Asked for `max_tokens=32`, the
provider returned 3,263 output tokens with `finish_reason: "stop"`. Verified
separately at 16, 64 and 256. A per-thought bound expressed only as `maxTokens`
binds nothing.

**A reservation was not a ceiling.** `ensureReservationCapacity` silently drew
the difference from the agent's balance whenever real usage exceeded the
reservation, so a solvent agent had no enforced per-thought limit. Combined with
the point above, an agent could spend several times what it reserved without
anything in the system objecting.

**Spend that had already happened could be refunded.** The `catch` in `think()`
refunded the reservation regardless of whether the provider had answered. A
thought that failed after a completion returned — an overrun, a malformed
payload — left the ledger recording zero for tokens that were really burned.

## What changed as a result

`overrunPolicy: "reject"` makes the reservation a real ceiling: the provider is
still paid for work it genuinely performed, but only up to the reservation, and
the breach surfaces as `CognitiveOverrunError` carrying the unbilled remainder.
Overruns are now reported in `ThoughtResult.overruns` even when absorbed, because
an overrun nobody can observe is indistinguishable from a bound that works.

Failure handling now distinguishes a thought that never reached the provider —
still refunded in full — from one that failed after the provider answered, which
settles the delivered usage and declares any shortfall it could not bill.

The enforcement point moved from the provider to the economy, which is the only
layer that can hold it: a provider may always ignore what the caller asked for.

Re-running the harness after these changes leaves one refutation standing — the
provider still ignores `max_tokens`, and no library change can alter that.

## Regression cover

The three findings are pinned by deterministic tests in
`test/autonomous-runtime.test.mjs`, which use a fake provider and need no
credentials or network.
