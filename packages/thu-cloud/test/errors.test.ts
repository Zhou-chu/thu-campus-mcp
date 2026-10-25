import { it, expect } from "vitest";
import { publicError } from "../src/types.js";
it("reports an allowlisted filesystem error without including paths or raw messages", () => {
  const error = Object.assign(new Error("secret raw diagnostic"), {
    code: "EPERM",
    syscall: "rename",
    path: "private-path",
  });
  const report = publicError(error);
  expect(report).toMatchObject({ systemCode: "EPERM", syscall: "rename" });
  expect(JSON.stringify(report)).not.toMatch(/private-path|secret raw/);
});
