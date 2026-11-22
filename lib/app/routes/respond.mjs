/** 路由模块共享的响应 helper：只是转调 http-envelope，避免每个路由文件重复实现。 */
import { sendError, sendJson } from "../http-envelope.mjs";

export const json = sendJson;
export const fail = (res, status, code, message) => sendError(res, status, code, message);