## Outcome

Describe the user-visible or repository-level outcome and the invariant being changed.

## Risk and compatibility

Describe compatibility, security, release, and rollback considerations. Separate verified facts from assumptions.

## Validation

- [ ] `npm ci --ignore-scripts`
- [ ] `npm run check`
- [ ] `docker compose --env-file .env.example -f compose.lab.yml config --quiet` when container files change
- [ ] Heavy Validation was dispatched when compatibility, additional container, security, or benchmark depth was needed

List the exact commands that ran and their results. Do not include credentials, private evidence, or sensitive runtime data.
