import path from "node:path";
import { homedir } from "node:os";
import { access, copyFile, readFile, mkdir } from "node:fs/promises";
import { parse, stringify } from "smol-toml";
import { atomicJson, atomicWrite, digest, withLock } from "./storage.js";
import { loadConfig, projectRoot } from "./config.js";
import { CloudError } from "./types.js";
type Entry = { command: string; args: string[]; env?: Record<string, string> };
type Format = "json" | "harness" | "toml";
function sameOwner(existing: any, entry: Entry) {
  return (
    existing &&
    path.resolve(existing.args?.[0] || "") === path.resolve(entry.args[0])
  );
}
function assertOwner(existing: any, entry: Entry) {
  if (existing && !sameOwner(existing, entry))
    throw new CloudError(
      "INSTALL_CONFLICT",
      "已有另一个 thu-cloud 服务使用此名称，未覆盖；请先为其中一个更名。",
    );
}
export function mergeJson(
  text: string,
  entry: Entry,
  format: "json" | "harness",
  uninstall: boolean,
): string {
  const data = text.trim()
    ? JSON.parse(text)
    : format === "harness"
      ? { version: 1, servers: [] }
      : {};
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new CloudError("INVALID_CONFIG", "配置必须为 JSON 对象，未修改。");
  if (format === "harness") {
    if (data.version !== 1 || !Array.isArray(data.servers))
      throw new CloudError(
        "INVALID_CONFIG",
        "不支持该 Harness MCP 管理器配置格式，未修改。",
      );
    const old = data.servers.find((s: any) => s.name === "thu-cloud");
    assertOwner(old, entry);
    if (uninstall && !old) return text;
    const desired = {
      name: "thu-cloud",
      transport: "stdio",
      enabled: true,
      description: "清华云盘文件管理与增量传输",
      toolCallTimeoutMs: 120000,
      ...old,
      ...entry,
      env: { ...old?.env, ...entry.env },
      cwd: projectRoot,
    };
    if (!uninstall && JSON.stringify(old) === JSON.stringify(desired))
      return text;
    data.servers = data.servers.filter((s: any) => s.name !== "thu-cloud");
    if (!uninstall) data.servers.push(desired);
  } else {
    if (
      data.mcpServers !== undefined &&
      (!data.mcpServers ||
        typeof data.mcpServers !== "object" ||
        Array.isArray(data.mcpServers))
    )
      throw new CloudError("INVALID_CONFIG", "mcpServers 格式无效，未修改。");
    data.mcpServers ||= {};
    assertOwner(data.mcpServers["thu-cloud"], entry);
    if (uninstall && !data.mcpServers["thu-cloud"]) return text;
    const desired = {
      ...data.mcpServers["thu-cloud"],
      ...entry,
      env: { ...data.mcpServers["thu-cloud"]?.env, ...entry.env },
    };
    if (
      !uninstall &&
      JSON.stringify(data.mcpServers["thu-cloud"]) === JSON.stringify(desired)
    )
      return text;
    if (uninstall) delete data.mcpServers["thu-cloud"];
    else data.mcpServers["thu-cloud"] = desired;
  }
  return JSON.stringify(data, null, 2) + "\n";
}
export function mergeToml(
  text: string,
  entry: Entry,
  uninstall: boolean,
): string {
  const data = parse(text) as any;
  const old = data.mcp_servers?.["thu-cloud"];
  assertOwner(old, entry);
  const desired = {
    ...old,
    ...entry,
    env: { ...old?.env, ...entry.env },
    startup_timeout_sec: old?.startup_timeout_sec ?? 30,
    tool_timeout_sec: old?.tool_timeout_sec ?? 120,
  };
  if (uninstall && !old) return text;
  if (!uninstall && old && JSON.stringify(old) === JSON.stringify(desired))
    return text;
  // Preserve every byte outside our own tables, including user comments and unrelated nested env tables.
  const lines = text.split(/(?<=\n)/);
  let remove = false;
  const kept: string[] = [];
  for (const line of lines) {
    if (/^\s*\[/.test(line))
      remove =
        /^\s*\[mcp_servers\.(?:thu-cloud|"thu-cloud"|'thu-cloud')(?:\.[^\]]+)?\]\s*(?:#.*)?(?:\r?\n)?$/.test(
          line,
        );
    if (!remove) kept.push(line);
  }
  let output = kept.join("");
  if (!uninstall) {
    output =
      output.replace(/\s*$/, "") +
      "\n\n" +
      stringify({ mcp_servers: { "thu-cloud": desired } });
  }
  const parsed = parse(output) as any;
  if (!uninstall && !parsed.mcp_servers?.["thu-cloud"])
    throw new CloudError("INVALID_CONFIG", "生成的 TOML 未通过校验。");
  return output;
}
async function exists(file: string) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
export interface InstallOptions {
  apply?: boolean;
  uninstall?: boolean;
  home?: string;
  harnessHome?: string;
  stateDir?: string;
}
export interface InstallResult {
  client: string;
  path: string;
  changed: boolean;
  applied: boolean;
  backup?: string;
  status: string;
}
export async function installClients(options: InstallOptions = {}) {
  const home = options.home || homedir();
  const config = loadConfig({
    ...(options.stateDir ? { stateDir: options.stateDir } : {}),
  });
  const harnessHome =
    options.harnessHome ||
    process.env.DSH_HOME ||
    ((await exists("D:/DeepSeekHarness/home"))
      ? "D:/DeepSeekHarness/home"
      : path.join(home, ".dsh"));
  const entry: Entry = {
    command: process.execPath,
    args: [path.join(projectRoot, "dist", "cli.js"), "serve"],
    env: {
      THU_CLOUD_STATE_DIR: config.stateDir,
      THU_CLOUD_OUTPUT_DIR: config.outputDir,
      THU_CLOUD_MOCK: "0",
    },
  };
  const targets: { client: string; path: string; format: Format }[] = [
    {
      client: "Claude Code",
      path: path.join(home, ".claude.json"),
      format: "json",
    },
    {
      client: "Codex",
      path: path.join(home, ".codex", "config.toml"),
      format: "toml",
    },
    {
      client: "Antigravity",
      path: path.join(home, ".gemini", "config", "mcp_config.json"),
      format: "json",
    },
  ];
  const legacy = path.join(home, ".gemini", "antigravity", "mcp_config.json");
  if (await exists(legacy))
    targets.push({
      client: "Antigravity (legacy IDE)",
      path: legacy,
      format: "json",
    });
  if (await exists(harnessHome))
    targets.push({
      client: "DeepSeek Harness",
      path: path.join(harnessHome, "@wingsky-1", "dsh-mcp-manager", "mcp.json"),
      format: "harness",
    });
  const clients: InstallResult[] = [];
  // Validate all targets before mutating the first one.
  const changes = [];
  for (const target of targets) {
    const present = await exists(target.path);
    const before = present ? await readFile(target.path, "utf8") : "";
    const after =
      target.format === "toml"
        ? mergeToml(before, entry, Boolean(options.uninstall))
        : mergeJson(before, entry, target.format, Boolean(options.uninstall));
    changes.push({ ...target, present, before, after });
  }
  for (const change of changes) {
    const changed = change.before !== change.after;
    let backup: string | undefined;
    if (changed && options.apply) {
      await withLock(
        path.join(config.stateDir, "install-locks", digest(change.path)),
        async () => {
          const now = (await exists(change.path))
            ? await readFile(change.path, "utf8")
            : "";
          if (now !== change.before)
            throw new CloudError(
              "CONFIG_CHANGED",
              "客户端配置被同时修改，本次未覆盖，请重试。",
            );
          await mkdir(path.dirname(change.path), { recursive: true });
          if (change.present) {
            backup = `${change.path}.thu-cloud-backup-${Date.now()}`;
            await copyFile(change.path, backup);
          }
          await atomicWrite(change.path, change.after);
        },
      );
    }
    clients.push({
      client: change.client,
      path: change.path,
      changed,
      applied: Boolean(options.apply && changed),
      backup,
      status: changed
        ? options.apply
          ? options.uninstall
            ? "removed"
            : "configured"
          : "planned"
        : "unchanged",
    });
  }
  const report = {
    action: options.uninstall ? "uninstall" : "install",
    apply: Boolean(options.apply),
    clients,
    message: options.apply
      ? "配置已处理。新会话/重载后发现工具；Harness 管理器支持配置热加载。云盘认证通过本机命令另行配置。"
      : "这是安装预览；加 --apply 写入并备份。",
  };
  if (options.apply) {
    await atomicJson(path.join(config.stateDir, "installation.json"), report);
    if (clients.some((c) => c.changed))
      await atomicJson(
        path.join(config.stateDir, "install-history", `${Date.now()}.json`),
        report,
      );
  }
  return report;
}
