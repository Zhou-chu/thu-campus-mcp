import { it, expect } from "vitest";
import { cookieToken } from "../src/browser-auth.js";
it("extracts only a cloud seahub API token, not a general SSO cookie", () => {
  const token = "a".repeat(40);
  expect(
    cookieToken([
      {
        name: "seahub_auth",
        value: "user%40tsinghua.edu.cn%40" + token,
        domain: "cloud.tsinghua.edu.cn",
      },
    ]),
  ).toBe(token);
  expect(
    cookieToken([
      { name: "seahub_auth", value: "x@" + token, domain: "evil.example" },
    ]),
  ).toBeUndefined();
  expect(
    cookieToken([
      { name: "sessionid", value: token, domain: "cloud.tsinghua.edu.cn" },
    ]),
  ).toBeUndefined();
});

it("extracts the API token from Django-quoted and percent-encoded auth cookies", () => {
  const token = "unit-test-only-token-123456";
  for (const value of [
    '"user@example.com@' + token + '"',
    encodeURIComponent('"user@example.com@' + token + '"'),
  ])
    expect(
      cookieToken([
        { name: "seahub_auth", domain: "cloud.tsinghua.edu.cn", value },
      ]),
    ).toBe(token);
});
