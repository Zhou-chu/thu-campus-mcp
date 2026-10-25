import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, digest, withLock } from "./storage.js";
import { RainError } from "./types.js";
export interface AuthData {
  account: string;
  userId: string;
  cookieHeader: string;
  bearerToken?: string;
}

function dpapi(input: string, decrypt: boolean): Promise<string> {
  if (process.platform !== "win32")
    throw new RainError(
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
      reject(new RainError("AUTH_STORAGE", "无法启动本机凭据保护组件。")),
    );
    child.on("close", (code) =>
      code === 0
        ? resolve(output.trim())
        : reject(
            new RainError(
              "AUTH_STORAGE",
              "凭据保护/解密失败，请以相同 Windows 用户重新登录。",
            ),
          ),
    );
    child.stdin.end(input);
  });
}
const authQueues = new Map<string, Promise<unknown>>();
export class AuthStore<T extends { account: string } = AuthData> {
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const key = path.resolve(this.directory).toLowerCase();
    const previous = authQueues.get(key) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => withLock(path.join(this.directory, "auth-lock"), fn));
    authQueues.set(key, next);
    void next
      .finally(() => {
        if (authQueues.get(key) === next) authQueues.delete(key);
      })
      .catch(() => {});
    return next;
  }
  private async generationUnlocked() {
    const file = path.join(this.directory, "auth-generation");
    try {
      return await readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const value = randomUUID();
      await atomicWrite(file, value);
      return value;
    }
  }
  async generation() {
    return this.locked(() => this.generationUnlocked());
  }
  private async advance() {
    await atomicWrite(
      path.join(this.directory, "auth-generation"),
      randomUUID(),
    );
  }

  readonly file: string;
  constructor(readonly directory: string) {
    this.file = path.join(directory, "auth.dpapi");
  }
  async version(): Promise<string | undefined> {
    try {
      return digest(await readFile(this.file));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }
  async loadVersioned(): Promise<{ data: T; version: string } | undefined> {
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
  async load(): Promise<T | undefined> {
    return (await this.loadVersioned())?.data;
  }
  async save(data: T): Promise<void> {
    if (!data.account?.trim())
      throw new RainError("AUTH_ACCOUNT", "必须指定会话所属账号。");
    // FIFO within this process plus a cross-process lock: a later logout always wins.
    await this.locked(async () => {
      const encrypted = await dpapi(
        Buffer.from(JSON.stringify(data)).toString("base64"),
        false,
      );
      await atomicWrite(this.file, encrypted);
      await this.advance();
    });
  }
  async saveIfCurrent(data: T, expectedGeneration: string): Promise<string> {
    const encrypted = await dpapi(
      Buffer.from(JSON.stringify(data)).toString("base64"),
      false,
    );
    return this.locked(async () => {
      if ((await this.generationUnlocked()) !== expectedGeneration)
        throw new RainError(
          "AUTH_CHANGED",
          "认证已变化，待完成的登录未恢复旧会话。",
        );
      await atomicWrite(this.file, encrypted);
      await this.advance();
      return digest(encrypted);
    });
  }
  async clear(): Promise<void> {
    await this.locked(async () => {
      await this.advance();
      await rm(this.file, { force: true });
    });
  }
  async status() {
    const auth = await this.load();
    return {
      configured: Boolean(auth),
      accountId: auth ? digest(auth.account).slice(0, 16) : undefined,
      protection: "Windows-DPAPI",
    };
  }
}
