import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
export const CLOUD = "https://cloud.tsinghua.edu.cn";
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
}
export function loadConfig(overrides: Partial<Config> = {}): Config {
  return {
    stateDir: path.resolve(
      process.env.THU_CLOUD_STATE_DIR || path.join(homedir(), ".thu-cloud-mcp"),
    ),
    outputDir: path.resolve(
      process.env.THU_CLOUD_OUTPUT_DIR || path.join(projectRoot, "downloads"),
    ),
    mock: process.env.THU_CLOUD_MOCK === "1",
    timeoutMs: 45000,
    maxBytes: 1024 ** 3,
    ...overrides,
  };
}
