# Security policy

## Supported versions

Security fixes are provided for the latest 1.x release line.

| Version | Supported |
| --- | --- |
| 1.x | Yes |
| < 1.0 | No |

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
vulnerability reporting for this repository:

Security → Advisories → Report a vulnerability

Include the affected version, threat model, reproduction steps, expected impact,
and any proposed mitigation. Do not include live credentials, provider keys,
private evidence, or data from systems you do not own.

The maintainers will acknowledge a complete report, assess severity, coordinate
a fix and disclosure, and credit the reporter when requested. No response-time
or bounty commitment is implied.

## Security boundary

ANU v1 provides defense-in-depth controls for its documented runtime and
Universe Lab evidence paths. It is not a formally verified system and has not
received an independent security audit.

In particular:

- keep unauthenticated Observer instances on isolated internal networks;
- expose the edge only with both application Bearer authentication and a
  separately operated ForwardAuth/SSO layer;
- publish final evidence commitments outside the evidence host;
- never mount the Docker socket or provider credentials into universe workers;
- route cognitive workers through the internal gateway network only, keep the
  provider credential file-mounted in the gateway, and never publish its port;
- enforce the hard financial ceiling on the provider-scoped key/account; the
  gateway's accounted-token threshold is necessarily post-response and resets
  with the process;
- treat agent-authored content, capabilities, and LLM output as untrusted input;
- apply resource, network, filesystem, and process limits at deployment time.

See docs/LAB_DEPLOYMENT.md and docs/LLM_GATEWAY.md for the concrete
production-lab and cognitive-egress boundaries.
