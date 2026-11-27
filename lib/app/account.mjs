import { readFile, mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { atomic, dpapi } from "../../packages/browser/core.mjs";

export function defaultAccountDir() {
  return process.env.THU_CAMPUS_APP_STATE_DIR || process.env.SEAT_STATE_DIR || path.join(homedir(), ".thu-campus-mcp", "app");
}

const configuredDir = () => defaultAccountDir();
export const accountPath = (stateDir = configuredDir()) => path.resolve(stateDir, "account.dpapi");
export const legacySeatCredentialsPath = (stateDir = configuredDir()) => path.resolve(stateDir, "seat-credentials.json");
const oldPaths = dir => [path.resolve(dir, "account.json"), legacySeatCredentialsPath(dir)];
const accountError = (code, message) => Object.assign(new Error(message), { code });

const normalize = (username, password) => ({
  username: typeof username === "string" ? username.trim() : "",
  password: typeof password === "string" ? password : "",
});

/**
 * 身份代际：账号被保存/清除时递增，用来判断“这组会话还属于当前身份吗”。
 * 只存计数与时间，不含任何凭据。
 */
export const accountGenerationPath = (stateDir = configuredDir()) => path.resolve(stateDir, "account-generation.json");

async function readGeneration(dir) {
  try {
    const value = JSON.parse(await readFile(accountGenerationPath(dir), "utf8"));
    return Number.isSafeInteger(value?.generation) && value.generation >= 0 ? value.generation : 0;
  } catch {
    return 0;
  }
}

async function bumpGeneration(dir) {
  const next = (await readGeneration(dir)) + 1;
  await atomic(accountGenerationPath(dir), Buffer.from(JSON.stringify({ generation: next, updatedAt: new Date().toISOString() })));
  return next;
}

/** 当前身份代际；0 表示从未配置过账号。 */
export async function accountGeneration(stateDir) {
  return locked(stateDir, dir => readGeneration(dir));
}

async function readOptional(file) {
  try { return await readFile(file); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function unlinkIfPresent(file) {
  try { await unlink(file); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function locked(stateDir, action) {
  const dir = path.resolve(stateDir ?? configuredDir());
  const lock = path.join(dir, "account-lock");
  await mkdir(lock, { recursive: true });
  const release = await lockfile.lock(lock, { retries: { retries: 40, minTimeout: 25, maxTimeout: 200 } });
  try { return await action(dir); }
  finally { await release(); }
}

function decode(raw) {
  // Do not propagate JSON parsing errors: they can contain substrings of the password.
  try {
    const value = JSON.parse(raw.toString("utf8"));
    const account = normalize(value?.username, value?.password);
    return account.username && account.password ? account : null;
  } catch { return null; }
}

async function protectedAccount(raw) {
  try {
    const account = decode(await dpapi(raw, true));
    if (account) return { ...account, source: "account" };
  } catch { /* Never fall back to plaintext when an encrypted record is unreadable. */ }
  throw accountError("ACCOUNT_STORAGE", "无法解密统一账号，请使用原Windows用户或重新配置。");
}

async function saveProtected(dir, account) {
  const target = accountPath(dir);
  try {
    const encrypted = await dpapi(Buffer.from(JSON.stringify(account)));
    if (!encrypted.length) throw new Error("Empty encrypted record");
    await atomic(target, encrypted);
    const verified = await protectedAccount(await readFile(target));
    if (verified.username !== account.username || verified.password !== account.password) throw new Error("Account verification failed");
  } catch {
    throw accountError("ACCOUNT_STORAGE", "无法用Windows当前用户加密保存统一账号；没有删除旧凭据。");
  }
}

async function removeLegacy(dir) {
  try { for (const file of oldPaths(dir)) await unlinkIfPresent(file); }
  catch { throw accountError("ACCOUNT_LEGACY_CLEANUP", "加密记录已保存，但旧明文凭据未能清理，请检查本机文件权限。"); }
}

/** 从托管的旧文件迁移；验证加密记录后才移除明文，绝不把明文写回。 */
export async function loadAccount(stateDir) {
  return locked(stateDir, async dir => {
    const raw = await readOptional(accountPath(dir));
    if (raw) {
      const account = await protectedAccount(raw);
      await removeLegacy(dir);
      return account;
    }
    for (const [index, file] of oldPaths(dir).entries()) {
      const legacy = await readOptional(file);
      const account = legacy && decode(legacy);
      if (account) {
        await saveProtected(dir, account);
        await removeLegacy(dir);
        return { ...account, source: index === 0 ? "account" : "seat-legacy" };
      }
    }
    return null;
  });
}

export async function saveAccount({ username, password }, stateDir) {
  const account = normalize(username, password);
  if (!account.username || !account.password)
    throw accountError("ACCOUNT_INCOMPLETE", "需要同时填写学号（或用户名）与密码。");
  return locked(stateDir, async dir => {
    const previous = await loadAccountBypassLock(dir).catch(() => null);
    await saveProtected(dir, account);
    await removeLegacy(dir);
    // 身份变了才换代：同一组凭据重复保存不应该让所有会话失效。
    const changed = !previous || previous.username !== account.username || previous.password !== account.password;
    const generation = changed ? await bumpGeneration(dir) : await readGeneration(dir);
    return { ...account, generation, changed };
  });
}

/** 供 saveAccount 在已持有锁时读取旧账号，避免重入死锁。 */
async function loadAccountBypassLock(dir) {
  const raw = await readOptional(accountPath(dir));
  return raw ? protectedAccount(raw) : null;
}

export async function clearAccount(stateDir) {
  return locked(stateDir, async dir => {
    // Remove legacy first, so clearing an encrypted login cannot revive a plaintext one.
    for (const file of oldPaths(dir)) await unlinkIfPresent(file);
    await unlinkIfPresent(accountPath(dir));
    const generation = await bumpGeneration(dir);
    return { ok: true, generation };
  });
}

export function maskAccount(account) {
  const username = String(account?.username || "");
  if (!username) return "";
  if (username.length <= 4) return `${username.slice(0, 1)}***`;
  return `${username.slice(0, 4)}****${username.slice(-2)}`;
}
