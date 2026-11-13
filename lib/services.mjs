import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { browserConfig } from "@thu-campus/browser";
export const root = fileURLToPath(new URL("../", import.meta.url));
export const services = [
  { name: "learnx", directory: "learnx", prefix: "LEARNX", count: 13 },
  { name: "cloud", directory: "thu-cloud", prefix: "THU_CLOUD", count: 20 },
  { name: "hetang", directory: "hetang", prefix: "HETANG", count: 19 },
];
export function service(name) {
  const found = services.find((s) => s.name === name || s.directory === name);
  if (!found)
    throw Object.assign(
      new Error(`未知服务：${name}；可用服务：learnx、cloud、hetang。`),
      { code: "UNKNOWN_SERVICE" },
    );
  return found;
}
export function modulePath(s, filename = "cli.js") {
  return path.join(root, "packages", s.directory, "dist", filename);
}
export function serviceEnvironment(env = process.env) {
  return {
    ...env,
    HETANG_CLOUD_CLI: env.HETANG_CLOUD_CLI || modulePath(service("cloud")),
  };
}
export async function loadModule(s, filename) {
  return import(pathToFileURL(modulePath(s, filename)).href);
}
export async function clientConfig() {
  const mcpServers = {};
  for (const s of services) {
    const { loadConfig } = await loadModule(s, "config.js");
    const cfg = loadConfig();
    const env = {
      [s.prefix + "_STATE_DIR"]: cfg.stateDir,
      [s.prefix + "_OUTPUT_DIR"]: cfg.outputDir,
      [s.prefix + "_MOCK"]: "0",
      THU_BROWSER_STATE_DIR: browserConfig().stateDir,
    };
    if (s.name === "hetang") {
      env.HETANG_CLOUD_CLI = cfg.cloudCli;
      const cloud = await loadModule(service("cloud"), "config.js");
      env.THU_CLOUD_STATE_DIR = cloud.loadConfig().stateDir;
    }
    mcpServers[s.directory] = {
      command: process.execPath,
      args: [modulePath(s), "serve"],
      env,
    };
  }
  return { mcpServers };
}
