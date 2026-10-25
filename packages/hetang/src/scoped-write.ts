import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { SessionContext } from "./types.js";
import { RainError } from "./types.js";
import { Operations } from "./operations.js";
import { digest, readJson, atomicJson, withLock } from "./storage.js";
/** Durable semantic barrier independent of a caller's chosen request ID. */
export async function scopedWrite(
  client: SessionContext,
  cfg: Config,
  scope: string,
  action: string,
  summary: unknown,
  requestId: string | undefined,
  fn: (dispatched: () => Promise<void>) => Promise<unknown>,
  reuseComplete = true,
) {
  await client.checkAuth();
  const key = digest(client.identity + ":" + scope),
    pointer = path.join(cfg.stateDir, "write-scopes", key + ".json");
  return withLock(
    path.join(cfg.stateDir, "write-scope-locks", key),
    async () => {
      await client.checkAuth();
      const ops = new Operations(client, cfg),
        old = await readJson<{ operationId: string }>(pointer);
      if (old) {
        const receipt = await ops.get(old.operationId);
        if (
          receipt.status === "unknown" ||
          (reuseComplete && receipt.status === "complete")
        )
          return receipt;
      }
      const operationId = requestId || randomUUID();
      let sent = false;
      return ops.run(
        action,
        summary,
        async () => {
          try {
            return await fn(async () => {
              await client.checkAuth();
              await atomicJson(pointer, { operationId });
              sent = true;
            });
          } catch (e) {
            if (
              sent &&
              !(
                e instanceof RainError &&
                e.status !== undefined &&
                e.status >= 400 &&
                e.status < 500
              )
            )
              throw new RainError(
                "WRITE_UNKNOWN",
                "写入已派发但结果未确认；请查询原操作回执，不要重投。",
                500,
              );
            throw e;
          }
        },
        operationId,
      );
    },
  );
}
