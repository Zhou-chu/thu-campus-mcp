import path from "node:path";
import { homedir } from "node:os";
import { readFile, access, copyFile, mkdir } from "node:fs/promises";
import { parse, stringify } from "smol-toml";
import lockfile from "proper-lockfile";
import {
  clientConfig,
  root,
  services,
  modulePath,
  loadModule,
} from "./services.mjs";
import { browserConfig, BrowserError } from "@thu-campus/browser";
import { atomic } from "../packages/browser/core.mjs";
async function exists(p) {
  try {
    await access(p);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}
export async function unifiedConfig() {
  const split = (await clientConfig()).mcpServers;
  const env = Object.assign({}, ...Object.values(split).map((s) => s.env));
  env.THU_CAMPUS_MOCK = "0";
  env.THU_BROWSER_STATE_DIR = browserConfig().stateDir;
  if (process.env.THU_BROWSER_RUNTIME_DIR)
    env.THU_BROWSER_RUNTIME_DIR = browserConfig().runtimeDir;
  return {
    mcpServers: {
      "thu-campus": {
        command: process.execPath,
        args: [path.join(root, "bin/thu-campus.mjs"), "serve"],
        env,
      },
    },
  };
}
function owned(entry, target) {
  return (
    entry &&
    path.resolve(entry.args?.[0] || "").toLowerCase() === target.toLowerCase()
  );
}
function removeToml(text, name) {
  let remove = false,
    out = "";
  for (const line of text.split(/(?<=\n)/)) {
    if (/^\s*\[/.test(line))
      remove = new RegExp(
        "^\\s*\\[mcp_servers\\.(?:" +
          name +
          '|"' +
          name +
          "\"|'" +
          name +
          "')(?:\\.[^\\]]+)?\\]\\s*(?:#.*)?(?:\\r?\\n)?$",
      ).test(line);
    if (!remove) out += line;
  }
  return out;
}
export async function installUnified(options = {}) {
  const home = options.home || homedir(),
    harnessHome =
      options.harnessHome ||
      process.env.DSH_HOME ||
      ((await exists("D:/DeepSeekHarness/home"))
        ? "D:/DeepSeekHarness/home"
        : path.join(home, ".dsh"));
  const targets = [
    {
      client: "Claude Code",
      file: path.join(home, ".claude.json"),
      format: "json",
    },
    {
      client: "Codex",
      file: path.join(home, ".codex/config.toml"),
      format: "toml",
    },
    {
      client: "Antigravity",
      file: path.join(home, ".gemini/config/mcp_config.json"),
      format: "json",
    },
  ];
  if (await exists(path.join(home, ".gemini/antigravity/mcp_config.json")))
    targets.push({
      client: "Antigravity legacy",
      file: path.join(home, ".gemini/antigravity/mcp_config.json"),
      format: "json",
    });
  if (await exists(harnessHome))
    targets.push({
      client: "DeepSeek Harness",
      file: path.join(harnessHome, "@wingsky-1/dsh-mcp-manager/mcp.json"),
      format: "harness",
    });
  const base = (await unifiedConfig()).mcpServers["thu-campus"],
    changes = [];
  for (const t of targets) {
    const present = await exists(t.file),
      before = present ? await readFile(t.file, "utf8") : "";
    const data =
      t.format === "toml"
        ? parse(before)
        : before.trim()
          ? JSON.parse(before)
          : t.format === "harness"
            ? { version: 1, servers: [] }
            : {};
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      (t.format === "harness" &&
        (data.version !== 1 || !Array.isArray(data.servers)))
    )
      throw new BrowserError("INVALID_CONFIG", "客户端配置格式无效，未修改。");
    const entries =
      t.format === "harness"
        ? Object.fromEntries(data.servers.map((s) => [s.name, s]))
        : data[t.format === "toml" ? "mcp_servers" : "mcpServers"] || {};
    if (options.uninstall && !entries["thu-campus"]) {
      changes.push({ ...t, present, before, after: before });
      continue;
    }
    if (entries["thu-campus"] && !owned(entries["thu-campus"], base.args[0]))
      throw new BrowserError(
        "INSTALL_CONFLICT",
        "已有其他路径的 thu-campus，未覆盖。",
      );
    const env = { ...base.env, ...entries["thu-campus"]?.env };
    const seen = new Map();
    for (const s of options.uninstall ? [] : services) {
      const old = entries[s.directory];
      if (!old) continue;
      if (!owned(old, modulePath(s)))
        throw new BrowserError(
          "INSTALL_CONFLICT",
          "同名独立服务不属于当前整合包，请先迁移其路径。",
        );
      if (
        old.enabled === false ||
        [
          "enabled_tools",
          "disabled_tools",
          "tools",
          "default_tools_approval_mode",
          "alwaysAllow",
          "disabled",
        ].some(
          (k) =>
            old[k] !== undefined &&
            JSON.stringify(old[k]) !== "[]" &&
            old[k] !== false,
        )
      )
        throw new BrowserError(
          "INSTALL_POLICY_CONFLICT",
          "已有服务有单独的禁用或工具策略，请保留分服务模式或显式配置统一策略。",
        );
      for (const [key, value] of Object.entries(old.env || {})) {
        if (key === "HETANG_CLOUD_CLI") continue;
        if (seen.has(key) && seen.get(key) !== value)
          throw new BrowserError(
            "INSTALL_ENV_CONFLICT",
            "独立服务的同名环境设置不一致，未自动合并。",
          );
        env[key] = value;
        seen.set(key, value);
      }
    }
    env.HETANG_CLOUD_CLI = path.join(root, "packages/thu-cloud/dist/cli.js");
    env.THU_CAMPUS_MOCK = "0";
    for (const s of services) env[s.prefix + "_MOCK"] = "0";
    env.THU_BROWSER_STATE_DIR =
      env.THU_BROWSER_STATE_DIR || browserConfig().stateDir;
    const entry = { ...entries["thu-campus"], ...base, env };
    if (t.format === "harness")
      Object.assign(entry, {
        name: "thu-campus",
        transport: "stdio",
        enabled: true,
        cwd: root,
        description: "清华校园统一 MCP 与独立持久浏览器",
        toolCallTimeoutMs: 180000,
      });
    if (t.format === "toml")
      Object.assign(entry, {
        startup_timeout_sec: entries["thu-campus"]?.startup_timeout_sec ?? 45,
        tool_timeout_sec: entries["thu-campus"]?.tool_timeout_sec ?? 180,
      });
    let after;
    if (t.format === "toml") {
      let rest = before;
      for (const name of options.uninstall
        ? ["thu-campus"]
        : [...services.map((s) => s.directory), "thu-campus"])
        rest = removeToml(rest, name);
      after =
        rest.replace(/\s*$/, "") +
        "\n\n" +
        (options.uninstall
          ? ""
          : stringify({ mcp_servers: { "thu-campus": entry } }));
      parse(after);
    } else if (t.format === "harness") {
      data.servers = data.servers.filter(
        (s) =>
          s.name !== "thu-campus" &&
          (!options.uninstall
            ? !services.some((x) => x.directory === s.name)
            : true),
      );
      if (!options.uninstall) data.servers.push(entry);
      after = JSON.stringify(data, null, 2) + "\n";
    } else {
      data.mcpServers ||= {};
      if (!options.uninstall)
        for (const s of services) delete data.mcpServers[s.directory];
      if (options.uninstall) delete data.mcpServers["thu-campus"];
      else data.mcpServers["thu-campus"] = entry;
      after = JSON.stringify(data, null, 2) + "\n";
    }
    changes.push({ ...t, present, before, after });
  }
  const clients = [];
  for (const c of changes) {
    const changed = c.before !== c.after;
    let backup;
    if (options.apply && changed) {
      await mkdir(path.dirname(c.file), { recursive: true });
      const release = await lockfile.lock(path.dirname(c.file), { retries: 3 });
      try {
        const now = (await exists(c.file))
          ? await readFile(c.file, "utf8")
          : "";
        if (now !== c.before)
          throw new BrowserError(
            "CONFIG_CHANGED",
            "配置同时被修改，请重新预览。",
          );
        if (c.present) {
          backup = c.file + ".campus-backup-" + Date.now();
          await copyFile(c.file, backup);
        }
        await atomic(c.file, c.after);
      } finally {
        await release();
      }
    }
    clients.push({
      client: c.client,
      path: c.file,
      changed,
      applied: Boolean(options.apply && changed),
      backup,
    });
  }
  return { mode: "unified", apply: Boolean(options.apply), clients };
}
