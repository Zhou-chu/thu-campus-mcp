import { randomUUID } from "node:crypto";
import path from "node:path";
import { atomicJson, readJson, digest, withLock } from "./storage.js";
import { RainError, publicError, type SessionContext } from "./types.js";
import type { Config } from "./config.js";
export interface RecordData {
  id: string;
  accountId: string;
  fingerprint: string;
  action: string;
  summary: unknown;
  status: "started" | "complete" | "failed" | "unknown";
  createdAt: string;
  checkedAt?: string;
  result?: unknown;
  error?: unknown;
}
export class Operations {
  constructor(
    private client: SessionContext,
    private config: Config,
  ) {}
  private file(id: string) {
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id))
      throw new RainError("INVALID_ID", "操作 ID 无效。");
    return path.join(this.config.stateDir, "operations", id + ".json");
  }
  async get(id: string) {
    await this.client.checkAuth();
    const r = await readJson<RecordData>(this.file(id));
    if (!r || r.accountId !== this.client.identity)
      throw new RainError("NOT_FOUND", "当前账号没有该操作记录。");
    return { ...r, status: r.status === "started" ? "unknown" : r.status };
  }
  async run(
    action: string,
    summary: unknown,
    fn: () => Promise<unknown>,
    requestId: string = randomUUID(),
  ) {
    const file = this.file(requestId);
    await this.client.checkAuth();
    const identity = this.client.identity;
    const fingerprint = digest(JSON.stringify([identity, action, summary]));
    return withLock(
      path.join(this.config.stateDir, "operation-locks", requestId),
      async () => {
        const old = await readJson<RecordData>(file);
        if (old) {
          if (old.fingerprint !== fingerprint)
            throw new RainError(
              "REQUEST_CONFLICT",
              "操作 ID 已绑定其他参数或账号。",
            );
          return this.get(requestId);
        }
        const r: RecordData = {
          id: requestId,
          accountId: identity,
          fingerprint,
          action,
          summary,
          status: "started",
          createdAt: new Date().toISOString(),
        };
        await atomicJson(file, r);
        try {
          r.result = await fn();
          await this.client.checkAuth();
          if (this.client.identity !== identity)
            throw new RainError("AUTH_CHANGED", "操作期间账号发生变化。");
          r.status = "complete";
        } catch (e) {
          r.status =
            e instanceof RainError &&
            e.code !== "AUTH_CHANGED" &&
            (e.status === undefined || (e.status >= 400 && e.status < 500))
              ? "failed"
              : "unknown";
          r.error = publicError(e);
        }
        r.checkedAt = new Date().toISOString();
        await atomicJson(file, r);
        return r;
      },
    );
  }
}
