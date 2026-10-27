# Prepared Answer Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:executing-plans inline. User has opted out of step approvals; one final independent reviewer before merge.

**Goal:** formally register a Harness-solved answer, wait for its exact question publication, then send once within a random valid 20–40s offset.
**Architecture:** protected prepared-answer registry plus existing detached jobs; a testable timer engine reuses the WebSocket parser and AnswerService with a final transport gate. Existing status/cancel tools remain the control plane.
**Tech Stack:** existing TypeScript/Node22/24, crypto.randomInt, DPAPI AuthStore, proper-lockfile, MCP SDK, Vitest/node:test. No new dependencies.
**Spec:** ../specs/2026-10-27-prepared-answer.md

## Global Constraints
- No real live answer tasks during development; keep all account state and output directories.
- Server publication time, one persisted sample in valid [20s,40s) window, no late send or automatic write retry.
- Every prepared record binds account, auth generation, lesson, stable question ID and immutable content fingerprint.
- Existing single-entry clients remain compatible;51 total tools,19 rain tools after one addition.

## Review Focus
- Cancellation acknowledged before dispatch intent must prevent network writes; cancellation after intent must disclose uncertainty.
- Delayed preflight, task deadline or clock jump after timer must be stopped by the final synchronous transport gate.
- A model's previously read question snapshot or account may become stale before registration; reject mismatched fingerprints.
- Reconnect history, another publisher or manual answer must not resample or produce a false success for this job.
- Worker crash and duplicate/concurrent registration must not overwrite another job or re-send an unknown write.

### Task 1: Fingerprints, publication provenance and network dispatch gate
**Files:** new packages/hetang/src/prepared-contract.ts; modify types.ts,protocol.ts,classroom.ts,client.ts,mock.ts; test prepared-contract.test.ts.
**Interfaces:** questionContentFingerprint(q), questionSnapshotFingerprint(q,accountId,generation); selectAnswerTime(q,now,expiresAt,randomInt); RequestGate {beforeSend?,assertNow?}; AnswerService.submit(input,gate?).
- [ ] Write/run RED tests for immutable fingerprint vs timing changes, signed-image query rotation, missing platform timestamp, short/late windows, and transport/preflight delay blocking fetch.
- [ ] Implement contract, platform/observed provenance and optional network-boundary gate without changing ordinary submissions.
- [ ] Run targeted tests/build; Expected: PASS. Commit task.

### Task 2: Protected registration and scheduled job engine
**Files:** new scheduled.ts,prepared.ts; modify jobs.ts; tests prepared.test.ts,scheduled.test.ts.
**Interfaces:** scheduleAnswer(client,cfg,input) returns existing/new job ID plus submissionRequestId; runPreparedAnswer(client,cfg,job,hooks,deps?) returns phase metadata/status; hooks check/checkpoint/commitDispatch; startJob accepts optional fixed ID.
- [ ] RED cases: account epoch drift, registration collision/dedup/conflict, teacher edit, cancel before intent, actual-time gate, no publication/end/expiry, receipt unknown/manual answer collision, persisted target with no reroll.
- [ ] Implement DPAPI payload, per-ID/per-question locks, bounded worker, websocket reconnect and guarded one-shot AnswerService call. JSON task options exclude answers; never auto-resume interrupted jobs.
- [ ] Targeted suite/build; Expected: PASS. Commit task.

### Task 3: MCP interface, mock end-to-end and portable discovery
**Files:** server.ts, test/server.test.ts, test/prepared-smoke.mjs; root gateway tests/counts, services.mjs, verification scripts.
**Interfaces:** rain_schedule_answer args above; rain_questions and rain_question_image return account/epoch-bound questionFingerprint; existing job status/events/stop expose scheduled phases and late cancel metadata.
- [ ] RED MCP tests for fingerprint requirement, snapshot/epoch mismatch, default existing behavior and write-effect annotations; worker end-to-end with synthetic draft and real20–40s timing.
- [ ] Add one tool, mock publication/transport-gate support, cancellation/status and51-tool discovery. Update mock smoke script only; no school credentials in tests.
- [ ] Check new stdio scenario, all existing smokes and portable relocated gateway. Expected: PASS. Commit task.

### Task 4: Documentation and release verification
**Files:** README.md, docs/TOOLS.md, docs/VERIFICATION.md, source hashes/version metadata.
- [ ] Explain prepare/solve/register/status/cancel workflow, both IDs, stages, limits, no model work in background and no replay of unknown/interrupted writes.
- [ ] Full check/smoke/source/license audit; one fresh final review and one RED/GREEN fix pass for concrete findings; record rulings.
- [ ] Authorized main integration/private push, confirm exact-head Node22/24 CI and portable artifacts, no credentials in release. Expected: all success.
