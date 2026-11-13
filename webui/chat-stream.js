/** Read the application's JSON SSE events without waiting for the response to finish. */
export async function* readChatEvents(body) {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const event = parseEvent(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (event) yield event;
      }
      if (done) {
        const event = parseEvent(buffer);
        if (event) yield event;
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function parseEvent(raw) {
  let event = "message";
  const data = [];
  for (const line of raw.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = (colon < 0 ? "" : line.slice(colon + 1)).replace(/^ /, "");
    if (field === "event") event = value.trim();
    else if (field === "data") data.push(value);
  }
  if (!data.length) return null;
  try {
    const payload = JSON.parse(data.join("\n"));
    return payload && typeof payload === "object" && !Array.isArray(payload) ? { event, payload } : null;
  } catch {
    return null;
  }
}
