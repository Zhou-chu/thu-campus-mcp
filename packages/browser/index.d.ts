import type { BrowserContext, Browser } from "playwright-core";
export interface BrowserOptions {
  stateDir?: string;
  runtimeDir?: string;
  channel?: string;
  headless?: boolean;
  timeoutMs?: number;
  expectedAccountId?: string;
  initialCookies?: any[];
  onSaved?: (state: any) => Promise<void>;
  signal?: AbortSignal;
}
export class BrowserError extends Error {
  code: string;
  constructor(code: string, message: string);
}
export const bundleRoot: string;
export function browserConfig(options?: BrowserOptions): {
  stateDir: string;
  runtimeDir: string;
};
export function runtimeInfo(options?: BrowserOptions): Promise<any>;
export function installRuntime(options?: BrowserOptions): Promise<any>;
export function profileLease(options?: BrowserOptions): Promise<{
  config: ReturnType<typeof browserConfig>;
  release: () => Promise<void>;
}>;
export function readSnapshot(options?: BrowserOptions): Promise<any>;
export function saveSnapshot(
  options: BrowserOptions,
  state: any,
): Promise<void>;
export function openBrowser(options?: BrowserOptions): Promise<{
  context: BrowserContext;
  checkpoint: () => Promise<void>;
  close: () => Promise<void>;
  closed: Promise<void>;
  config: ReturnType<typeof browserConfig>;
}>;
export function withBrowser<T>(
  options: BrowserOptions,
  fn: (context: BrowserContext) => Promise<T>,
): Promise<T>;
export function browserStatus(options?: BrowserOptions): Promise<any>;
export function resetBrowser(options?: BrowserOptions): Promise<any>;
export function launchEphemeral(options?: BrowserOptions): Promise<Browser>;
