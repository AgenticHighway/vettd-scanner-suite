# vettd-scanner-suite design

Architecture and behavior reference for the suite. Decision history lives in
[AgenticHighway/vettd#643](https://github.com/AgenticHighway/vettd/issues/643)
(and #642 for the skill-scanner extraction).

## Architecture

The suite is a standalone Fastify HTTP service that orchestrates scanners and
normalizes their output to one findings contract:

```
client ── POST /scans (JSON) ──────────────────────▶ validate (size/file-count) ──▶ job store/executor
       └─ POST /scans/batch (N targets) ─▶ batch index ─┘                              │
                    ┌── runner fan-out (per-scanner timeout) ◀───────────────────────────┘
                    │
      ┌─────────────┼──────────────────┐
      ▼             ▼                  ▼
 vettd adapter  cisco adapter     socket adapter        ← adapters/ (TS, in-repo)
      │             │                  │
      ▼             ▼                  ▼
 Rust http-shim  Python shim      api.socket.dev        ← transports
 (scanner repo)  (shims/cisco)    (external SaaS)
```

### Ownership boundaries

- **Adapters** (normalization, TypeScript) live in this repo for **every**
  scanner, first- or third-party. A scanner's implementation language never
  leaks into the shared contract.
- **First-party shims** are owned by the scanner's own repo — the Rust
  `http-shim` crate lives in `vettd-skill-scanner` and exposes `GET /health`
  + `POST /scan` on `127.0.0.1` (`VETTD_SHIM_PORT`, default 8788).
- **Third-party shims** (scanners whose source we don't control) live here
  under `shims/` — e.g. `shims/cisco/server.py`, which wraps the
  `cisco-ai-skill-scanner` pip package (`CISCO_SHIM_PORT`, default 8787).
- **Remote SaaS scanners** (Socket) need no shim; the adapter calls the
  external API directly.

Note: `parity-adapter` in the vettd-skill-scanner repo is a **testing tool
only** (Rust-vs-TS parity checks) — it is not an integration path; the
http-shim crate is.

## Findings contract & schema governance

`src/contract/` holds the canonical `AssetFinding` and
`ScannerInput`/`ScannerOutput`/`ScannerRunResult`/`SkillScanner` types. The
`AssetFinding` copy originated in vettd web's `@vettd/types`; the suite copy is
now canonical and vettd web keeps its own copy held honest by contract-drift
tests. A change here is a wire-format change and must be coordinated.

Deliberate drops from the vettd web originals:

- `ScannerInput.zipBuffer` / `.skillAuditId` — no scanner ever read them.
- `ScannerOutput.analysis` (`SkillAnalysisResult`) — a web-side coupling to
  the retired TS analyzer. The first-party scanner's structural flags
  (`hasSkillMd`, `hasScripts`, `hasReferences`, `hasEvals`, `fileCount`)
  travel in `run.rawReport` instead.

Grading/verdict computation stays a consumer concern (vettd web) — the vettd
adapter reports `verdict: null`. Count convention: `criticalCount` counts
critical findings; `highCount` counts critical+high (the cisco adapter's
convention; vettd web's retired `vettd-scanner.ts` hardcoded
`criticalCount: 0` — deliberately not carried forward).

`Date` fields (`scannedAt`, job timestamps) serialize as ISO-8601 strings over
HTTP.

## Job lifecycle

```
POST /scans ──▶ queued ──▶ running ──▶ completed (results attached)
                                  └──▶ failed (infrastructure error only)
```

- Submissions are JSON bodies shaped `{textFiles: Record<string,string>, allPaths: string[]}`, matching the in-memory `ScannerInput` contract. Validation (malformed body, `allPaths` count, per-file and total text-byte sizes) happens **inline at intake** so a bad request fails the `POST /scans` with a 400 immediately. Limits (see `src/consts.ts`): 500 files, 4 MB per text file, 16 MB total text — same caps the old zip path enforced (see `src/intake/zip.ts`, removed in #13). The overall HTTP body is capped at 20 MB by `bodyLimit`.
- The job store is **in-memory behind the narrow `JobStore` interface**
  (`create`/`get`/`transition`/`attachResults`) — the seam for a future
  durable store (SQS/DB). A restart loses jobs; callers see a 404 on poll and
  resubmit.
- Finished jobs are evicted after a 1 h TTL (sweep-on-write); the store caps
  at 1000 jobs, after which submissions get a 429.
- Per-scanner failures (`errored`/`timeout`/`skipped`) are normal run-record
  statuses and still produce a **completed** job; `failed` is reserved for
  infrastructure surprises.
- **Polling (`GET /scans/:id`) is a temporary transport.** The handler in
  `src/server/app.ts` is the designated replacement point for a push
  mechanism (SQS/webhook) once the job store goes durable.

### Batch intake

`POST /scans/batch` submits an array of scan items (`{items: [{textFiles,
allPaths}, ...]}`) and creates one ordinary job per item — **a batch creates
ordinary jobs that drain through the same `[jobs].max_concurrent`; it is a
correlation record, not a scheduling unit.** This does not raise the suite's
throughput ceiling (that was `[scanners.cisco].concurrency`, raised in #23) —
it reduces round trips and open connections for a caller submitting many
targets at once, which matters for a caller running on a constrained task
(e.g. `vettd` `web`'s 0.25 vCPU Fargate service).

- **Per-item accept/reject.** A malformed item or a full job store rejects
  only that item — `{index, error}` in `rejected` — while sibling items queue
  normally. Whole-batch structural errors (bad envelope, empty/oversized
  `items`) still `400` the entire request. **A caller that ignores
  `rejected` silently loses scans** — every index in `[0, n)` appears exactly
  once across `accepted` and `rejected`, so a complete caller must account
  for both arrays.
- **Status-only poll.** `GET /scans/batch/:id` never inlines `results` —
  Cisco's `rawReport` can be multi-MB and this route is meant to be polled on
  an interval. Fetch full results per item from the existing
  `GET /scans/:id`.
- **The batch index (`src/core/jobs/batch-index.ts`) is separate from
  `JobStore`, deliberately.** `JobStore` is the seam for a future durable
  store; a batch is HTTP-layer bookkeeping with the opposite durability
  requirement — losing a job costs a scan, losing a batch entry costs a
  lookup table the caller already holds a copy of. In-memory, 1 h TTL from
  `submittedAt`, capped at 1000 batches (`429` past the cap, mirroring
  `JobStoreFullError`). A job swept by the store's own TTL while its batch
  entry is still live renders as `status: "expired"`, not `"queued"` — the
  same "unrecoverable, resubmit" meaning `GET /scans/:id`'s `404` already
  carries.
- **Sizing a poll deadline.** Items enter the executor in submission order,
  but a batch has no reserved concurrency lane — worst-case drain time is
  `ceil(items / max_concurrent) × per-job duration`. At the defaults (50
  items, `max_concurrent = 2`) that's 25 sequential rounds — several minutes
  at typical per-job duration, far past a poll deadline sized for one scan.
  Callers must size their batch poll deadline from the batch, not from a
  single scan.
- **413 is the one place the per-item promise doesn't hold.** `bodyLimit`
  (20 MB) rejects an oversized request before parsing runs, so an oversized
  batch gets no per-item tolerance and no `{error}` body — just fastify's
  default 413 shape.
- **Batches retained in memory shrink, not grow, versus N single
  submissions.** A queued job holds its `ScannerInput` in RAM until it runs;
  N separate `POST /scans` calls can together retain up to N × 20 MB, while
  one N-item batch is capped at 20 MB total by `bodyLimit`.
- **Naming note:** `vettd`'s own `POST /api/scans/batch` (built against this
  endpoint) is a different, DB-backed entity in a different service, with its
  own `batchId`. Do not conflate the two `batchId`s across the wire boundary.

### HTTP API

| Route | Success | Errors |
|---|---|---|
| `GET /health` | `200 {ok: true}` | — |
| `POST /scans` (JSON body) | `202 {jobId, status}` | `400` malformed body, missing fields, oversized (file count / per-file bytes / total bytes), `413` over bodyLimit, `415` unregistered content type, `429` store full |
| `GET /scans/:id` | `200` job envelope | `404` unknown/evicted id |
| `POST /scans/batch` (JSON body `{items: [...]}`) | `202 {batchId, submittedAt, accepted, rejected}` | `400` malformed envelope / empty / over `max_batch_items`, `413` over bodyLimit, `415` unregistered content type, `429` batch index full |
| `GET /scans/batch/:id` | `200` same shape as the `202` above, `status` per item | `404` unknown/evicted batch id |

App-level errors respond `{error: string}`; fastify-generated errors (413,
415, 500) keep fastify's default `{statusCode, error, message}` shape.
Per-item validation failures and a full job store are **not** batch-level
errors — they appear as `{index, error}` in `rejected` on a `202`.

## Configuration

TOML file, path given as the first CLI arg (default `./scanner-suite.toml`,
gitignored; copy `scanner-suite.example.toml`). Parsing is fail-fast: unknown
tables/keys, non-positive numbers, bad URLs, and non-boolean `enabled` are
startup errors. **Scanners default to disabled** — enablement is always
explicit.

| Key | Default | Meaning |
|---|---|---|
| `server.host` / `server.port` | `127.0.0.1` / `8080` | Listen address |
| `jobs.max_concurrent` | `2` | Scan jobs running simultaneously |
| `jobs.scanner_timeout_ms` | `120000` | Per-scanner hard timeout |
| `jobs.max_batch_items` | `50` | Items allowed in one `POST /scans/batch` submission |
| `scanners.vettd.enabled` | `false` | First-party Rust scanner |
| `scanners.vettd.shim_url` | `http://127.0.0.1:8788` | Rust http-shim address |
| `scanners.vettd.health_timeout_ms` / `.scan_timeout_ms` | `2000` / `30000` | Shim call timeouts |
| `scanners.cisco.*` | as vettd, shim on `8787` | Cisco AI Defense via Python shim |
| `scanners.cisco.concurrency` | `1` | Cisco scans allowed to run at once (≤ the shim's pool size) |
| `scanners.cisco.queue_depth` | `50` | Waiters beyond the in-flight scans before runs skip |
| `scanners.socket.enabled` | `false` | Socket.dev SaaS |
| `scanners.socket.timeout_ms` | `30000` | API call timeout |

Environment-variable carve-outs (deliberately **not** in the TOML):

- `SOCKET_API_KEY` — secret; secrets never go in the config file or git.
- `LOG_LEVEL`, `LOG_PRETTY` — operator log plumbing, not scanner config.
- `VETTD_SHIM_PORT`, `CISCO_SHIM_PORT` — belong to the shim *processes*; the
  suite only knows the URLs its adapters dial.
- `CISCO_SHIM_CONCURRENCY` — the cisco shim's scanner-pool size (default 1).
  Belongs to the shim *process*, like `CISCO_SHIM_PORT`: the shim hands each
  request an exclusively checked-out `SkillScanner` because instances carry
  per-scan mutable state (see `shims/cisco/scanner_pool.py`). Keep it at or
  above `[scanners.cisco].concurrency` — a lower value is safe but serializes
  scans inside the shim. In prod it is set on the `cisco-skill-shim` container
  in the ECS task definition, which `deploy.yml` never rewrites (it patches
  images only), so the value survives deploys and must be changed by hand.

## Local deployment (Docker Compose)

`compose.yaml` brings up the suite and the first-party vettd scanner as
separate containers, wired over the compose network — `docker compose up
--build`. This supersedes the earlier "one image bundles everything" plan
(see #12): independent containers keep each component independently
buildable/rebuildable and failure-isolated, at the cost of the one-artifact
distribution story, which is deferred to a follow-on issue rather than solved
here. Nothing in `src/` changes between this shape and a bare-metal run — the
suite already dials every scanner by URL from config
(`src/adapters/*.ts`), so only config (and the shim processes' bind address)
differ.

- **Config**: `deploy/scanner-suite.docker.toml` (committed — distinct from
  the gitignored `scanner-suite.toml` used for bare-metal runs). Sets
  `server.host = "0.0.0.0"` (required — the suite's default `127.0.0.1` bind
  is only reachable inside its own container) and points
  `scanners.vettd.shim_url` at the compose service hostname
  (`http://vettd-shim:8788`) instead of `127.0.0.1`.
- **Both shims' bind addresses are also not `127.0.0.1` by default across
  containers.** `crates/http-shim/src/main.rs` (in the sibling
  `vettd-skill-scanner` repo) reads an optional `VETTD_SHIM_BIND` env var, and
  `shims/cisco/server.py` reads `CISCO_SHIM_BIND` (default still `127.0.0.1`
  for both, unchanged for bare-metal/CLI use); compose sets both to `0.0.0.0`.
  Any future scanner shim added to compose needs the same treatment.
- **Fast iteration on the first-party scanner**: `vettd-shim`'s compose build
  context is `../vettd-skill-scanner` — a sibling checkout, not a published
  image. Edit that repo, then `docker compose build vettd-shim && docker
  compose up -d vettd-shim` rebuilds/restarts only that service; the suite
  container is untouched. This is the seam to swap for a pinned published
  image (`image: ghcr.io/...`) in remote environments or the future bundle.
- **Cisco runs as a real compose service.** `shims/cisco/Dockerfile` installs
  `cisco-ai-skill-scanner` (range-pinned in `shims/cisco/requirements.txt`)
  into a `python:3.12-slim` image; `[scanners.cisco]` in
  `deploy/scanner-suite.docker.toml` is enabled and points at
  `http://cisco-shim:8787`.
- **Degradation still holds**: stopping/killing a shim container makes its
  scanner report `run.status: "skipped"`, same as an unreachable localhost
  shim — the job still completes (see "Job lifecycle" above).

## Remote dev deployment

Decision recorded on [#4](https://github.com/AgenticHighway/vettd-scanner-suite/issues/4); implementation tracked by [#15](https://github.com/AgenticHighway/vettd-scanner-suite/issues/15).

The suite (and its shims) run on the same EC2 box `vettd`'s own dev
deployment already uses (`vettd`'s `docker-compose.server.yml` /
`deploy-dev.yml`) — not a separate, dedicated instance. Deploys stay
independent: this repo has its own compose file and its own push-triggered
GitHub Actions workflow (targeting the same instance), rather than being
folded into `vettd`'s deploy pipeline.

- **Exposure**: internal-only. The suite has no authn/z surface (see "Out of
  scope" below), so it is never put behind the Cloudflare Tunnel that fronts
  `vettd`'s `web` service — only `web` gets a public route.
- **Networking**: `web` and `suite` come from two independently-deployed
  Compose projects, which by default share neither a network nor DNS. They're
  bridged by one shared external Docker network, `vettd-dev-net`, created
  once on the box (`docker network create vettd-dev-net`) and declared
  `external: true` in both this repo's dev compose file and `vettd`'s
  `docker-compose.server.yml`. `suite` joins its own project's default
  network (to reach `vettd-shim`/`cisco-shim` by service name) plus
  `vettd-dev-net` (so `web` can reach it at `http://suite:8080`); `web` joins
  its own default (to keep reaching `db`) plus `vettd-dev-net`. `docker
  compose down` never removes an externally-created network, so redeploying
  either stack independently doesn't break the other's connectivity.
- **Compose/workflow**: `compose.dev.yml` (this repo) declares `suite`,
  `vettd-shim`, `cisco-shim` — no ports published to the host, all three
  reachable only over `vettd-dev-net`. `.github/workflows/deploy-dev.yml` is
  push-triggered on `dev`: lint/typecheck/test, build + push images, then an
  `aws ssm send-command` that base64-ships `compose.dev.yml` and
  `deploy/scanner-suite.docker.toml` to the box (no git clone on the
  instance) and runs `docker compose --env-file .env.dev -f compose.dev.yml
  up -d`. Config is re-pushed on every deploy, so the box never drifts from
  what's in git. Shape mirrors `vettd`'s own `deploy-dev.yml`, deliberately
  kept as a separate workflow rather than folded into it (see "Deploy
  ownership" above).
- **Images**: this repo's workflow builds and pushes `suite` and
  `cisco-shim` to their own ECR repos (`vettd-scanner-suite`,
  `cisco-skill-scanner-shim`), tagged `dev-<sha>` and `dev-latest`.
  `vettd-shim`'s image (`vettd-skill-scanner-shim`) is published by
  `vettd-skill-scanner`'s own workflow instead — this repo only references
  the `dev-latest` tag — matching the "seam to swap for a pinned published
  image" called out in Local deployment above. None of the three ECR repos
  are Terraform-managed; they were created directly, same as the EC2 box
  itself.
- **IAM**: applied manually (not through `vettd/infra/github-oidc/*.tf`) —
  extends `vettd`'s existing `vettd-deploy-dev` role (same role, shared
  across both repos' workflows) with push access to the two new ECR repos,
  plus the `ssm:SendCommand`/`ec2:Describe*`/`ec2:StartInstances`
  permissions needed to reach the same `DEV_INSTANCE_ID`. Any IAM
  resource pattern scoped by name prefix (e.g. `vettd-*`) needs auditing
  against actual repo names — `cisco-skill-scanner-shim` doesn't match a
  `vettd-*` prefix and needed its own explicit grant.
- **Restart policy**: all three services in `compose.dev.yml` set `restart:
  unless-stopped`, so they self-recover across a host reboot. (`vettd`'s own
  `docker-compose.yml` sets no restart policy on `web`/`db` today — an
  existing gap, not something this repo's compose file inherited.)
- **Sizing**: the shared EC2 box is a `t4g.small` — upgraded from the
  original `t4g.micro` after both stacks running together (especially under
  concurrent scans) OOM'd it; `cisco-shim` alone runs ~200 MiB RSS. This
  dev-box footprint is a data point for future sizing, not a template to
  copy verbatim for prod (see #5).

## Remote prod deployment

Decision recorded on [#5](https://github.com/AgenticHighway/vettd-scanner-suite/issues/5); implementation tracked by [#16](https://github.com/AgenticHighway/vettd-scanner-suite/issues/16).

The suite (and its shims) run as their own ECS Fargate service
(`vettd-scanner-suite`) in the existing `vettd` cluster — a separate service
from `vettd`'s own `web` service, not folded into it. Unlike dev's
independent-containers-over-a-shared-Docker-network shape, all three
components run as containers inside **one task**, sharing its network
namespace — the suite reaches its shims over `127.0.0.1`, the same addressing
a bare-metal run uses (see "Local deployment" above for the contrast).

- **Exposure**: internal-only, no public route — same rationale as dev (no
  authn/z on the suite; see "Out of scope" below). Reachability is via ECS
  Service Connect instead of a shared Docker network: a private DNS
  namespace, `vettd.local` (Cloud Map, VPC-scoped to `vettd-vpc`), that the
  suite's service publishes into with discovery/DNS name `scanner-suite`.
  Client tasks resolve it by that **short alias**, `http://scanner-suite:8080`
  — not `scanner-suite.vettd.local`. Service Connect's client-side resolution
  isn't a generic Route53 private-hosted-zone lookup; each Service
  Connect–enrolled client task gets a local proxy that intercepts exactly the
  configured `dnsName` string and routes it to whatever healthy backend(s)
  Cloud Map currently reports, so only the short alias resolves, and only
  from within another Service Connect–enrolled task. `vettd` web's own
  enrollment into this namespace (needed for it to actually call the suite)
  is separate, deliberately deferred vettd-side work, riding along with an
  unrelated iteration of vettd web changes rather than tracked here.
- **Config**: `deploy/scanner-suite.prod.toml` is baked into the image at
  build time via a dedicated `deploy/Dockerfile.prod` — Fargate has no host
  filesystem to bind-mount from, unlike the EC2 dev box. `deploy/Dockerfile.prod`
  is separate from the root `Dockerfile`, which stays runtime-mount-based for
  local/dev. Shim URLs in the prod config point at `127.0.0.1`, not compose
  service names.
- **Task definition**: family `vettd-scanner-suite`, `0.5 vCPU / 2 GB`,
  `arm64`, no task role (the suite makes no AWS API calls and carries no
  secrets). Three containers — `suite` (port 8080; the only one with a
  Service Connect port mapping, since `vettd-skill-shim`/`cisco-skill-shim`
  are only ever reached over loopback, never published). Execution role
  reuses `vettd`'s existing `vettd-ecs-execution-role`.
- **Deploy workflow**: `.github/workflows/deploy.yml`, push-triggered on
  `main`: lint/typecheck/test, build + push `suite` and `cisco-skill-shim`
  images (tagged `<sha>` + `latest`), register a new task-def revision
  patching only those two containers' images, `aws ecs update-service
  --force-new-deployment`, wait for stable. Deliberately omits the
  Terraform-validate/migrations/schema-drift jobs `vettd`'s own `deploy.yml`
  has — neither applies here (no Terraform, no database).
- **Images/versioning**: `suite`/`cisco-skill-shim` move continuously with
  every merge to `main` (sha + latest), same pattern as dev. `vettd-skill-shim`
  is different — pinned to an exact version tag published by
  `vettd-skill-scanner`'s own tag-triggered workflow (see
  [vettd-skill-scanner#2](https://github.com/AgenticHighway/vettd-skill-scanner/issues/2)),
  and this repo's deploy workflow never touches that container's image.
  Bumping the pinned version means registering a new task-def revision by
  hand — there's no auto-follow, by design (see #5).
- **IAM**: `vettd-deploy` (the same OIDC role `vettd`'s own prod deploy uses)
  needed two additions that weren't already there: an explicit ECR push
  grant for `cisco-skill-scanner-shim` (its inline policy was scoped to a
  `vettd-*` resource prefix, the same gap hit on the dev role during #15),
  and a new OIDC trust-policy `sub` entry
  (`repo:AgenticHighway/vettd-scanner-suite:environment:production`) — the
  role's trust policy was originally scoped only to `vettd` and
  `vettd-skill-scanner`'s claims.
- **Logging**: container logs go to `/aws/ecs/vettd-scanner-suite`, created
  manually — `vettd-ecs-execution-role`'s managed execution policy doesn't
  include `logs:CreateLogGroup`. Service Connect's own proxy log config needs
  the same treatment: point it at that same existing group with auto-create
  disabled, rather than letting the console default it to its own
  `/ecs/vettd-scanner-suite` group (which would need its own
  `CreateLogGroup` grant to work).
- **Networking gotcha**: the ECS console's subnet picker defaulted to all
  four subnets in `vettd-vpc`, not just the two intended public ones — the
  extra two are private (no IGW route), and Fargate round-robins task
  placement across whatever's configured, so tasks landing there couldn't
  reach ECR at all. The service's subnet list needs to be checked explicitly
  against intent, not assumed from a console default.
- **Security group**: dedicated `vettd-scanner-suite-sg`, inbound TCP 8080
  from `web`'s own security group only (an SG-to-SG reference, not a CIDR) —
  nothing else in the VPC can reach the suite.
- **Cost**: ~$30–35/mo (arm64, 0.5 vCPU/2GB Fargate on-demand), within the
  budget cap alongside existing spend.

## Adding a scanner

1. Implement `SkillScanner` as a factory in `src/adapters/<name>.ts` taking a
   config object (no module-level env/config reads — state lives in the
   factory closure).
2. Add its config interface + defaults to `src/config/schema.ts`, parsing to
   `src/config/load.ts`, and a documented table to
   `scanner-suite.example.toml`.
3. Register the factory in `src/core/registry.ts` (fixed run order is a suite
   decision, config only declares enablement).
4. If it needs a shim: first-party shims live in the scanner's repo;
   third-party shims live in `shims/` here.

## Provenance notes

- Orchestration core, cisco/socket adapters, SARIF mapping, and tests were
  extracted from vettd web `packages/api/src/external-scanners/` (plain copy,
  history stays in that repo). The zip extractor came from
  `skill-analyzer.ts` in the same repo.
- `adapters/cisco-rule-mapping.ts` header claims 271 of 377 rules mapped, but
  the literal table holds ~251 entries; the referenced validation script
  (`scripts/validate-cisco-mapping.py`) lives in vettd web, not here. Ported
  verbatim — re-validate there before editing the table.
- `intake/zip.ts` treats `svg` as binary (inherited verbatim; cutover parity
  matters more than strict correctness).

## Out of scope (deliberately)

- **Runtime/dynamic analysis** result types — no data model exists to design
  against, so the contract has no speculative extension points.
- **Single distributable image** — local dev now runs under Docker Compose
  (see "Local deployment" above), one container per component; bundling
  everything into one image for power-user distribution is a deliberately
  separate, deferred follow-on (config-driven shim URLs keep that swap cheap
  whenever it happens).
- **Durable job store / push delivery** — the `JobStore` interface and the
  polling NOTE mark the seams.
- **AuthN/Z** — the service binds `127.0.0.1` by default; exposure decisions
  come with the cloud deployment (which also needs an ECS sizing/cost check
  against the budget cap).
- **Batch cancellation, batch priority/fairness against single submissions,
  results inlined in the batch poll** — batch intake (#21) is intake-only;
  a batch's items share the same executor FIFO as single `POST /scans`
  submissions with no special treatment either way, and results stay behind
  `GET /scans/:id` (see "Batch intake" above).
