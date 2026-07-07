# vettd-scanner-suite

Unified scanner suite for the `vettd` ecosystem — orchestrates first-party
scanners (e.g. `vettd-skill-scanner`) and third-party integrations (e.g.
Cisco AI Defense, Socket) behind a single normalized findings contract.

**Status:** early scaffolding, no application code yet. Private repo;
`license` is intentionally `UNLICENSED` while source-available vs.
open-source is still undecided.

## Consumers

- The `vettd` web app's scanning backend (cloud deployment).
- Local/power-user runs via a distributable Docker image.

See [AgenticHighway/vettd#643](https://github.com/AgenticHighway/vettd/issues/643)
for the tracking issue.

## Development

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
