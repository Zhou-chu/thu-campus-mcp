import { CloudClient } from "./client.js";
import { MockDrive } from "./mock.js";
import type { Config } from "./config.js";
import type { Drive } from "./types.js";
export async function makeDrive(config: Config): Promise<Drive> {
  return config.mock ? new MockDrive(config) : new CloudClient(config);
}
