/**
 * 极简 SSE 读取器：按行解析 `event:` / `data:` / 注释，空行派发事件。
 * 兼容 `\n` 与 `\r\n`，并正确处理跨 chunk 的半行。
 */
export async function* readSseEvents(body, { signal } = {}) {
  if (!body) return;
  const reader = body.getReader();
  // 主动取消pending read，不能等下一块数据到达才响应用户停止。
  const onAbort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data = [];
  const flush = () => {
    if (!data.length) {
      if (event !== "message") {
        event = "message";
        return;
      }
      return null;
    }
    const payload = { event, data: data.join("\n") };
    event = "message";
    data = [];
    return payload;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          const payload = flush();
          if (payload) yield payload;
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value_ = colon < 0 ? "" : line.slice(colon + 1);
        if (value_.startsWith(" ")) value_ = value_.slice(1);
        if (field === "event") event = value_;
        else if (field === "data") data.push(value_);
      }
    }
    if (signal?.aborted) return;
    buffer += decoder.decode();
    if (buffer.trim()) {
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value_ = (colon < 0 ? "" : line.slice(colon + 1)).replace(/^ /, "");
      if (field === "data") data.push(value_);
      else if (field === "event") event = value_;
    }
    const payload = flush();
    if (payload) yield payload;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock?.();
    await body.cancel?.().catch(() => {});
  }
}