import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { MadModelClient, verifyToken } from "../lib/madmodel/client.mjs";
import { loadConfig } from "../lib/madmodel/config.mjs";
import { SessionManager } from "../lib/madmodel/auth.mjs";
const serverModule = await import("../lib/madmodel/server.mjs");
const { createModelServer, startModelService } = serverModule;
const config = { ...loadConfig({}), port: 0 };
async function fixture(client, extra = {}) {
  assert.equal(typeof createModelServer, "function");
  const server = createModelServer({ client, config: { ...config, ...extra } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: "http://127.0.0.1:" + server.address().port,
    close: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
const request = {
  model: "test-model",
  messages: [{ role: "user", content: "Hi" }],
};
const manager = {
  // 仅测试HTTP健康成功分支的明确受保护API证据fixture，不代表真实登录。
  status: async () => ({ configured: true, expired: false, verified: true, source: "protected-api:madmodel-auth-login", checkedAt: "2026-01-01T00:00:00.000Z" }),
  check: async () => {},
  ensure: async () => ({ token: "upstream-token" }),
  logout: async () => {},
};
test("non-loopback listener requires a key and invalid numeric settings fail early", () => {
  assert.throws(() => loadConfig({ MADMODEL_HOST: "0.0.0.0" }));
  assert.throws(() => loadConfig({ MADMODEL_PORT: "NaN" }));
  assert.equal(
    loadConfig({ MADMODEL_HOST: "0.0.0.0", MADMODEL_API_KEY: "local-secret" })
      .host,
    "0.0.0.0",
  );
});
test("models and health return OpenAI model envelopes and sanitized login status", async () => {
  const f = await fixture({
    manager,
    models: async () => ({
      object: "list",
      data: [{ id: "test-model", object: "model" }],
    }),
  });
  try {
    const r = await fetch(f.base + "/v1/models");
    assert.equal(r.status, 200);
    assert.equal((await r.json()).data[0].id, "test-model");
    const health = await (await fetch(f.base + "/health")).json();
    assert.equal(health.status, "ok");
    assert(!JSON.stringify(health).includes("token"));
  } finally {
    await f.close();
  }
});
test("downstream key, foreign Origin and rebinding Host are checked before model invocation", async () => {
  let calls = 0;
  const f = await fixture(
    {
      manager,
      models: async () => {
        calls++;
        return { object: "list", data: [] };
      },
    },
    { apiKey: "local-secret" },
  );
  try {
    assert.equal((await fetch(f.base + "/v1/models")).status, 401);
    assert.equal(
      (
        await fetch(f.base + "/v1/models", {
          headers: { Authorization: "Bearer wrong" },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(f.base + "/v1/models", {
          headers: {
            Authorization: "Bearer local-secret",
            Origin: "https://evil.example",
          },
        })
      ).status,
      403,
    );
    const rebinding = await new Promise((resolve, reject) => {
      const r = http.get(
        f.base + "/v1/models",
        {
          headers: {
            Authorization: "Bearer local-secret",
            Host: "evil.example",
          },
        },
        (s) => {
          s.resume();
          resolve(s.statusCode);
        },
      );
      r.on("error", reject);
    });
    assert.equal(rebinding, 403);
    assert.equal(
      (
        await fetch(f.base + "/v1/models", {
          headers: { Authorization: "Bearer local-secret" },
        })
      ).status,
      200,
    );
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});
test("JSON responses and unknown tool/reasoning request fields pass through intact", async () => {
  let seen;
  const f = await fixture({
    manager,
    completion: async (body) => {
      seen = body;
      return Response.json({
        id: "chatcmpl-1",
        object: "chat.completion",
        choices: [
          { message: { role: "assistant", content: "ok", tool_calls: [] } },
        ],
      });
    },
  });
  try {
    const body = {
      ...request,
      tools: [{ type: "function", function: { name: "f" } }],
      reasoning_effort: "high",
    };
    const r = await fetch(f.base + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).choices[0].message.content, "ok");
    assert.deepEqual(seen, body);
  } finally {
    await f.close();
  }
});
test("SSE is forwarded byte for byte including reasoning and DONE", async () => {
  const sse =
    'data: {"choices":[{"delta":{"reasoning_content":"think","content":"ok"}}]}\n\ndata: [DONE]\n\n';
  const f = await fixture({
    manager,
    completion: async () =>
      new Response(sse, { headers: { "Content-Type": "text/event-stream" } }),
  });
  try {
    const r = await fetch(f.base + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...request, stream: true }),
    });
    assert.match(r.headers.get("content-type"), /text\/event-stream/);
    assert.equal(await r.text(), sse);
  } finally {
    await f.close();
  }
});
test("invalid JSON, oversized bodies, wrong content type, unknown paths, and HTML upstream fail clearly", async () => {
  let calls = 0;
  const f = await fixture(
    {
      manager,
      completion: async () => {
        calls++;
        return new Response("<html>login</html>", {
          headers: { "content-type": "text/html" },
        });
      },
    },
    { maxBodyBytes: 1024 },
  );
  try {
    const post = (body, type = "application/json") =>
      fetch(f.base + "/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": type },
        body,
      });
    assert.equal((await post("{")).status, 400);
    assert.equal((await post("x".repeat(2048))).status, 413);
    assert.equal(
      (await post(JSON.stringify(request), "text/plain")).status,
      415,
    );
    assert.equal((await post(JSON.stringify({}))).status, 400);
    const r = await post(JSON.stringify(request));
    assert.equal(r.status, 502);
    assert((await r.json()).error.code);
    assert.equal((await fetch(f.base + "/missing")).status, 404);
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});
test("only a definite 401 retries a completion once; local keys are never sent upstream", async () => {
  let calls = 0;
  const forces = [];
  const c = new MadModelClient({
    config,
    manager: {
      ensure: async (opts) => {
        forces.push(!!opts.force);
        return { token: opts.force ? "renewed" : "original" };
      },
    },
    fetcher: async (url, opts) => {
      calls++;
      assert.equal(
        url,
        "https://madmodel.cs.tsinghua.edu.cn/v1/chat/completions",
      );
      assert.equal(
        opts.headers.Authorization,
        calls === 1 ? "Bearer original" : "Bearer renewed",
      );
      return calls === 1
        ? new Response("", { status: 401 })
        : Response.json({ choices: [] });
    },
  });
  assert.equal((await c.completion(request)).status, 200);
  assert.equal(calls, 2);
  assert.deepEqual(forces, [false, true]);
});
test("network failures, 5xx, 403 and a second 401 are never replayed", async () => {
  for (const status of [500, 403, "network", 401]) {
    let calls = 0;
    const c = new MadModelClient({
      config,
      manager,
      fetcher: async () => {
        calls++;
        if (status === "network") throw new TypeError("network");
        return new Response("", { status });
      },
    });
    if (status === "network") await assert.rejects(c.completion(request));
    else assert.equal((await c.completion(request)).status, status);
    assert.equal(calls, status === 401 ? 2 : 1);
  }
});
test("401 arriving during a normal check renews once before retrying", async () => {
  let value = {
    token: "revoked",
    accountId: "A",
    expiresAt: Date.now() + 3600000,
  };
  let revision = 0,
    logins = 0,
    releaseVerify,
    release401,
    calls = 0;
  const sessionManager = new SessionManager({
    store: {
      load: async () => ({ data: value, revision }),
      save: async (data) => {
        value = data;
        revision++;
      },
    },
    verify: async () => true,
    login: async () => {
      logins++;
      return { ...value, token: "renewed" };
    },
  });
  sessionManager.verifiedAt = Date.now();
  const c = new MadModelClient({
    config,
    manager: sessionManager,
    fetcher: async (url, opts) => {
      calls++;
      if (calls === 1)
        return new Promise(
          (r) => (release401 = () => r(new Response("", { status: 401 }))),
        );
      assert.equal(opts.headers.Authorization, "Bearer renewed");
      return Response.json({ choices: [] });
    },
  });
  const generation = c.completion(request);
  await new Promise((r) => setImmediate(r));
  sessionManager.verify = () => new Promise((r) => (releaseVerify = r));
  const check = sessionManager.check();
  await new Promise((r) => setImmediate(r));
  release401();
  await new Promise((r) => setImmediate(r));
  releaseVerify(true);
  await check;
  assert.equal((await generation).status, 200);
  assert.equal(logins, 1);
  assert.equal(calls, 2);
});
test("client and CLI reject HTML 200 instead of treating it as a completion", async () => {
  const c = new MadModelClient({
    config,
    manager,
    fetcher: async () =>
      new Response("<html>login</html>", {
        headers: { "Content-Type": "text/html" },
      }),
  });
  await assert.rejects(c.completion(request), { code: "UPSTREAM_PROTOCOL" });
});
test("health is degraded after a failed online verification", async () => {
  const f = await fixture({
    manager: {
      status: async () => ({
        configured: true,
        expired: false,
        lastError: { code: "UPSTREAM_PROTOCOL" },
      }),
    },
  });
  try {
    const r = await fetch(f.base + "/health");
    assert.equal(r.status, 503);
    assert.equal((await r.json()).status, "degraded");
  } finally {
    await f.close();
  }
});
test("login verification rejects an HTML 200 and recognizes explicit expiry", async () => {
  await assert.rejects(
    verifyToken(
      "secret",
      undefined,
      async () =>
        new Response("<html/>", { headers: { "content-type": "text/html" } }),
    ),
  );
  assert.equal(
    await verifyToken(
      "secret",
      undefined,
      async () => new Response("", { status: 401 }),
    ),
    false,
  );
});
test("downstream disconnect aborts its upstream request without replay", async () => {
  let cancelled;
  const done = new Promise((r) => (cancelled = r));
  const f = await fixture({
    manager,
    completion: async (body, { signal }) => {
      signal.addEventListener("abort", cancelled, { once: true });
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("data: {}\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    const control = new AbortController();
    const r = await fetch(f.base + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...request, stream: true }),
      signal: control.signal,
    });
    await r.body.getReader().read();
    control.abort();
    await Promise.race([
      done,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("not aborted")), 1500),
      ),
    ]);
  } finally {
    await f.close();
  }
});
test("service starts an immediate check, repeats on a timer, and stops cleanly", async () => {
  assert.equal(typeof startModelService, "function");
  let checks = 0;
  const running = await startModelService(
    { ...config, checkIntervalMs: 25 },
    {
      client: {
        manager: {
          status: manager.status,
          check: async () => {
            checks++;
          },
        },
      },
      log: () => {},
    },
  );
  try {
    await new Promise((r) => setTimeout(r, 90));
    assert(checks >= 2);
  } finally {
    await running.close();
  }
  const count = checks;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(checks, count);
});
