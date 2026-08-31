# Contributing

Agent Native Universe welcomes focused bug fixes, tests, documentation, and
well-scoped runtime improvements.

## Development contract

Requires Node.js 22 or newer. Keep code compatible with the Node.js 22 type
surface; CI also verifies the Node.js 24 Active LTS line.

```bash
npm ci --ignore-scripts
npm run check
docker compose --env-file .env.example -f compose.lab.yml config --quiet
```

Before opening a pull request:

1. preserve deterministic behavior and add a regression for every protocol or
   evidence semantic change;
2. do not weaken resource conservation, ownership, authentication, replay, or
   filesystem fail-closed boundaries;
3. update the affected public documentation and changelog;
4. keep runtime dependencies at zero unless the change has a compelling,
   reviewed operational reason;
5. run git diff --check and the complete test universe.

GitHub validates ready pull requests through the path-aware PR Gate. Draft pull
requests do not consume runner work. Use the manually dispatched Heavy
Validation workflow when Node.js 24 compatibility, the production image,
dependency security, or capacity behavior needs additional validation. See
`docs/GITHUB_GOVERNANCE.md` for the stable check and release contracts.

## Universe Lab changes

The Lab separates three authorities:

- the ANU runtime defines interaction laws;
- Universe Lab defines objective world physics and evidence;
- Genesis-1 defines one immutable experiment.

Do not introduce human job titles, teams, services, expected answers, or hidden
oracles into agent observations or the neutral policy. A semantic engine,
policy, task-generator, or evidence change must update the manifest-bound
identity deliberately and retain compatible historical replay behavior.

## Security and privacy

Never commit .env files, provider keys, Bearer tokens, private evidence,
chain-of-thought, or credentials. Use file-backed secrets and safe placeholders.
Report vulnerabilities through SECURITY.md, not a public issue.

## Pull requests

Keep a pull request small enough to review as one coherent change. Describe:

- the invariant or user outcome being changed;
- the verified facts and engineering assumptions;
- compatibility and security impact;
- exact validation commands and results.
