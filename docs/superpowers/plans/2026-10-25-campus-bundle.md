# Campus MCP Bundle Implementation Plan

> For agentic workers: execute inline using superpowers:executing-plans with one fresh final review. User has authorized private publishing and continuous execution.

**Goal:** self-contained three-service workspace, clear provenance and private GitHub CI passing.

**Architecture:** source snapshots, npm workspaces, root CLI, existing service installers, relative cloud bridge.

**Tech Stack:** Node >=22, TypeScript, MCP SDK, npm, native node:test, Vitest, GitHub Actions.

**Spec:** ../specs/2026-10-25-campus-bundle.md

## Global constraints
- Do not change original repos, client registrations or auth stores for a packaging operation.
- No credentials or actual course resources in Git or CI artifacts.
- Three services preserve independent auth/operation semantics; fixed upstream commits and module licenses are retained.
- No blind retries of account writes; only mock test writes in CI.

## Interfaces
Root CLI consumes built `packages/*/dist/cli.js`; build all workspaces before CLI smoke.
Hetang consumes bundled cloud CLI both directly and through the installer environment; test both paths.
Unified installer consumes three previews; validate all before applying and preserve foreign entries.
Source license inventory consumes root lock and installed package metadata; `--check` detects drift.

### Task 1: Standalone workspace and unified CLI
- [x] Import committed snapshots with exact source hashes, root workspace manifest/lock.
- [x] Add failing root routing/default-cloud/config-preview tests and observe RED.
- [x] Implement routing/installer/default cloud path; observe GREEN and run module checks.
- [x] Commit coherent source and entry point.

### Task 2: Documentation, dependency inventory and CI
- [x] Write root setup/auth/client/config/troubleshooting guide and provenance distinguishing runtime vs reference.
- [x] Generate reproducible npm license inventory; retain license files and check copied source provenance.
- [x] Add Windows Node22/24 CI with checks, smokes, secret audit and source artifact.
- [x] Run root check and relocated three-service smoke, commit.

### Task 3: Review, private publishing and CI convergence
- [x] One independent final review; fix important findings with regression coverage.
- [x] Audit secrets/history, verify clean tree and create a private GitHub repository.
- [x] Push, monitor exact head workflow, diagnose/fix/push until every job succeeds.
- [x] Record final results and report repository/CI URLs and material limits.
