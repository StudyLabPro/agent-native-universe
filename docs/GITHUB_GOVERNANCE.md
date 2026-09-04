# GitHub governance and validation

The repository uses one pull-request validation boundary and keeps expensive depth explicitly opt-in.

## Ready pull requests

`.github/workflows/ci.yml` runs only for pull requests targeting `master`. Draft pull requests skip runner work, and a newer commit cancels the stale run for the same pull request. The workflow classifies the changed paths before installing dependencies:

- runtime, tests, package metadata, validation data, and experiment code run the Node.js 22 test universe and then the science guard (`live-isolation`, below);
- container inputs run the fail-closed Compose configuration check and production image build;
- documentation and governance-only changes record an explicit skip decision while still reporting the protected check.

Repository rules require the stable `PR Gate` context after it is proven on a real ready pull request. Runtime tests, the science guard and the path-aware container contract run as conditional steps inside that single bounded runner job.

There is no feature-branch push CI and no post-merge duplicate validation.

## Science guard (`live-isolation`)

Genesis-Live is a fourth identity of the one lab engine, so the PR Gate carries a second contract next to the test universe: the scientific track (`genesis-1`) must be byte-identical before and after any change. The step `Guard the scientific track against Genesis-Live (live-isolation)` runs `npm run check:live-isolation` (`.github/scripts/check-live-isolation.mjs`) after the test universe on every ready pull request that touches runtime paths, regenerating and hash-comparing the five §33 arms at the 600-tick default. A second step, `Guard the scientific track against Genesis-Live (live-isolation, 200-tick fixtures)`, immediately follows it and runs the same script with `--ticks 200`, so both fixture sets in `experiments/genesis-1/expected/*.json` are regenerated and enforced by name in the workflow, not only validated for shape by `checkFixtureIdentity`. (The 200-tick readout is also regenerated inside `test/lab-live-identity.test.mjs`, which runs as part of `npm test` in the step above; the dedicated step exists so the enforcement is visible in the workflow itself rather than only inside a test file.) Both are steps of the single `PR Gate` job rather than jobs of their own because the policy allows exactly one runner job; each is fail-closed and reports one `ok`/`FAIL` line per check. The second invocation reuses the same `dist/` (already built and unchanged since the first), so it only pays for the checks themselves — regeneration at 200 ticks takes roughly a quarter of the 600-tick cost.

What it proves, in order:

- **build** — `dist/` is rebuilt when it is missing or older than `src/`, so the gate never checks a stale engine;
- **import graph** — `src/lab/live/**` never reaches `src/core/*` runtime code (only `src/core/types.ts`), `src/runtime/*` or `src/v2/*`; `src/lab/*` never imports `src/core/link-protocol`, `src/runtime/*` or `src/v2/*`; `baselines`, `population`, `pareto` and `genesis` never import `src/lab/live/*`; Pareto readouts are computed only by `population.ts` and the `baselines` command, the two instruments whose inputs are gated to `genesis-1`;
- **byte identity** — `initialWorldState(logical manifest)` and `createGenesisAgents` equal the canonical fixtures in `experiments/genesis-1/expected/`; the frozen task-family list carries no `external`; the fixtures themselves describe the five logical §33 arms under the engine version this build carries;
- **refusal** — the projector, the replay engine and the protocol verifier refuse a live manifest in memory; `EvidenceStore.openExisting`, `anu lab replay`, `attest` and `verify-attestation` refuse stored live evidence; a canary manifest planted under a `genesis-1` evidence tree is refused; `runPopulation` and `runGenesis` refuse live and canary configurations before touching the disk; the CLI refuses the scientific instruments for live identities both by `--experiment` and by `--config`, and refuses the canary without a cohort, with a control arm or with a population universe id;
- **readouts** — `experiments/genesis-1/aggregate-arms.mjs` filters `manifest.experimentId === "genesis-1"` (checked in the source and at run time against planted canary and live evidence); `experiments/genesis-1/BASELINES.md` and `experiments/genesis-1/config.json` carry no live or canary marker;
- **regeneration** — the five §33 arms `U0001..U0005` are regenerated from the default config into a temporary directory and every hash (`runId`, `configHash`, event and state hashes, `metricsHash`, attestation `commitment`, `latestMetrics`) is compared with `experiments/genesis-1/expected/U000{1..5}.json`. CI never reads `runs/`, which is not in git.

A regeneration mismatch is a scientific regression. The fixtures change only when an engine version bump is the documented intent, in the same change as the bump and its `CHANGELOG.md` entry — never to make the gate pass.

Options: `--ticks 600|200` selects the readout (`npm run check:live-isolation` and `npm run check` default to 600; the PR Gate additionally runs an explicit `--ticks 200` step, and `npm test` independently regenerates the 200-tick readout from inside `test/lab-live-identity.test.mjs`), `--parallel N` bounds the concurrently regenerated arms, `--skip-regeneration` runs only the static and refusal checks, `--build` forces a rebuild and `--no-build` refuses a stale one. Exit codes: 0 isolated, 1 a check failed, 2 usage or build error.

## Heavy validation

`.github/workflows/heavy-validation.yml` has only a `workflow_dispatch` trigger. Its selectable scopes cover:

- Node.js 24 compatibility;
- additional production image and Compose validation on demand;
- production dependency audit;
- the bounded capacity profile;
- a full sequential validation combining those checks.

Every scope is fail-fast within one bounded runner job. The workflow has no schedule and is not a required merge check.

## Releases

`.github/workflows/release.yml` retains the existing `v*.*.*` tag contract. It verifies that the tag matches the package version and resolves to `master` history, refuses an already-published release, validates release behavior and package contents, builds and publishes the image, creates checksums and an SBOM, then attaches all assets to a draft before publication. Repository release immutability protects future published assets and their tags. The release token receives write permissions only in the release job.

## Local checks

```bash
npm ci --ignore-scripts
npm run check
docker compose --env-file .env.example -f compose.lab.yml config --quiet
git diff --check
```

`npm run check` is the test universe, the workflow policy check and the science guard at its 600-tick default. For a quick local pass of the guard alone: `node .github/scripts/check-live-isolation.mjs --ticks 200` (or `--skip-regeneration` for the static and refusal checks only).

The workflow policy check is part of `npm run check`; it rejects schedules, mutable action references, automatic Heavy Validation triggers, missing job timeouts, expansion beyond one PR runner job, removal of the stable `PR Gate`, semantic workflow validation, or container build, and changes to the tag-release trigger or ancestry check.
