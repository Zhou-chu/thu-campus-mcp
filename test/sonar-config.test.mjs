import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { matchesGlob } from "node:path";

const source = await readFile(new URL("../sonar-project.properties", import.meta.url), "utf8");
const lines = source.replace(/\\\r?\n[ \t]*/g, "").split(/\r?\n/);
function property(key) {
  const line = lines.find(value => value.startsWith(key + "="));
  assert.ok(line, `Missing property: ${key}`);
  return line.slice(key.length + 1);
}
const testPatterns = property("sonar.test.inclusions").split(",");

test("Sonar disables conflicting auto configuration and keeps whole-project candidates", () => {
  assert.equal(property("sonar.scanner.autoconfig.enabled"), "false");
  assert.equal(property("sonar.sources"), ".");
  assert.equal(property("sonar.tests"), ".");
  assert.deepEqual(testPatterns, ["**/test/**", "**/tests/**", "**/__tests__/**", "**/*.test.*", "**/*.spec.*"]);
});

test("Sonar classifies real Node, SDK and Kotlin tests without relabeling production", async () => {
  const samples = [
    ["test/coverage.test.mjs", true],
    ["packages/learnx/test/coverage-edges.test.ts", true],
    ["packages/thu-cloud/test/coverage-edges.test.ts", true],
    ["packages/hetang/test/coverage-edges-3-jobs.test.ts", true],
    ["mobile/android/app/src/test/java/cn/edu/tsinghua/campusapp/HostPolicyTest.kt", true],
    ["scripts/coverage.mjs", false],
    ["lib/app/server.mjs", false],
    ["webui/app.js", false],
    ["packages/hetang/src/resources.ts", false],
    ["mobile/android/app/src/main/java/cn/edu/tsinghua/campusapp/HostPolicy.kt", false],
  ];
  for (const [file, expected] of samples) {
    await access(new URL("../" + file, import.meta.url));
    assert.equal(testPatterns.some(pattern => matchesGlob(file, pattern)), expected, file);
  }
});

test("Sonar retains both real LCOV reports and excludes only generated artifacts", () => {
  assert.equal(property("sonar.javascript.lcov.reportPaths"), "coverage/lcov.info,coverage/tooling/lcov.info");
  assert.deepEqual(property("sonar.exclusions").split(","), [
    "**/node_modules/**", "**/dist/**", "**/.local/**", "coverage/**", "**/build/**", "**/.gradle/**",
  ]);
  const forbidden = ["sonar.coverage.exclusions=", "sonar.test.exclusions=", "sonar.global.test.exclusions=", "sonar.issue.ignore."];
  assert.equal(lines.some(line => forbidden.some(prefix => line.startsWith(prefix))), false);
});
