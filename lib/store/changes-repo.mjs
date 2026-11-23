/**
 * 变更日志：多设备同步的拉取来源（#96）。
 *
 * 每个用户一条单调递增的 seq；写入与业务变更放在同一事务里，
 * 设备用 since=上次拉到的 seq 增量拉取，天然幂等。
 */
import { iso } from "./pg.mjs";

const rowOf = row => ({
  seq: Number(row.seq),
  entity: row.entity,
  entityId: row.entity_id,
  op: row.op,
  payload: row.payload === null || row.payload === undefined
    ? null
    : typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
  createdAt: iso(row.created_at),
});

export function createChangeLog(store) {
  return {
    /** 追加一条变更，seq 由当前最大值 +1 得到；返回落库后的记录。 */
    async append({ userId, entity, entityId, op, payload = null, at = store.now().toISOString() }) {
      return store.transaction(async tx => {
        const { rows } = await tx.query("select coalesce(max(seq), 0) + 1 as next from change_log where user_id = $1", [userId]);
        const seq = Number(rows[0]?.next || 1);
        const { rows: inserted } = await tx.query(
          "insert into change_log (user_id, seq, entity, entity_id, op, payload, created_at) values ($1, $2, $3, $4, $5, $6, $7) returning *",
          [userId, seq, entity, entityId, op, payload === null ? null : JSON.stringify(payload), at],
        );
        return rowOf(inserted[0]);
      });
    },
    /** 增量拉取：since 之后的前 limit 条，按 seq 升序。 */
    async list(userId, { since = 0, limit = 200 } = {}) {
      const { rows } = await store.query(
        "select * from change_log where user_id = $1 and seq > $2 order by seq limit $3",
        [userId, Number(since) || 0, Math.min(Math.max(Number(limit) || 200, 1), 1000)],
      );
      return rows.map(rowOf);
    },
    async latest(userId) {
      const { rows } = await store.query("select coalesce(max(seq), 0) as latest from change_log where user_id = $1", [userId]);
      return Number(rows[0]?.latest || 0);
    },
  };
}