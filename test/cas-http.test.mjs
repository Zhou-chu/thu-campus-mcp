import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { casLoginHttp, CasHttpError, createCookieJar, jarToSnapshotCookies, parseLoginOutcome, parseSm2PublicKey } from "../lib/app/cas-http.mjs";
import smCrypto from "sm-crypto";

const { sm2 } = smCrypto;
const keys = sm2.generateKeyPairHex();

/** 假 CAS + 假目标站点：完整走一遍“表单 → SM2 加密 → 回调 → 站点 Cookie”。 */
async function fakeCas() {
  const seen = { checks: 0, decrypted: "", deviceName: "", singleLogin: "" };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/site/login") {
      // 目标站点把未登录用户送去统一认证。
      res.writeHead(302, { location: "/cas/form?service=site" });
      return res.end();
    }
    if (url.pathname === "/cas/form") {
      res.writeHead(200, { "content-type": "text/html", "set-cookie": "cas_session=abc; Path=/" });
      res.end(`<html><body><form><span id="sm2publicKey">${keys.publicKey}</span>
        <input name="i_user"><input name="i_pass" type="password"></form></body></html>`);
      return;
    }
    if (url.pathname === "/do/off/ui/auth/login/check" && req.method === "POST") {
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", () => {
        const form = new URLSearchParams(raw);
        seen.checks += 1;
        seen.deviceName = form.get("deviceName") || "";
        seen.singleLogin = form.get("singleLogin") || "";
        const cipher = String(form.get("i_pass") || "");
        try {
          seen.decrypted = sm2.doDecrypt(cipher.replace(/^04/, ""), keys.privateKey);
        } catch {
          seen.decrypted = "";
        }
        const user = form.get("i_user");
        if (user !== "2024000000" || seen.decrypted !== "right-pass") {
          res.writeHead(200, { "content-type": "text/html" });
          res.end('<html><body><span id="msg_note">用户名或密码不正确</span></body></html>');
          return;
        }
        res.writeHead(200, { "content-type": "text/html", "set-cookie": "ticket=T-1; Path=/" });
        res.end('<html><body>登录成功。正在重定向到 <a href="/site/callback?ticket=T-1">目标</a></body></html>');
      });
      return;
    }
    if (url.pathname === "/site/callback") {
      const ok = url.searchParams.get("ticket") === "T-1";
      res.writeHead(ok ? 302 : 400, ok
        ? { location: "/site/home", "set-cookie": "site_session=live; Path=/; Domain=127.0.0.1" }
        : {});
      return res.end();
    }
    if (url.pathname === "/site/home") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>座位首页</html>");
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, seen, close: () => new Promise(resolve => server.close(resolve)) };
}

test("CAS HTTP：SM2 加密的账号密码换到目标站 Cookie", async t => {
  const cas = await fakeCas();
  t.after(() => cas.close());
  const jar = createCookieJar();
  const result = await casLoginHttp({ entryUrl: cas.base + "/site/login", casOrigin: cas.base, username: "2024000000", password: "right-pass", jar });
  assert.equal(result.ok, true);
  assert.equal(cas.seen.checks, 1);
  assert.equal(cas.seen.decrypted, "right-pass", "服务端必须能解出原密码（SM2 模式与 04 前缀都要对）");
  assert.equal(cas.seen.singleLogin, "on");
  assert.equal(typeof cas.seen.deviceName, "string");
  assert.match(result.finalUrl, /\/site\/home/);
  const cookies = jarToSnapshotCookies(jar, cas.base);
  assert.ok(cookies.some(cookie => cookie.name === "site_session" && cookie.value === "live"), "应拿到目标站点自己的会话 Cookie");
});

test("CAS HTTP：密码错误按官方提示返回，不伪造成功", async t => {
  const cas = await fakeCas();
  t.after(() => cas.close());
  await assert.rejects(
    () => casLoginHttp({ entryUrl: cas.base + "/site/login", casOrigin: cas.base, username: "2024000000", password: "wrong" }),
    error => error instanceof CasHttpError && error.code === "CAS_CREDENTIALS_INVALID" && /不正确/.test(error.message),
  );
});

test("CAS HTTP：缺账号密码与缺失表单分别报错", async () => {
  await assert.rejects(() => casLoginHttp({ entryUrl: "http://127.0.0.1:9/x", username: "", password: "p" }), { code: "CAS_ACCOUNT_REQUIRED" });
  await assert.rejects(() => casLoginHttp({ entryUrl: "http://127.0.0.1:9/x", username: "u", password: "" }), { code: "CAS_PASSWORD_REQUIRED" });

  const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>没有表单</html>"); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(() => casLoginHttp({ entryUrl: base + "/", username: "u", password: "p" }), { code: "CAS_FORM_NOT_FOUND" });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("CAS HTTP：二次认证与验证码单独归类，提示本人完成", () => {
  assert.equal(parseLoginOutcome("<html>请完成二次认证</html>").code, "CAS_TWO_FACTOR_REQUIRED");
  assert.equal(parseLoginOutcome("<html>请输入验证码</html>").code, "CAS_CAPTCHA_REQUIRED");
  // 真实失败页模板里也出现“验证码”字样，但不能把“密码错误”误判成“要求验证码”。
  const officialFailure = '<html><span id="msg_note">您的用户名或密码不正确，请重试！</span><div class="captcha">验证码</div></html>';
  const failure = parseLoginOutcome(officialFailure);
  assert.equal(failure.code, "CAS_CREDENTIALS_INVALID");
  assert.match(failure.message, /用户名或密码不正确/);
  assert.equal(parseLoginOutcome('<html><span id="msg_note">账号已锁定</span></html>').message, "账号已锁定");
  assert.equal(parseLoginOutcome('<html><span id="sm2publicKey">' + "a".repeat(128) + "</span></html>").ok, false);
  assert.equal(parseSm2PublicKey('<i id="sm2publicKey">' + "b".repeat(128) + "</i>"), "b".repeat(128));
  assert.equal(parseSm2PublicKey("<html></html>"), "");
});