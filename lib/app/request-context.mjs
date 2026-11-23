/**
 * 请求级用户上下文：认证闸门通过后写入当前请求的用户 id，
 * 数据仓库按它隔离；没有登录（设备令牌模式）时保持 null。
 */
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

export function enterUser(userId) {
  storage.enterWith({ userId: userId || null });
}

export function currentUserId() {
  return storage.getStore()?.userId || null;
}