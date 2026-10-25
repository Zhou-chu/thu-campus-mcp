import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openBrowser } from "../index.mjs";
const dir = await mkdtemp(path.join(tmpdir(), "campus-browser-native-close-"));
const server = createServer((_q, r) =>
  r.end("<!doctype html><title>native close</title>"),
);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = "http://127.0.0.1:" + server.address().port;
let browser;
try {
  browser = await openBrowser({ stateDir: dir, headless: true });
  let page = browser.context.pages()[0] || (await browser.context.newPage());
  await page.goto(origin);
  await browser.context.addCookies([
    {
      name: "persistent",
      value: "old",
      url: origin,
      expires: Date.now() / 1000 + 3600,
    },
    { name: "session", value: "old", url: origin },
  ]);
  await browser.checkpoint();
  await browser.context.addCookies([
    {
      name: "persistent",
      value: "new",
      url: origin,
      expires: Date.now() / 1000 + 3600,
    },
    { name: "session", value: "new", url: origin },
  ]);
  await page.evaluate(() => localStorage.setItem("changed", "new"));
  await browser.context.close();
  browser = undefined;
  browser = await openBrowser({ stateDir: dir, headless: true });
  assert.equal(
    (await browser.context.cookies(origin)).find((c) => c.name === "persistent")
      ?.value,
    "new",
  );
  assert.equal(
    (await browser.context.cookies(origin)).find((c) => c.name === "session")
      ?.value,
    "new",
  );
  page = browser.context.pages()[0] || (await browser.context.newPage());
  await page.goto(origin);
  assert.equal(
    await page.evaluate(() => localStorage.getItem("changed")),
    "new",
  );
  await browser.checkpoint();
  await browser.context.addCookies([
    {
      name: "persistent",
      value: "native-newest",
      url: origin,
      expires: Date.now() / 1000 + 3600,
    },
  ]);
  await page.evaluate(() => localStorage.setItem("changed", "native-newest"));
  await browser.context.browser().close();
  browser = undefined;
  browser = await openBrowser({ stateDir: dir, headless: true });
  assert.equal(
    (await browser.context.cookies(origin)).find((c) => c.name === "persistent")
      ?.value,
    "native-newest",
  );
  page = browser.context.pages()[0] || (await browser.context.newPage());
  await page.goto(origin);
  assert.equal(
    await page.evaluate(() => localStorage.getItem("changed")),
    "native-newest",
  );
  console.log(
    "PASS: native context/browser close keeps newest cookies and localStorage; old snapshot never rewinds native data.",
  );
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
  await rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
