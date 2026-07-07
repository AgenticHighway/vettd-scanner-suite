# Postman smoke tests

Collection: `collection.json`. Environment: `environment.json` (`baseUrl`,
default `http://127.0.0.1:8080`).

Covers `GET /health`, the `POST /scans` → `GET /scans/:id` happy path (two
seeded skill fixtures), and the `400`/`404`/`415` error paths. See
`fixtures/generate.mjs` for what's inside the seeded skills.

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
3. One-time step: the two "Submit seeded skill" requests reference
   `fixtures/*.zip` by relative path. Postman's desktop app stores an
   absolute path once a file is picked through the UI, so after import you
   may need to re-attach each once: open the request → Body → binary →
   Select File → choose the matching file under `.postman/fixtures/`.
4. Open the collection → Run collection (Collection Runner). Running a
   single request manually will not exercise the `GET /scans/:id` polling
   loop — `postman.setNextRequest` only takes effect inside a Runner or
   newman run.

## Run headlessly with newman

```bash
pnpm postman
```

Equivalent to:

```bash
npx newman run .postman/collection.json -e .postman/environment.json --working-dir .postman
```

## Retargeting to another environment

Duplicate `environment.json` (e.g. `environment.docker.json`) with a
different `baseUrl`, or edit the `baseUrl` value in place — no changes to
`collection.json` are ever required.

## Regenerating the fixture zips

`fixtures/minimal-skill.zip` and `fixtures/full-skill.zip` are generated, not
hand-authored. To change their contents, edit `fixtures/generate.mjs` and
re-run:

```bash
node .postman/fixtures/generate.mjs
```

then commit the resulting `.zip` files.
