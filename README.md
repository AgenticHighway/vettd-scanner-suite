# vettd-scanner-suite

Unified scanner suite for the `vettd` ecosystem — a standalone HTTP service
that orchestrates first-party scanners (`vettd-skill-scanner`, via its Rust
HTTP shim) and third-party integrations (Cisco AI Defense, Socket) behind a
single normalized findings contract.

Private repo; `license` is intentionally `UNLICENSED` while source-available
vs. open-source is still undecided. Tracking issue:
[AgenticHighway/vettd#643](https://github.com/AgenticHighway/vettd/issues/643).
Architecture details: [docs/design.md](docs/design.md).

## Repo layout

| Path | What it is |
|---|---|
| `src/contract/` | Canonical findings contract (`AssetFinding`, scanner interfaces) |
| `src/config/` | TOML config schema, loading, validation |
| `src/intake/` | Zip extraction and validation |
| `src/core/` | Runner fan-out, config-driven registry, job store/executor |
| `src/adapters/` | Per-scanner normalization (vettd, cisco, socket, SARIF mapping) |
| `src/server/` | Fastify app and service entry point |
| `shims/cisco/` | Python shim wrapping the `cisco-ai-skill-scanner` pip package |
| `.postman/` | Postman smoke-test collection; see `.postman/README.md` |
| `docs/` | Design docs |

## Quickstart

```bash
cp scanner-suite.example.toml scanner-suite.toml   # then adjust; gitignored

# terminal 1 — first-party scanner shim (in the vettd-skill-scanner repo):
cargo run -p http-shim

# terminal 2 — the suite:
pnpm install
pnpm build
node dist/server/index.js scanner-suite.toml

# submit a scan and poll it:
curl -sS -X POST --data-binary @skill.zip -H 'content-type: application/zip' \
  http://127.0.0.1:8080/scans
curl -sS http://127.0.0.1:8080/scans/<jobId>
```

Scanners are disabled unless enabled in the TOML. `SOCKET_API_KEY` comes from
the environment — secrets never go in the config file.

## Development

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
