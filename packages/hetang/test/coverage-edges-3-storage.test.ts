import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite, digest, guardedPath, safeSegment, scrub, stableName } from "../src/storage.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const QA_ROOT = fileURLToPath(new URL("../../../.local/qa-temp/", import.meta.url));
let root: string;
beforeEach(async () => {
  await mkdir(QA_ROOT, { recursive: true });
  root = await mkdtemp(path.join(QA_ROOT, "hetang-storage-edges-"));
  for (const key of ["TEMP", "TMP", "TMPDIR"]) vi.stubEnv(key, QA_ROOT);
  vi.mocked(rename).mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  expect(path.dirname(root)).toBe(path.resolve(QA_ROOT));
  expect(path.basename(root)).toMatch(/^hetang-storage-edges-/);
  await rm(root, { recursive: true, force: true });
});

function accelerateRetryDelay() {
  const native = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: (...args: any[]) => void, delay: number, ...args: any[]) => {
    if (delay <= 200) { queueMicrotask(() => fn(...args)); return 0; }
    return native(fn, delay, ...args);
  }) as any);
}

describe("storage atomic local rename failures", () => {
  const windows = process.platform === "win32" ? it : it.skip;
  windows.each(["EPERM", "EACCES", "EBUSY"])("retries a transient %s using the same completed bytes", async (code) => {
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error("temporary scanner lock"), { code }));
    const file = path.join(root, "atomic.bin");
    await atomicWrite(file, new Uint8Array([1, 2, 3]));
    expect(await readFile(file)).toEqual(Buffer.from([1, 2, 3]));
    expect(rename).toHaveBeenCalledTimes(2);
    expect(vi.mocked(rename).mock.calls[0]).toEqual(vi.mocked(rename).mock.calls[1]);
    expect(await readdir(root)).toEqual(["atomic.bin"]);
  });

  it.each(["ENOSPC", undefined])("does not retry a non-transient error code %s and removes its temp file", async (code) => {
    const error = Object.assign(new Error("synthetic disk failure"), { code });
    vi.mocked(rename).mockRejectedValueOnce(error);
    await expect(atomicWrite(path.join(root, "never-created"), "data")).rejects.toBe(error);
    expect(rename).toHaveBeenCalledOnce();
    expect(await readdir(root)).toEqual([]);
  });

  windows("stops after the bounded retry budget and cleans only its own temporary file", async () => {
    const error = Object.assign(new Error("persistent local lock"), { code: "EBUSY" });
    for (let n = 0; n < 20; n++) vi.mocked(rename).mockRejectedValueOnce(error);
    accelerateRetryDelay();
    await expect(atomicWrite(path.join(root, "never-created"), "data")).rejects.toBe(error);
    expect(rename).toHaveBeenCalledTimes(20);
    expect(await readdir(root)).toEqual([]);
  });

  it("allows guardedPath to refer to the exact root and checks already existing ordinary files", async () => {
    expect(await guardedPath(root, ".")).toBe(root);
    await atomicWrite(path.join(root, "present.txt"), "safe");
    expect(await guardedPath(root, "present.txt")).toBe(path.join(root, "present.txt"));
  });
});

describe("storage filename and scrub public helpers", () => {
  it.each([
    [" . . ", "_"], ["...name. .", "name"], ["__name", "_name"],
    ["CON", "_CON"], ["prn.txt", "_prn.txt"], ["LPT9.log", "_LPT9.log"],
    ["a/b:c?d", "a_b_c_d"], ["cafe\u0301", "café"], ["normal", "normal"],
  ])("normalizes segment %s", (input, expected) => {
    expect(safeSegment(input)).toBe(expected);
  });

  it("truncates long titles with a stable digest while stableName differentiates IDs", () => {
    const input = "中文".repeat(50);
    expect(safeSegment(input)).toBe(input.slice(0, 59) + "__" + digest(input).slice(0, 11));
    expect(safeSegment(input)).toHaveLength(72);
    expect(stableName(input, "a")).toBe(safeSegment(input).slice(0, 45) + "__" + digest("a").slice(0, 12));
    expect(stableName(input, "a")).not.toBe(stableName(input, "b"));
  });

  it("recursively scrubs invalid fingerprints, credentials and encoded query delimiters", () => {
    expect(scrub({
      questionFingerprint: "not-a-digest", nested: [{ Password: "hidden", token: "hidden", visible: true }],
      note: "prefix&amp;ticket=hidden&amp;keep=1", suffix: "prefix&sessionid=hidden", count: 2, empty: null,
      url: "https://example.com/?safe=1&access_token=hidden&safe=2&ticket=hidden",
    })).toEqual({
      nested: [{ visible: true }], note: "prefix&amp;keep=1", suffix: "prefix", count: 2, empty: null,
      url: "https://example.com/?safe=1&safe=2",
    });
  });
});
