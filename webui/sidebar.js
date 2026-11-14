// Receives validated storagePresentation output, never a raw provider ready flag.
export function sidebarStorageLabel(info) {
  if (info?.state === "ready") {
    const scope = info.scope;
    return scope && [scope.accountId, scope.repoId, scope.rootPath].every(value => typeof value === "string" && value.trim())
      ? "云盘已连接" : "云盘未核验";
  }
  return typeof info?.label === "string" && info.label.trim()
    ? info.label.replace("云盘工作区", "云盘") : "云盘未核验";
}

export function recentSessions(sessions) {
  const result = [], seen = new Set();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!session || typeof session.id !== "string" || !session.id.trim() || seen.has(session.id)) continue;
    seen.add(session.id);
    result.push({ id: session.id, title: typeof session.title === "string" && session.title.trim() ? session.title : "未命名对话" });
    if (result.length === 3) break;
  }
  return result;
}
