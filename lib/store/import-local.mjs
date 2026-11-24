/**
 * 把现有本机 JSON 状态导入 PostgreSQL（一次性迁移）。
 *
 * 只处理可读的 JSON：settings.json、sessions/*.json、schedules.json。
 * DPAPI 凭据（account.dpapi、learnx/auth.dpapi 等）需要 Windows 用户态解密，
 * 这里不碰，迁移报告里明确列为“需单独处理”，避免把密文当明文导入。
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw Object.assign(new Error(`无法读取 ${path.basename(file)}。`), { code: "IMPORT_UNREADABLE" });
  }
}

function scheduleSpec(task) {
  const spec = {};
  if (task.kind === "once") spec.at = task.at;
  if (task.time) spec.time = task.time;
  if (Array.isArray(task.days) && task.days.length) spec.days = task.days;
  return spec;
}

export async function importLocalState({ userId, stateDir, repos, now = () => new Date() } = {}) {
  if (!userId) throw Object.assign(new Error("迁移需要已登录的用户。"), { code: "IMPORT_NO_USER" });
  if (!stateDir) throw Object.assign(new Error("迁移需要状态目录。"), { code: "IMPORT_NO_STATE_DIR" });
  const at = now().toISOString();
  const report = { settings: 0, sessions: 0, messages: 0, schedules: 0, skippedSessions: 0, repairedSessions: 0, warnings: [] };

  const settings = await readJson(path.join(stateDir, "settings.json"), null);
  if (settings && typeof settings === "object") {
    for (const [key, value] of Object.entries(settings)) {
      if (value === undefined || value === null) continue;
      await repos.settings.set(userId, key, value, at);
      report.settings += 1;
    }
  }

  let files = [];
  try {
    files = (await readdir(path.join(stateDir, "sessions"))).filter(name => name.endsWith(".json"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const file of files) {
    const session = await readJson(path.join(stateDir, "sessions", file), null);
    if (!session || typeof session.id !== "string") {
      report.skippedSessions += 1;
      continue;
    }
    const messages = Array.isArray(session.messages) ? session.messages.filter(message => message && typeof message.role === "string") : [];
    const existing = await repos.chat.getSession(userId, session.id);
    if (!existing) {
      await repos.chat.createSession({
        userId,
        id: session.id,
        title: typeof session.title === "string" ? session.title : "新对话",
        at: typeof session.createdAt === "string" ? session.createdAt : at,
      });
      report.sessions += 1;
      for (const message of messages) {
        const { role, createdAt, ...content } = message;
        await repos.chat.appendMessage({ sessionId: session.id, role, content, createdAt: typeof createdAt === "string" ? createdAt : at });
        report.messages += 1;
      }
      continue;
    }
    // 上次导入可能只写了一半：按已有的消息数补齐尾部，而不是整条跳过。
    const stored = await repos.chat.listMessages(session.id);
    if (stored.length >= messages.length) {
      report.skippedSessions += 1;
      continue;
    }
    for (const message of messages.slice(stored.length)) {
      const { role, createdAt, ...content } = message;
      await repos.chat.appendMessage({ sessionId: session.id, role, content, createdAt: typeof createdAt === "string" ? createdAt : at });
      report.messages += 1;
    }
    report.repairedSessions += 1;
  }

  const schedules = await readJson(path.join(stateDir, "schedules.json"), null);
  if (schedules && Array.isArray(schedules.tasks)) {
    for (const task of schedules.tasks) {
      if (!task || typeof task.id !== "string" || typeof task.title !== "string") continue;
      if (await repos.schedules.get(userId, task.id)) continue;
      await repos.schedules.create({
        userId,
        id: task.id,
        title: task.title,
        prompt: typeof task.prompt === "string" ? task.prompt : "",
        kind: typeof task.kind === "string" ? task.kind : "daily",
        spec: scheduleSpec(task),
        enabled: task.enabled !== false,
        at: typeof task.createdAt === "string" ? task.createdAt : at,
      });
      if (task.lastRunAt || task.lastStatus || task.lastError) {
        await repos.schedules.recordRun(userId, task.id, {
          at: typeof task.lastRunAt === "string" ? task.lastRunAt : at,
          status: typeof task.lastStatus === "string" ? task.lastStatus : "",
          error: typeof task.lastError === "string" ? task.lastError : "",
        });
      }
      report.schedules += 1;
    }
  }

  report.warnings.push("DPAPI 凭据（统一账号、网络学堂等）未导入：需要先在本机解密再以服务端密钥重新加密。");
  return report;
}