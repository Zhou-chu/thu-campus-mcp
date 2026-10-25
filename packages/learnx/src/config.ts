import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export interface Config { stateDir: string; outputDir: string; mock: boolean; maxDownloadBytes: number; requestTimeoutMs: number }
export function loadConfig(overrides: Partial<Config> = {}): Config {
  return {
    stateDir: path.resolve(process.env.LEARNX_STATE_DIR || path.join(homedir(), '.learnx-mcp')),
    outputDir: path.resolve(process.env.LEARNX_OUTPUT_DIR || path.join(projectRoot, 'downloads')),
    mock: process.env.LEARNX_MOCK === '1', maxDownloadBytes: 512 * 1024 * 1024, requestTimeoutMs: 45000,
    ...overrides,
  };
}
