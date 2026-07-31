# Postman smoke tests

Collection: `collection.json`. Environment: `environment.json` (`baseUrl`,
default `http://127.0.0.1:8080`).

Covers `GET /health`, the `POST /scans` (JSON body) -> `GET /scans/:id` happy
path, the `POST /scans/batch` -> `GET /scans/batch/:id` batch happy path
(including a partially-rejected batch), and the `400`/`404`/`415` error
paths for both. The seeded skill fixtures are inline JSON payloads in the
collection — no files on disk to attach.

## Prerequisites

Start a local suite instance. For a fast, deterministic happy-path run, point
it at a config with all scanners disabled (every scanner's `enabled` defaults
to `false`, so an empty file works):

```bash
pnpm build
node dist/server/index.js scanner-suite.example.toml   # or your own config
```

## Run in the Postman GUI

1. Import `.postman/collection.json` and `.postman/environment.json`.
2. Select the "vettd-scanner-suite (local)" environment in the top-right
   environment picker.
3. Open the collection -> Run collection (Collection Runner). Running a
   single request manually will not exercise the `GET /scans/:id` polling
   loop — `postman.setNextRequest` only takes effect inside a Runner or
   newman run.
4. Set a per-request delay of at least `500` ms in the Collection Runner's
   "Delay" field. Without it, all 60 poll attempts fire in well under a
   second — faster than an unreachable/degrading scanner's health-check
   timeout can even elapse once, so the loop gives up on a job that's still
   legitimately running.

## Run headlessly with newman

```bash
pnpm postman
```

Equivalent to:

```bash
npx newman run .postman/collection.json -e .postman/environment.json --working-dir .postman --delay-request 500
```

The `--delay-request 500` is required for the same reason as the GUI's Delay
setting above — it's what gives a slow-to-respond or intentionally-unreachable
scanner shim real wall-clock time to hit its own timeout before the poll loop
gives up.

## Retargeting to another environment

Duplicate `environment.json` (e.g. `environment.docker.json`) with a
different `baseUrl`, or edit the `baseUrl` value in place — no changes to
`collection.json` are ever required.
