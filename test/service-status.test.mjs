import assert from "node:assert/strict";
import test from "node:test";
import { composeServiceStates, createServiceStatus, probeGitlabSession } from "../lib/app/service-status.mjs";

const learnx = { state: "ready", verified: true, code: "VERIFIED" };

test("service status composes all seven services and applies the session signal once", async () => {
  const calls = [];
  const signals = { applied: 0, apply(states) { signals.applied += 1; return { ...states, learnx: { ...states.learnx, state: "expired" } }; } };
  const status = createServiceStatus({
    host: {},
    stateDir: "fixture",
    signals,
    probe: async () => { calls.push("probe"); return { learnx, cloud: { state: "ready" } }; },
    seatStatus: async () => ({ state: "login-required" }),
    sportsStatus: async () => ({ state: "ready" }),
    gitlabStatus: async () => ({ state: "unknown" }),
  });
  const states = await status();
  assert.deepEqual(Object.keys(states).sort(), ["cloud", "gitlab", "learnx", "seat", "sports"]);
  assert.equal(states.learnx.state, "expired");
  assert.equal(states.seat.state, "login-required");
  assert.equal(signals.applied, 1);
  assert.deepEqual(calls, ["probe"]);
});

test("compose leaves base states untouched without a signal and tolerates partial input", () => {
  const base = { learnx, cloud: { state: "ready" } };
  assert.deepEqual(composeServiceStates({ base, seat: 1, sports: 2, gitlab: 3 }), { ...base, seat: 1, sports: 2, gitlab: 3 });
  assert.deepEqual(composeServiceStates({ base: undefined }, null), { seat: undefined, sports: undefined, gitlab: undefined });
});

test("gitlab probe distinguishes unconfigured, verified, expired token and network failure", async () => {
  const cases = [
    [{ configured: false }, { state: "login-required", code: "NOT_CONFIGURED" }],
    [null, { state: "ready", code: "VERIFIED" }],
    [Object.assign(new Error("expired"), { status: 401 }), { state: "expired", code: "AUTH_EXPIRED" }],
    [new Error("offline"), { state: "unknown", code: "PROBE_FAILED" }],
  ];
  for (const [outcome, expected] of cases) {
    const result = await probeGitlabSession({
      stateDir: "fixture",
      now: () => 0,
      loadConfig: async () => outcome?.configured === false ? { configured: false } : { configured: true },
      request: async (path, options) => {
        assert.equal(path, "/user");
        assert.equal(options.timeoutMs, 4000);
        if (outcome) throw outcome;
        return { id: 42 };
      },
    });
    assert.equal(result.state, expected.state);
    assert.equal(result.code, expected.code);
    assert.equal(result.verified, expected.state === "ready");
    assert.equal(result.checkedAt, "1970-01-01T00:00:00.000Z");
    assert.equal(result.source, "protected-api:gitlab-user");
  }
});

test("service status keeps a rejected probe from inventing verified states", async () => {
  const status = createServiceStatus({
    host: {},
    stateDir: "fixture",
    probe: async () => { throw new Error("tool host down"); },
    seatStatus: async () => ({ state: "unknown" }),
    sportsStatus: async () => ({ state: "unknown" }),
    gitlabStatus: async () => ({ state: "unknown" }),
  });
  await assert.rejects(() => status(), /tool host down/);
});