# Expected evidence of the §33 logical arms

These fixtures are the science guard's reference (design §4.P; script
`.github/scripts/check-live-isolation.mjs`, npm script `check:live-isolation`).
They pin, per universe, the identity and every hash of the five §33 control
arms run on the default seed with the default `genesis-1` config, so that a
Genesis-Live change which alters the scientific engine by even one byte is
caught by regeneration — without CI ever reading `runs/`, which is not in git.

| File | Arm | Universe | Policy |
|---|---|---|---|
| `U0001.json` | A | `U0001` | `neutral-backpressure-v1` (self-organizing network) |
| `U0002.json` | C | `U0002` | `neutral-backpressure-v1`, zero action costs |
| `U0003.json` | D | `U0003` | `baseline-no-links-v1` |
| `U0004.json` | E | `U0004` | `baseline-central-dispatch-v1` |
| `U0005.json` | F | `U0005` | `baseline-fixed-roles-v1` |

Each file carries two runs, keyed by tick count: `600` (the full crisis
program, readout 2 of `BASELINES.md`) and `200` (readout 1). Both have seed
`genesis-1-default`, 16 agents, `taskStream.realizationSeed = genesis-1-default`,
engine `genesis-logical-v1.1.0`. A run entry holds `runId`, `configHash`,
`events`, `finalEventHash`, `finalStateHash`, `metricsHash`, the attestation
`commitment` and `latestMetrics` — exactly what `summary.json` and
`attestations/final.json` of the regenerated run must reproduce.

`initial-world-state.canonical.json` and `genesis-agents.canonical.json` are
the canonical JSON of `initialWorldState(createRunManifest(DEFAULT_GENESIS_CONFIG, "U0001"))`
and `createGenesisAgents(DEFAULT_GENESIS_CONFIG)`; they enforce the
`stateHash` discipline: no live-only field may ever appear in a non-live state.

## Provenance

Captured once, in phase L0 of Genesis-Live, from the engine at
`master@625b81d` (`genesis-logical-v1.1.0`) and verified against the
original evidence directories `runs/genesis-1/U0001..U0005` of the same
build: `manifest.json`, `summary.json`, `attestations/final.json` and the
SHA-256 of `events.jsonl` were identical for all ten runs. The fixtures are
therefore the evidence, not a re-description of it.

## Regenerating

```bash
npm run build
node .github/scripts/check-live-isolation.mjs              # 600-tick runs, CI default
node .github/scripts/check-live-isolation.mjs --ticks 200  # readout-1 runs, used by npm test
```

The five arms are regenerated in parallel with
`anu lab genesis-1 --config <tmp> --arm <A|C|D|E|F> --universe-id U000k`.
A mismatch is a scientific regression: never update these files to make the
guard pass unless an engine version bump is the documented intent, and then
record the bump in `CHANGELOG.md` together with the new fixtures.
