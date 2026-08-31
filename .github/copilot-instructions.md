# Repository instructions

Follow `AGENTS.md`, `CONTRIBUTING.md`, and `SECURITY.md` for every change.

- Preserve deterministic runtime behavior and fail-closed security boundaries.
- Add regression coverage for semantic changes.
- Keep GitHub Actions pull-request-first, path-aware, least-privileged, bounded by job timeouts, and pinned to immutable action commits.
- Never add scheduled or feature-branch push validation. Keep the required container contract path-aware; additional compatibility, container, security, and benchmark depth belongs in the manually dispatched Heavy Validation workflow.
- Never include credentials, private evidence, or sensitive runtime data in code, logs, fixtures, documentation, or pull requests.
