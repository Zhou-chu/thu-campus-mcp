let nextId = 0;

/** In-memory FIFO; run reads the current model only when dispatching an item. */
export function createTurnQueue({ run, canRun = () => true, onChange = () => {} }) {
  const pending = [];
  let active = null;
  let paused = "";

  function snapshot() {
    return { pending: pending.map(item => ({ ...item })), running: active !== null, paused };
  }

  function changed() {
    onChange(snapshot());
  }

  function enqueue(text) {
    if (typeof text !== "string" || !text.trim()) return null;
    const item = { id: `turn-${++nextId}`, text: text.trim() };
    pending.push(item);
    changed();
    return item.id;
  }

  function remove(id) {
    const index = pending.findIndex(item => item.id === id);
    if (index < 0) return null;
    const [item] = pending.splice(index, 1);
    changed();
    return item;
  }

  function clear() {
    if (!pending.length) return;
    pending.length = 0;
    changed();
  }

  function pause(reason = "队列已暂停") {
    const message = String(reason || "队列已暂停");
    if (paused === message) return;
    paused = message;
    changed();
  }

  function resume() {
    if (!paused) return;
    paused = "";
    changed();
  }

  async function consume() {
    try {
      while (pending.length && !paused && canRun()) {
        const item = pending.shift();
        changed();
        const result = await run(item);
        if (result?.ok !== true) {
          pause(result?.reason || "发送失败，队列已暂停");
        }
      }
    } catch (error) {
      pause(error?.message || "发送异常，队列已暂停");
    }
  }

  function drain() {
    if (active) return active;
    active = Promise.resolve().then(consume).finally(() => {
      active = null;
      changed();
    });
    changed();
    return active;
  }

  return { snapshot, enqueue, remove, clear, pause, resume, drain };
}
