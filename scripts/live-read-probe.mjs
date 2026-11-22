#!/usr/bin/env node
/**
 * 真实实例只读探针（需要真实会话，手动触发；不在 CI 运行）。
 *
 * 用途：核对 seat / sports / tools 的协议形状与错误码，替身测试覆盖不到的
 * 「真实站点是否仍按这个形状返回」的问题。只发 GET 与只读 POST（工具目录、
 * status），绝不预约、不下单、不改设置。
 *
 * 用法：
 *   $env:BASE_URL="https://desktop-uq2emap.tailf544a4.ts.net:8973"
 *   $env:TOKEN="<设备令牌>"
 *   node scripts/live-read-probe.mjs
 *
 * 令牌只从环境变量读取，不写入任何文件；输出不含令牌。
 */
import assert from "node:assert/strict";

const base = String(process.env.BASE_URL || "http://127.0.0.1:8971").replace(/\/+$/, "");
const token = String(process.env.TOKEN || "");
if (!token) {
  console.error("缺少 TOKEN：请先把设备令牌放进环境变量（不要写进命令行历史或仓库）。");
  process.exit(2);
}
const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
const results = [];

async function get(path, validate) {
  const response = await fetch(base + path, { headers, signal: AbortSignal.timeout(20000) });
  const body = await response.json().catch(() => null);
  assert.equal(response.status, 200, `${path} 状态码 ${response.status}`);
  validate(body);
  results.push({ path, ok: true });
  return body;
}

async function post(path, payload, validate) {
  const response = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
  const body = await response.json().catch(() => null);
  assert.equal(response.status, 200, `${path} 状态码 ${response.status}`);
  validate(body);
  results.push({ path, ok: true });
  return body;
}

const meta = await get("/api/meta", body => {
  assert.equal(body.ok, true);
  assert.equal(typeof body.version, "string");
  assert.ok(body.security);
});

const tools = await get("/api/tools", body => {
  assert.ok(Array.isArray(body.tools));
  assert.ok(body.tools.length >= 80, `工具数偏少：${body.tools.length}`);
  for (const name of ["learn_status", "cloud_status", "rain_status", "campus_browser_status"]) {
    assert.ok(body.tools.some(tool => tool.name === name), `缺少工具 ${name}`);
  }
});

// 座位：只读层级与登录态；不查询具体座位、不预约。
const seat = await get("/api/seat/libraries", body => {
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.libraries), "座位馆区应为数组");
});

// 体育：只读场景列表；不查时段、不下单。
const sports = await get("/api/sports/sports", body => {
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.sports), "体育项目应为数组");
});

const sportsScenes = await get("/api/sports/scenes", body => {
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.scenes), "体育场景应为数组");
});

// 工具状态：只验证形状，不触发任何登录动作。
const learn = await post("/api/tools/learn_status", { args: { verify: false } }, body => {
  assert.equal(typeof body.ok, "boolean");
  assert.ok(body.data && typeof body.data === "object");
});

const rain = await post("/api/tools/rain_status", { args: { verify: false } }, body => {
  assert.equal(typeof body.ok, "boolean");
  assert.ok(body.data && typeof body.data === "object");
});

console.log(JSON.stringify({
  base,
  version: meta.version,
  https: meta.security.https === true,
  hosted: meta.security.hosted === true,
  tools: tools.tools.length,
  seatLibraries: seat.libraries.length,
  sports: sports.sports.length,
  scenes: sportsScenes.scenes.length,
  learnState: learn.data?.code ?? null,
  rainState: rain.data?.code ?? null,
  checks: results,
}, null, 2));