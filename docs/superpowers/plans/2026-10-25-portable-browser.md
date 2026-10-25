# Portable Browser Implementation Plan

> Execute inline with superpowers:executing-plans; one fresh final reviewer. Existing user authorization covers continuous development, local integration and private publication.

**Goal:** independent bundled browser, durable login, one MCP endpoint, complete README.
**Architecture:** browser workspace + three auth adapters + broker + stdio gateway + unified installer.
**Tech Stack:** Node22/24, Playwright1.64.1, MCP SDK, DPAPI, native node:test/Vitest.
**Spec:** ../specs/2026-10-25-portable-browser.md

## Global constraints

- No OS-browser dependency by default; one pinned runtime inside `.runtime`, never Git.
- Per-user profile/snapshots outside checkout; no cookie/token/profile/DPAPI material in artifacts or logs.
- Profile locking, account binding and conditional commit prevent competing logins and logout resurrection.
- Original 46 tool names/schemas/results retained, no remote write retries; restore only read operations.
- Client registrations preserve configured state/download paths and other tools; no unrecognized owner overwrite.

## Interfaces and review focus

Auth adapters consume browser lease; snapshot persistence must finish before release. Gateway consumes broker and child schemas; tool auth/write annotations govern recovery. Unified installer must forward every state directory to children and broker. CI builds before discovery and installs runtime before browser persistence smoke. Browser profiles must never be included by portable packaging.

### Task 1: Runtime and persistent browser

- [x] Create browser workspace metadata and failing lease/path/vault tests.
- [x] Implement pinned local runtime install/detection, DPAPI snapshot, locked persistent profile and safe reset.
- [x] Real local HTTP browser close/reopen test for session cookies/localStorage/IndexedDB; no Edge.

### Task 2: Login adapters and broker

- [x] Failing tests for conditional account login, headless timeout and profile/account binding.
- [x] Adapt three browser logins to persistent lease; root detached open/login/status and bounded restore.
- [x] Verify existing real account sessions remain usable; no remote coursework writes.

### Task 3: Unified MCP and installer

- [x] Failing gateway discovery/forwarding and config migration/preservation tests.
- [x] Single stdio endpoint with original46 tools and browser lifecycle tools; one-shot read recovery only.
- [x] Unified installer config and safe recognized split migration; verify all4 client registrations.

### Task 4: README, package and final verification

- [x] Rewrite README with portable install, first login, persistence, repair, upgrade and clear limits.
- [x] Update source/license inventory, CI browser smoke and credential-free packaging.
- [x] Full checks, one fresh final review; regression fixes; private push and exact-head CI all green.
