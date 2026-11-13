const SESSION = "[a-f\\d]{8}-[a-f\\d]{4}-[a-f\\d]{4}-[a-f\\d]{4}-[a-f\\d]{12}";
const FILE_PATH = new RegExp(`^/api/workspaces/${SESSION}/files$`, "i");
const JOB_PATH = new RegExp(`^/api/workspaces/(${SESSION})/jobs/([\\w-]{1,128})$`, "i");
export const JOB_LABELS = Object.freeze({ running: "作业运行中", succeeded: "作业完成", failed: "作业失败", cancelled: "作业已停止", timed_out: "作业超时", interrupted: "作业已中断" });

/** Only workspace downloads receive credentials; all other links are explicit HTTP(S). */
export function safeLink(value, origin) {
  if (typeof value !== "string" || /[\u0000-\u0020\\]/.test(value)) return null;
  let url;
  try { url = new URL(value, origin); } catch { return null; }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
  if (url.origin === origin && FILE_PATH.test(url.pathname)) {
    const entries = [...url.searchParams];
    if (url.hash || entries.length !== 1 || entries[0][0] !== "path" || !entries[0][1] || /[\u0000-\u001f]/.test(entries[0][1])) return null;
    return { kind: "artifact", href: url.pathname + url.search, filename: entries[0][1].split(/[\\/]/).at(-1) || "artifact" };
  }
  if (!/^https?:\/\//i.test(value) || url.pathname.startsWith("/api/")) return null;
  return { kind: "external", href: url.href };
}

export async function fetchArtifact(path, { origin, base = "", token, fetchImpl = fetch } = {}) {
  const link = safeLink(path, origin);
  if (link?.kind !== "artifact") throw new Error("下载地址不合法。");
  if (!token) throw new Error("请重新配对后下载。");
  const response = await fetchImpl(base.replace(/\/+$/, "") + link.href, {
    headers: { authorization: "Bearer " + token }, credentials: "omit", redirect: "error",
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data?.error?.message || `下载失败（HTTP ${response.status}）`);
  }
  return { blob: await response.blob(), filename: link.filename };
}

export function workspaceJob(result) {
  const value = result?.ok === true ? result.data : result;
  const job = value?.job || value;
  if (!job || typeof job.statusUrl !== "string" || !Object.hasOwn(JOB_LABELS, job.state)) return null;
  const match = JOB_PATH.exec(job.statusUrl);
  if (!match || job.jobId !== match[2]) return null;
  return { ...job, sessionId: match[1], statusUrl: job.statusUrl };
}

/** One serial polling loop, cancellable when its chat is not visible. Errors require explicit retry. */
export function createJobPoller({ isActive, getJobs, readJob, onUpdate, onError, setTimer = setTimeout, clearTimer = clearTimeout, interval = 1500 }) {
  let timer = null, controller = null, stopped = false;
  const pending = () => !stopped && isActive() ? getJobs().filter(job => job.state === "running" && !job.requestError && !job.stopping) : [];
  const reconcile = () => {
    if (!pending().length) {
      if (timer !== null) clearTimer(timer);
      timer = null;
      controller?.abort();
      return;
    }
    if (timer === null && !controller) timer = setTimer(() => { timer = null; void tick(); }, interval);
  };
  const tick = async () => {
    const current = new AbortController();
    controller = current;
    try {
      for (const job of pending()) {
        if (current.signal.aborted || !isActive()) break;
        try {
          const data = await readJob(job, current.signal);
          if (current.signal.aborted) break;
          const next = data?.ok === true ? workspaceJob(data.job) : null;
          if (!next || next.statusUrl !== job.statusUrl) throw new Error("作业状态响应无效，请重试查询。");
          onUpdate(next);
        } catch (error) {
          if (!current.signal.aborted) onError(job, error);
        }
      }
    } finally { controller = null; reconcile(); }
  };
  return {
    sync() { stopped = false; reconcile(); },
    stop() { stopped = true; if (timer !== null) clearTimer(timer); timer = null; controller?.abort(); },
  };
}

/** Markdown is constructed exclusively from DOM nodes; HTML remains literal text. */
export function renderMarkdown(text, { document = globalThis.document, origin = globalThis.location?.origin, onArtifact = () => {} } = {}) {
  const node = (tag, text) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; return item; };
  const inline = (parent, text) => {
    const tokens = String(text).split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\((?:[^()\s]|\([^()\s]*\))+\))/g);
    for (const token of tokens) {
      if (!token) continue;
      if (token.startsWith("`") && token.endsWith("`")) parent.append(node("code", token.slice(1, -1)));
      else if (token.startsWith("**") && token.endsWith("**")) parent.append(node("strong", token.slice(2, -2)));
      else {
        const match = /^\[([^\]]+)\]\((.*)\)$/.exec(token);
        const link = match && safeLink(match[2], origin);
        if (!link) { parent.append(document.createTextNode(token)); continue; }
        const anchor = node("a", match[1]);
        anchor.href = link.href;
        if (link.kind === "artifact") {
          anchor.className = "artifact-link";
          anchor.addEventListener("click", event => { event.preventDefault(); onArtifact(link, anchor); });
        } else { anchor.target = "_blank"; anchor.rel = "noopener noreferrer"; }
        parent.append(anchor);
      }
    }
  };
  const fragment = document.createDocumentFragment();
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const splitRow = line => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      const code = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      fragment.append(node("pre", code.join("\n"))); i++; continue;
    }
    if (!line.trim()) { i++; continue; }
    if (/^\s*\|/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || "")) {
      const table = node("table"), head = node("thead"), row = node("tr"), body = node("tbody"), wrap = node("div");
      table.className = "rich-table"; wrap.className = "rich-table-wrap";
      for (const cell of splitRow(line)) { const th = node("th"); inline(th, cell); row.append(th); }
      head.append(row); i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        const tr = node("tr");
        for (const cell of splitRow(lines[i++])) { const td = node("td"); inline(td, cell); tr.append(td); }
        body.append(tr);
      }
      table.append(head, body); wrap.append(table); fragment.append(wrap); continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) { const h = node("h" + heading[1].length); inline(h, heading[2]); fragment.append(h); i++; continue; }
    const listItem = /^\s*(?:(\d+)[.)]|([-+*]))\s+(.+)$/.exec(line);
    if (listItem) {
      const ordered = !!listItem[1], list = node(ordered ? "ol" : "ul");
      if (ordered) list.start = Number(listItem[1]);
      while (i < lines.length) {
        const item = /^\s*(?:(\d+)[.)]|([-+*]))\s+(.+)$/.exec(lines[i]);
        if (!item || !!item[1] !== ordered) break;
        const li = node("li"); inline(li, item[3]); list.append(li); i++;
      }
      fragment.append(list); continue;
    }
    const paragraph = node("p"); inline(paragraph, line); fragment.append(paragraph); i++;
  }
  return fragment;
}
