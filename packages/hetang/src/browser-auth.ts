import { chromium } from "playwright-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuthStore } from "./auth.js";
import { ORIGIN, type Config } from "./config.js";
import { dataOf, identifier, parseJson } from "./protocol.js";
import { RainError } from "./types.js";
export async function browserLogin(config: Config, channel = "msedge") {
  const store = new AuthStore(config.stateDir),
    epoch = await store.generation();
  const dir = await mkdtemp(path.join(tmpdir(), "hetang-login-"));
  let context;
  try {
    context = await chromium.launchPersistentContext(dir, {
      channel,
      headless: false,
      viewport: null,
    });
    let bearerToken: string | undefined;
    context.on("request", async (request) => {
      try {
        if (new URL(request.url()).origin !== ORIGIN) return;
        const h = await request.allHeaders();
        const a = h.authorization;
        if (a?.startsWith("Bearer ")) bearerToken = a.slice(7);
      } catch {}
    });
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(ORIGIN, { waitUntil: "domcontentloaded", timeout: 60000 });
    process.stderr.write(
      "请在新开的 Edge 中扫码/完成学校登录。凭据仅在本机处理，最多等待 10 分钟。\n",
    );
    const until = Date.now() + 600000;
    while (Date.now() < until) {
      if (!context.pages().length)
        throw new RainError("CANCELLED", "登录窗口已关闭。");
      const cookies = await context.cookies(ORIGIN);
      if (cookies.some((c) => c.name === "sessionid" && c.value)) {
        const response = await context.request.get(
          ORIGIN + "/api/v3/user/basic-info",
          {
            headers: { xtbz: "ykt", "x-client": "h5", Referer: ORIGIN + "/" },
            timeout: 15000,
            failOnStatusCode: false,
            maxRedirects: 0,
          },
        );
        if (response.ok()) {
          try {
            const raw = parseJson(await response.text());
            const d = dataOf(raw);
            const u = d.userInfo ?? d.user_info ?? d;
            const userId = identifier(u.userId ?? u.user_id ?? u.id);
            if (Number(raw.code ?? 0) === 0) {
              const newAuth = response.headers()["set-auth"];
              if (newAuth) bearerToken = newAuth.replace(/^Bearer\s+/i, "");
              const cookieHeader = (await context.cookies(ORIGIN))
                .map((c) => c.name + "=" + c.value)
                .join("; ");
              await store.saveIfCurrent(
                { account: userId, userId, cookieHeader, bearerToken },
                epoch,
              );
              return {
                configured: true,
                verified: true,
                protection: "Windows-DPAPI",
              };
            }
          } catch (e) {
            if (e instanceof RainError && e.code === "AUTH_CHANGED") throw e;
          }
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new RainError(
      "AUTH_TIMEOUT",
      "扫码登录等待超时，可重新运行 auth browser。",
    );
  } finally {
    await context?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}
