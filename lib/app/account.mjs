import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import path from "node:path";

/** 统一清华账号：只在本地保存，供座位 / 体育 / 教务等 CAS 服务复用。 */
export function accountPath(stateDir = process.env.THU_CAMPUS_APP_STATE_DIR || ".") {
  return path.join(stateDir, "account.json");
}

export function legacySeatCredentialsPath(stateDir = process.env.THU_CAMPUS_APP_STATE_DIR || ".") {
  return path.join(stateDir, "seat-credentials.json");
}

const normalize = (username, password) => ({
  username: String(username ?? "").trim(),
  password: String(password ?? ""),
});

/** 读取账号；没有统一账号时回退到旧的座位凭据，避免老用户重新输入。 */
export async function loadAccount(stateDir) {
  for (const file of [accountPath(stateDir), legacySeatCredentialsPath(stateDir)]) {
    try {
      const raw = JSON.parse(await readFile(file, "utf8"));
      const account = normalize(raw?.username, raw?.password);
      if (account.username && account.password) return { ...account, source: file === accountPath(stateDir) ? "account" : "seat-legacy" };
    } catch {
      continue;
    }
  }
  return null;
}

export async function saveAccount({ username, password }, stateDir) {
  const account = normalize(username, password);
  if (!account.username || !account.password)
    throw Object.assign(new Error("需要同时填写学号（或用户名）与密码。"), { code: "ACCOUNT_INCOMPLETE" });
  const file = accountPath(stateDir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(account), { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
  return account;
}

export async function clearAccount(stateDir) {
  const file = accountPath(stateDir);
  await writeFile(file, "{}", { encoding: "utf8", mode: 0o600 }).catch(() => {});
  return { ok: true };
}

export function maskAccount(account) {
  const username = String(account?.username || "");
  if (!username) return "";
  if (username.length <= 4) return `${username.slice(0, 1)}***`;
  return `${username.slice(0, 4)}****${username.slice(-2)}`;
}