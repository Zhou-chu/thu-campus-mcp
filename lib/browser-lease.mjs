/**
 * 跨进程的浏览器租约：真实所有权要落在“谁正持有档案目录”上，而不是一次 HTTP 调用。
 *
 * app 进程的 withBrowserLock 只在一个进程内排队；而 `campus_browser_open/login`
 * 交给 worker 进程后，窗口还开着、档案目录还被占着，app 那边却以为锁已经释放。
 * 这里用状态目录里的一个租约文件把两边对齐：worker 开窗期间持有租约并心跳，
 * app 侧任务看到有效的外来租约就直接 BROWSER_BUSY，并报出占用者。
 */
import path from "node:path";
import { readFile, rename, unlink, writeFile, mkdir } from "node:fs/promises";

const FILE = "browser-lease.json";
/** 心跳超过这个时长就认为持有者已经不在（进程崩了不会有 release）。 */
export const LEASE_STALE_MS = 90_000;

export function leasePath(stateDir) {
  return path.join(stateDir, FILE);
}

/** 读有效租约；过期或损坏一律当没有。 */
export async function readLease(stateDir, now = Date.now) {
  if (!stateDir) return null;
  try {
    const raw = JSON.parse(await readFile(leasePath(stateDir), "utf8"));
    if (!raw || typeof raw !== "object" || !raw.owner) return null;
    const beat = Date.parse(raw.heartbeatAt || raw.since || "");
    if (!Number.isFinite(beat) || now() - beat > LEASE_STALE_MS) return null;
    return { owner: String(raw.owner), label: String(raw.label || raw.owner), pid: raw.pid ?? null, since: raw.since || null };
  } catch {
    return null;
  }
}

/** 抢占式写入：同一 owner 可续租；不同 owner 只有在没有有效租约时才能拿到。 */
export async function acquireLease(stateDir, { owner, label, pid = process.pid, now = Date.now } = {}) {
  if (!stateDir || !owner) return { ok: false, code: "LEASE_INVALID" };
  const existing = await readLease(stateDir, now);
  if (existing && existing.owner !== owner) return { ok: false, code: "BROWSER_BUSY", holder: existing };
  const stamp = new Date(now()).toISOString();
  await mkdir(stateDir, { recursive: true }).catch(() => {});
  const file = leasePath(stateDir);
  const temp = file + "." + process.pid + ".tmp";
  await writeFile(temp, JSON.stringify({ owner, label, pid, since: existing?.since || stamp, heartbeatAt: stamp }));
  await rename(temp, file);
  return { ok: true, lease: { owner, label, pid, since: existing?.since || stamp } };
}

/** 续租：只有 owner 仍是自己时才写心跳，避免把别人的租约续上。 */
export async function renewLease(stateDir, { owner, now = Date.now } = {}) {
  const existing = await readLease(stateDir, now);
  if (!existing || existing.owner !== owner) return false;
  const stamp = new Date(now()).toISOString();
  const file = leasePath(stateDir);
  const temp = file + "." + process.pid + ".tmp";
  await writeFile(temp, JSON.stringify({ ...existing, heartbeatAt: stamp }));
  await rename(temp, file);
  return true;
}

export async function releaseLease(stateDir, { owner } = {}) {
  if (!stateDir || !owner) return false;
  let raw;
  try {
    raw = JSON.parse(await readFile(leasePath(stateDir), "utf8"));
  } catch {
    return false;
  }
  // 只看 owner：过期租约也由持有者自己负责清理，别人的不碰。
  if (!raw || raw.owner !== owner) return false;
  try {
    await unlink(leasePath(stateDir));
    return true;
  } catch {
    return false;
  }
}

/** 周期续租，返回停止函数。 */
export function startLeaseHeartbeat(stateDir, owner, everyMs = 20_000) {
  const timer = setInterval(() => { void renewLease(stateDir, { owner }); }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}