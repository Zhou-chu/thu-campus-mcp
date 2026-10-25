import { expect, it } from "vitest";
import {
  browserSessionData,
  verifyBrowserSession,
} from "../src/browser-auth.js";
it("requires a successful current-semester API response before accepting a browser login", async () => {
  const request = {
    get: async () => ({
      ok: () => true,
      json: async () => ({ message: "success", result: { id: "2026-2027-1" } }),
    }),
  };
  expect(await verifyBrowserSession({ request } as any, "synthetic-csrf")).toBe(
    true,
  );
});
it("does not mistake a login HTML page or rejected API for an authenticated browser", async () => {
  for (const json of [
    async () => {
      throw new Error("HTML login page");
    },
    async () => ({ message: "relogin" }),
  ])
    expect(
      await verifyBrowserSession(
        { request: { get: async () => ({ ok: () => true, json }) } } as any,
        "synthetic-csrf",
      ),
    ).toBe(false);
});
it("extracts a real session including HttpOnly cookies without exposing them in tool parameters", async () => {
  const data = await browserSessionData(
    "local-user",
    [
      {
        name: "JSESSIONID",
        value: "local-cookie",
        domain: "learn.tsinghua.edu.cn",
        path: "/",
        secure: true,
        httpOnly: true,
        expires: -1,
        sameSite: "Lax",
      },
    ],
    '<a href="/b/course?x=1&amp;_csrf=local-csrf">课表</a>',
  );
  expect(data.csrfToken).toBe("local-csrf");
  expect(data.cookieJar?.cookies[0].httpOnly).toBe(true);
  expect(data.password).toBeUndefined();
});
