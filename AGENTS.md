# AGENTS.md

This file gives coding agents the minimum project context needed to work
safely in this repository.

## Project overview

- `vettd-scanner-suite` is a standalone Fastify HTTP service that
  orchestrates first-party and third-party scanners behind a single
  normalized findings contract (async job model: POST JSON → poll job).
- Consumers: the `vettd` web app's scanning backend (cloud), and a
  distributable Docker image for local/power-user runs (Docker not built yet).
- Configuration is a TOML file (`scanner-suite.example.toml`); scanners are
  disabled unless explicitly enabled. Secrets (e.g. `SOCKET_API_KEY`) stay in
  env vars, never in the config file or git.

## Repo shape

- `src/contract/` — canonical findings contract; changes here are wire-format
  changes requiring coordination with vettd web (see docs/design.md)
- `src/config/` — TOML schema/loading; fail-fast validation
- `src/core/` — runner fan-out, registry, job store/executor
- `src/adapters/` — per-scanner normalization; adapters for ALL scanners live
  here, as config-taking factories (no module-level env/config reads)
- `src/server/` — Fastify app + entry point
- `shims/cisco/` — Python shim for the cisco pip package (third-party shims
  live in this repo; first-party shims live in the scanner's own repo)
- `docs/design.md` — architecture, config reference, how to add a scanner

## Working norms

- Keep changes small and focused.
- Add or update tests when behavior changes.
- Commit messages must be **under 100 characters** (subject line).

## Issues

- New issues should have 3-4 sections:
  - Description: Describe the issue. Prefer shorter descriptions when appropriate
  - (OPTIONAL) Design Decisions: if the issue is reasonably large or the user explicitly asks, include this section. Focus on large decisions, avoid small details unless instructed otherwise. Generally, lean away from including this section unless prompted
  - Scope: List what is in scope for the issue
  - Acceptance Criteria: Use checkboxes to list what needs to happen before this issue can be marked resolved
- Issue bodies should **always** focus on what the issue/task is, not how to solve it. If there are explicit solution details decided before opening the issue, these should be added as a comment after opening
- Use the Projects API fields correctly when instructed: by default, use status=Todo and leave other fields blank unless instructed

## Required behavior for agents

These rules apply to every task in this project unless explicitly overridden.
Bias: caution over speed on non-trivial work. Use judgment on trivial tasks.

## Rule 1 — Think Before Coding

State assumptions explicitly. If uncertain, ask rather than guess.
Present multiple interpretations when ambiguity exists.
Push back when a simpler approach exists.
Stop when confused. Name what's unclear.

## Rule 2 — Simplicity First

Minimum code that solves the problem. Nothing speculative.
No features beyond what was asked. No abstractions for single-use code.
Test: would a senior engineer say this is overcomplicated? If yes, simplify.

## Rule 3 — Surgical Changes

Touch only what you must. Clean up only your own mess.
Don't "improve" adjacent code, comments, or formatting.
Don't refactor what isn't broken. Match existing style.

## Rule 4 — Goal-Driven Execution

Define success criteria. Loop until verified.
Don't follow steps. Define success and iterate.
Strong success criteria let you loop independently.

## Rule 5 — Use the model only for judgment calls

Use me for: classification, drafting, summarization, extraction.
Do NOT use me for: routing, retries, deterministic transforms.
If code can answer, code answers.

## Rule 6 — IF YOU ARE CO-PILOT, IGNORE THIS RULE Token budgets are not advisory

Per-task: 4,000 tokens. Per-session: 30,000 tokens.
If approaching budget, summarize and start fresh.
Surface the breach. Do not silently overrun.

## Rule 7 — Surface conflicts, don't average them

If two patterns contradict, pick one (more recent / more tested).
Explain why. Flag the other for cleanup.
Don't blend conflicting patterns.

## Rule 8 — Read before you write

Before adding code, read exports, immediate callers, shared utilities.
"Looks orthogonal" is dangerous. If unsure why code is structured a way, ask.

## Rule 9 — Tests verify intent, not just behavior

Tests must encode WHY behavior matters, not just WHAT it does.
A test that can't fail when business logic changes is wrong.

## Rule 10 — Checkpoint after every significant step

Summarize what was done, what's verified, what's left.
Don't continue from a state you can't describe back.
If you lose track, stop and restate.

## Rule 11 — Match the codebase's conventions, even if you disagree

Conformance > taste inside the codebase.
If you genuinely think a convention is harmful, surface it. Don't fork silently.

## Rule 12 — Fail loud

"Completed" is wrong if anything was skipped silently.
"Tests pass" is wrong if any were skipped.
Default to surfacing uncertainty, not hiding it.

## Expected checks

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Notes for agents

- This suite's job is to normalize findings across scanners of varying
  languages/runtimes (first-party Rust, third-party Python/SaaS, etc.) — a
  scanner's own implementation language should never leak into the shared
  contract types.
