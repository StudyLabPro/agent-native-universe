# Repository agent instructions

This is a public repository. Changes must be reviewable from public information in this repository and must not expose credentials, private evidence, unpublished implementation details, or external infrastructure context.

## Engineering contract

- Read `CONTRIBUTING.md` and `SECURITY.md` before changing runtime behavior.
- Preserve deterministic behavior, resource conservation, ownership, authentication, replay, and filesystem fail-closed boundaries.
- Add a regression test for every protocol or evidence semantic change.
- Keep Node.js 22 as the minimum supported runtime unless the engine, type surface, container image, documentation, and compatibility validation change together.
- Use exact dependency lockfiles and safe placeholders. Never commit live secrets or private data.

## GitHub governance contract

- Use pull requests for `master`; do not add feature-branch push CI.
- Draft pull requests must not run expensive validation. Ready pull requests use the path-aware PR Gate.
- Keep the stable required check name `PR Gate` and its single-runner design.
- Keep the container build path-aware inside `PR Gate`. Additional compatibility, container, security, and benchmark depth stays manual through `workflow_dispatch`; do not add schedules.
- Pin third-party GitHub Actions to full commit SHAs, grant least-privilege token permissions, cancel stale pull-request runs, and set a timeout on every runner job.
- Preserve the `v*.*.*` tag release contract. Release changes require explicit review and local release verification.

## Local validation

Run the smallest relevant checks while editing, then run the complete local contract before handoff:

```bash
npm ci --ignore-scripts
npm run check
docker compose --env-file .env.example -f compose.lab.yml config --quiet
git diff --check
```

Report which checks ran, their exact results, and whether any GitHub Actions workflow was dispatched.
