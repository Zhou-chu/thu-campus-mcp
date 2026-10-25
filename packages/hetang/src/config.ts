import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
export const ORIGIN = "https://pro.yuketang.cn";
export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export interface Config {
  stateDir: string;
  outputDir: string;
  mock: boolean;
  timeoutMs: number;
  maxBytes: number;
  cloudCli: string;
}
export function loadConfig(overrides: Partial<Config> = {}): Config {
  return {
    stateDir: path.resolve(
      process.env.HETANG_STATE_DIR || path.join(homedir(), ".hetang-mcp"),
    ),
    outputDir: path.resolve(process.env.HETANG_OUTPUT_DIR || "D:/荷塘雨课堂"),
    mock: process.env.HETANG_MOCK === "1",
    timeoutMs: 45000,
    maxBytes: 4 * 1024 ** 3,
    cloudCli: path.resolve(
      process.env.HETANG_CLOUD_CLI ||
        path.join(projectRoot, "..", "thu-cloud", "dist", "cli.js"),
    ),
    ...overrides,
  };
}
