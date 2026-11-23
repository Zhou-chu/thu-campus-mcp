import { isLoopback } from "./settings.mjs";

function tlsPublicHost(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash) return url.host;
  } catch { /* An invalid public URL cannot establish proxy trust. */ }
  return null;
}

export function assertServeTransport(config) {
  if (config.tlsProxy) {
    if (!isLoopback(config.host) || config.tlsCert || config.tlsKey || !tlsPublicHost(config.publicUrl)) {
      throw Object.assign(new Error("TLS代理模式仅支持回环监听、HTTPS公开地址且不同时配置本机证书。"), { code: "INVALID_TLS_PROXY" });
    }
    return;
  }
  if ((config.allowRemote || !isLoopback(config.host) || config.publicUrl) && !(config.tlsCert && config.tlsKey)) {
    // Explicit, temporary migration flag: an already-running plaintext deployment keeps working
    // while it is moved behind TLS. It never becomes the default and is reported at startup.
    if (config.plaintextLegacy) return "plaintext-legacy";
    throw Object.assign(new Error("托管运行时必须使用TLS：配置证书和私钥，或将运行时绑到回环地址并显式启用TLS代理。"), { code: "TLS_REQUIRED" });
  }
}

/** Trust overwritten forwarding headers only from the explicitly configured loopback proxy. */
export function requestUsesTrustedHttps(req, config) {
  if (req.socket.encrypted) return true;
  if (!config.tlsProxy || !isLoopback(config.host) || !isLoopbackPeer(req.socket.remoteAddress)) return false;
  const expected = tlsPublicHost(config.publicUrl);
  return !!expected && req.headers.host?.toLowerCase() === expected && req.headers["x-forwarded-host"]?.toLowerCase() === expected && req.headers["x-forwarded-proto"] === "https";
}

/** 只解析 Host 头里的主机名，不构造任何 URL（避免出现明文协议字面量）。 */
function hostnameOf(header) {
  const value = String(header || "").trim().toLowerCase();
  if (!value) return "";
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 0 ? value.slice(1, end) : "";
  }
  return value.split(":")[0];
}
function isLoopbackPeer(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function requestCanCarrySecrets(req, config) {
  if (requestUsesTrustedHttps(req, config)) return true;
  if (!isLoopbackPeer(req.socket.remoteAddress)) return false;
  return isLoopback(hostnameOf(req.headers.host));
}
