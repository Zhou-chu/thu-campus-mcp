import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const file = path.resolve(import.meta.dirname, "..", ".github", "workflows", "ci.yml");

test("发布候选必须等同一提交的 verify 与 Sonar 全部通过，且只在 main 手动触发", async () => {
  const text = await readFile(file, "utf8");
  const start = text.indexOf("\n  release:");
  assert.ok(start > 0);
  const release = text.slice(start);
  assert.match(release, /needs:\s*\[[^\]]*verify[^\]]*sonar[^\]]*\]/);
  assert.match(release, /github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'/);
  // 制品上传只能在 release job 内出现；普通 CI 不产 release 名称的制品。
  assert.equal((text.match(/thu-campus-mcp-release-source/g) || []).length, 1);
});

test("PR 必跑邮箱模式服务页端到端门禁", async () => {
  const text = await readFile(file, "utf8");
  assert.match(text, /npm run e2e:auth-services/);
  const step = text.slice(text.indexOf("邮箱模式服务页端到端"), text.indexOf("npm run e2e:auth-services"));
  assert.match(step, /if: matrix\.node == 22/);
});
