import { RainClient } from "./client.js";
import { MockRain } from "./mock.js";
import type { Config } from "./config.js";
export async function makeClient(cfg: Config): Promise<RainClient> {
  return cfg.mock ? new MockRain(cfg) : new RainClient(cfg);
}
