import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, digest, withLock } from "./storage.js";
import { LearnError } from "./types.js";
import { randomUUID } from "node:crypto";
export interface AuthData {
  account: string;
  username?: string;
  password?: string;
  fingerPrint?: string;
  fingerGenPrint?: string;
  fingerGenPrint3?: string;
  cookieJar?: Record<string, any>;
  csrfToken?: string;
}
function dpapi(input: string, decrypt: boolean): Promise<string> {
  if (process.platform !== "win32")
    throw new LearnError(
      "AUTH_PLATFORM",
      "本版本的持久认证使用 Windows DPAPI；请在 Windows 本机执行登录。",
    );
  const script = `Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($s); $r=[System.Security.Cryptography.ProtectedData]::${decrypt ? "Unprotect" : "Protect"}($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.resume();
    child.on("error", () =>
      reject(new LearnError("AUTH_STORAGE", "无法启动本机凭据保护组件。")),
    );
    child.on("close", (code) =>
      code === 0
        ? resolve(output.trim())
        : reject(
            new LearnError(
              "AUTH_STORAGE",
              "凭据保护/解密失败，请以相同 Windows 用户重新登录。",
            ),
          ),
    );
    child.stdin.end(input);
  });
}
export class AuthStore {
  readonly file: string;
  constructor(readonly directory: string) {
    this.file = path.join(directory, "auth.dpapi");
  }
  private async browserEpoch() {
    const file = path.join(this.directory, "auth-generation");
    try {
      return await readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const epoch = randomUUID();
      await atomicWrite(file, epoch);
      return epoch;
    }
  }
  async generation() {
    return withLock(path.join(this.directory, "auth-lock"), () =>
      this.browserEpoch(),
    );
  }
  async saveBrowserIfCurrent(
    data: AuthData,
    expected: string,
    expectedVersion?: string | null,
  ) {
    const encrypted = await dpapi(
      Buffer.from(JSON.stringify(data)).toString("base64"),
      false,
    );
    return withLock(path.join(this.directory, "auth-lock"), async () => {
      if (
        (await this.browserEpoch()) !== expected ||
        (expectedVersion !== undefined &&
          ((await this.version()) ?? null) !== expectedVersion)
      )
        throw new LearnError(
          "AUTH_CHANGED",
          "登录期间账号已注销或改变，未恢复旧会话。",
        );
      await atomicWrite(this.file, encrypted);
      await atomicWrite(
        path.join(this.directory, "auth-generation"),
        randomUUID(),
      );
      return digest(encrypted);
    });
  }
  async version(): Promise<string | undefined> {
    try {
      return digest(await readFile(this.file));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }
  async loadVersioned(): Promise<
    { data: AuthData; version: string } | undefined
  > {
    let encrypted: string;
    try {
      encrypted = await readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
    return {
      data: JSON.parse(
        Buffer.from(await dpapi(encrypted, true), "base64").toString("utf8"),
      ),
      version: digest(encrypted),
    };
  }
  async load(): Promise<AuthData | undefined> {
    return (await this.loadVersioned())?.data;
  }
  async save(data: AuthData): Promise<void> {
    if (!data.account?.trim())
      throw new LearnError("AUTH_ACCOUNT", "必须指定会话所属账号。");
    const encrypted = await dpapi(
      Buffer.from(JSON.stringify(data)).toString("base64"),
      false,
    );
    await withLock(path.join(this.directory, "auth-lock"), async () => {
      await atomicWrite(this.file, encrypted);
      await atomicWrite(
        path.join(this.directory, "auth-generation"),
        randomUUID(),
      );
    });
  }
  async saveIfCurrent(
    data: AuthData,
    expectedVersion: string,
  ): Promise<string> {
    const encrypted = await dpapi(
      Buffer.from(JSON.stringify(data)).toString("base64"),
      false,
    );
    return withLock(path.join(this.directory, "auth-lock"), async () => {
      if ((await this.version()) !== expectedVersion)
        throw new LearnError(
          "AUTH_CHANGED",
          "本机认证已变化，请重新执行操作；旧会话未恢复。",
        );
      await atomicWrite(this.file, encrypted);
      await atomicWrite(
        path.join(this.directory, "auth-generation"),
        randomUUID(),
      );
      return digest(encrypted);
    });
  }
  async clear(): Promise<void> {
    await withLock(path.join(this.directory, "auth-lock"), async () => {
      await atomicWrite(
        path.join(this.directory, "auth-generation"),
        randomUUID(),
      );
      await rm(this.file, { force: true });
    });
  }
  async status() {
    const auth = await this.load();
    return {
      configured: Boolean(auth),
      accountId: auth ? digest(auth.account).slice(0, 16) : undefined,
      method: auth
        ? auth.cookieJar && auth.csrfToken
          ? "session"
          : "credentials"
        : undefined,
    };
  }
}
