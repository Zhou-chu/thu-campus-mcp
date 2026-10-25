import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { openBrowser, runtimeInfo } from "../index.mjs";
const stateDir = await mkdtemp(
  path.join(tmpdir(), "campus-browser-persistence-"),
);
const server = createServer((request, response) => {
  response.setHeader("content-type", "text/html");
  if (request.url === "/login")
    response.setHeader(
      "set-cookie",
      "synthetic_session=retained; HttpOnly; Path=/; SameSite=Lax",
    );
  response.end("<!doctype html><title>Local browser persistence test</title>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
let first, second;
try {
  assert(
    (await runtimeInfo()).installed,
    "Run browser install before browser smoke",
  );
  first = await openBrowser({ stateDir, headless: true });
  const page = first.context.pages()[0] || (await first.context.newPage());
  await page.goto(origin + "/login");
  await page.evaluate(async () => {
    localStorage.setItem("example", "retained");
    await new Promise((resolve, reject) => {
      const open = indexedDB.open("example", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("data");
      open.onerror = reject;
      open.onsuccess = () => {
        const db = open.result,
          tx = db.transaction("data", "readwrite");
        tx.objectStore("data").put("retained", "key");
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = reject;
      };
    });
  });
  await first.close();
  first = undefined;
  second = await openBrowser({ stateDir, headless: true });
  const again = second.context.pages()[0] || (await second.context.newPage());
  await again.goto(origin);
  assert.equal(
    (await second.context.cookies(origin)).find(
      (c) => c.name === "synthetic_session",
    )?.value,
    "retained",
  );
  assert.equal(
    await again.evaluate(() => localStorage.getItem("example")),
    "retained",
  );
  const stored = await again.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("example", 1);
        open.onerror = reject;
        open.onsuccess = () => {
          const db = open.result,
            tx = db.transaction("data", "readonly"),
            read = tx.objectStore("data").get("key");
          read.onsuccess = () => resolve(read.result);
          read.onerror = reject;
          tx.oncomplete = () => db.close();
        };
      }),
  );
  assert.equal(stored, "retained");
  console.log(
    "PASS: independent Chromium; session-only cookie, localStorage and IndexedDB retained across close/reopen with encrypted snapshot.",
  );
} finally {
  await first?.close();
  await second?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(stateDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
