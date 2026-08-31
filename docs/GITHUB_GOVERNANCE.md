# GitHub governance and validation

The repository uses one pull-request validation boundary and keeps expensive depth explicitly opt-in.

## Ready pull requests

`.github/workflows/ci.yml` runs only for pull requests targeting `master`. Draft pull requests skip runner work, and a newer commit cancels the stale run for the same pull request. The workflow classifies the changed paths before installing dependencies:

- runtime, tests, package metadata, validation data, and experiment code run the Node.js 22 test universe;
- container inputs run the fail-closed Compose configuration check and production image build;
- documentation and governance-only changes record an explicit skip decision while still reporting the protected check.

Repository rules require the stable `PR Gate` context after it is proven on a real ready pull request. Runtime tests and the path-aware container contract run as conditional steps inside that single bounded runner job.

There is no feature-branch push CI and no post-merge duplicate validation.

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

The workflow policy check is part of `npm run check`; it rejects schedules, mutable action references, automatic Heavy Validation triggers, missing job timeouts, expansion beyond one PR runner job, removal of the stable `PR Gate`, semantic workflow validation, or container build, and changes to the tag-release trigger or ancestry check.
