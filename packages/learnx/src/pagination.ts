import { digest } from './storage.js';
import { LearnError } from './types.js';
type RequestFn = (url: string, init: RequestInit) => Promise<Response>;
function listShape(json: any): { items: any[]; key?: string; direct: boolean; total?: number } | undefined {
  const object = json?.object;
  const key = ['aaData', 'resultsList', 'rows'].find(k => Array.isArray(object?.[k]));
  const items = Array.isArray(object) ? object : key ? object[key] : undefined;
  if (!items) return undefined;
  const totals = [object?.iTotalDisplayRecords, object?.iTotalRecords, object?.total, object?.totalCount, json?.iTotalRecords, json?.total].filter(n => n !== null && n !== undefined && n !== '').map(Number).filter(n => Number.isFinite(n) && n >= 0);
  return { items, key, direct: Array.isArray(object), total: totals.length ? Math.max(...totals) : undefined };
}
function nextRequest(url: string, init: RequestInit, offset: number, pageSize: number) {
  const parsed = new URL(url); parsed.searchParams.set('iDisplayStart', String(offset)); parsed.searchParams.set('iDisplayLength', String(pageSize));
  parsed.searchParams.set('start', String(offset)); parsed.searchParams.set('page', String(Math.floor(offset / pageSize) + 1));
  if (parsed.searchParams.has('size')) parsed.searchParams.set('size', String(pageSize));
  if (init.body instanceof FormData) {
    const body = new FormData(); for (const [k, v] of init.body.entries()) body.append(k, v);
    const data = JSON.parse(String(body.get('aoData') || '[]')).filter((e: any) => !['iDisplayStart', 'iDisplayLength'].includes(e.name));
    data.push({ name: 'iDisplayStart', value: offset }, { name: 'iDisplayLength', value: pageSize }); body.set('aoData', JSON.stringify(data));
    return { url: parsed.toString(), init: { ...init, body } };
  }
  return { url: parsed.toString(), init };
}
export async function fetchListPages(request: RequestFn, url: string, init: RequestInit): Promise<Response> {
  const pageSize = Number(new URL(url).searchParams.get('size')) || 200;
  const initial = nextRequest(url, init, 0, pageSize);
  const first = await request(initial.url, initial.init);
  if (!first.ok || !/json/i.test(first.headers.get('content-type') || '')) return first;
  const json = await first.json(); const shape = listShape(json);
  if (!shape) return Response.json(json, { status: first.status });
  const all = [...shape.items]; const pageHashes = new Set([digest(JSON.stringify(shape.items))]);
  let current = shape;
  for (let page = 1; ; page++) {
    if ((current.total !== undefined && all.length >= current.total) || (current.total === undefined && current.items.length < pageSize)) break;
    if (page >= 500) throw new LearnError('PAGINATION_LIMIT', '列表分页超过限制，未宣称完整同步。');
    const next = nextRequest(url, init, all.length, pageSize); const response = await request(next.url, next.init);
    if (!response.ok) throw new LearnError('PAGINATION_FAILED', '后续分页请求失败，未宣称完整同步。');
    const nextJson = await response.json(); const part = listShape(nextJson);
    if (!part || nextJson.result === 'error') throw new LearnError('PAGINATION_FAILED', '后续分页响应格式不完整。');
    if (part.items.length === 0) {
      if (current.total !== undefined && all.length < current.total) throw new LearnError('PAGINATION_INCOMPLETE', '服务器分页提前结束，未宣称完整同步。');
      break;
    }
    const hash = digest(JSON.stringify(part.items));
    if (pageHashes.has(hash)) throw new LearnError('PAGINATION_UNSUPPORTED', '站点未响应分页参数，无法确认已抓取全部内容。');
    pageHashes.add(hash); all.push(...part.items); current = { ...part, total: part.total ?? current.total };
  }
  if (shape.direct) json.object = all; else json.object[shape.key!] = all;
  return Response.json(json, { status: first.status });
}
