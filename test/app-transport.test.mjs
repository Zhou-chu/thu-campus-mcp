import assert from "node:assert/strict";
import test from "node:test";
import { appConfig } from "../lib/app/settings.mjs";
import { assertServeTransport, requestCanCarrySecrets, requestUsesTrustedHttps } from "../lib/app/transport.mjs";

const publicUrl = "https://campus.example.test:8445";
const local = { host: "127.0.0.1" };
const proxy = { ...local, tlsProxy: true, allowRemote: true, publicUrl };
const req = (peer, headers, encrypted = false) => ({ socket: { remoteAddress: peer, encrypted }, headers });
const host = "campus.example.test:8445";
const forwarded = { host, "x-forwarded-host": host, "x-forwarded-proto": "https" };

test("hosted launch requires native TLS or an explicit loopback TLS proxy", () => {
  assert.doesNotThrow(() => assertServeTransport(local));
  assert.doesNotThrow(() => assertServeTransport({ host: "0.0.0.0", tlsCert: "cert", tlsKey: "key" }));
  assert.doesNotThrow(() => assertServeTransport(proxy));
  for (const cfg of [{ ...local, allowRemote: true }, { ...local, publicUrl }, { host: "0.0.0.0", token: "fixture" }]) {
    assert.throws(() => assertServeTransport(cfg), { code: "TLS_REQUIRED" });
  }
  for (const cfg of [
    { ...proxy, host: "0.0.0.0" }, { ...proxy, tlsCert: "cert" }, { ...proxy, tlsKey: "key" },
    ...["", "http://campus.example.test", `${publicUrl}/nested`, `${publicUrl}?query=1`, `${publicUrl}#hash`, "https://user:pass@campus.example.test"].map(url => ({ ...proxy, publicUrl: url })),
  ]) assert.throws(() => assertServeTransport(cfg), { code: "INVALID_TLS_PROXY" });
  assert.equal(appConfig({ THU_CAMPUS_APP_TLS_PROXY: "1" }).tlsProxy, true);
  assert.equal(appConfig({ THU_CAMPUS_APP_ALLOW_PLAINTEXT: "1" }).plaintextLegacy, true);
  assert.equal(appConfig({}).plaintextLegacy, false);
  assert.equal(assertServeTransport({ ...local, allowRemote: true, plaintextLegacy: true }), "plaintext-legacy");
  assert.equal(assertServeTransport({ host: "0.0.0.0", tlsCert: "cert", tlsKey: "key" }), undefined);
  // Legacy plaintext is an explicit migration aid, never a way around the proxy-mode rules.
  assert.throws(() => assertServeTransport({ ...proxy, tlsCert: "cert", plaintextLegacy: true }), { code: "INVALID_TLS_PROXY" });
});

test("only native TLS, approved proxy hops or local HTTP can carry credentials", () => {
  assert.equal(requestUsesTrustedHttps(req("192.0.2.10", { host }, true), local), true);
  assert.equal(requestUsesTrustedHttps(req("127.0.0.1", forwarded), proxy), true);
  assert.equal(requestUsesTrustedHttps(req("127.0.0.1", forwarded), { ...proxy, publicUrl: "invalid" }), false);
  assert.equal(requestCanCarrySecrets(req("127.0.0.1", { host: "127.0.0.1:8971" }), local), true);
  assert.equal(requestCanCarrySecrets(req("::1", { host: "[::1]:8971" }), local), true);
  for (const [request, cfg] of [
    [req("192.0.2.10", forwarded), proxy], [req("127.0.0.1", forwarded), local], [req("127.0.0.1", forwarded), { ...proxy, host: "0.0.0.0" }],
    [req("127.0.0.1", { ...forwarded, host: "other.example.test" }), proxy],
    [req("127.0.0.1", { ...forwarded, "x-forwarded-host": "other.example.test" }), proxy],
    [req("127.0.0.1", { ...forwarded, "x-forwarded-proto": "https,http" }), proxy],
    [req("127.0.0.1", { host: "[illegal" }), local],
  ]) assert.equal(requestCanCarrySecrets(request, cfg), false);
});
