import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import domino from '@mixmark-io/domino';

// Import the application itself. These shims supply missing DOM platform APIs, not application logic.
const root = path.resolve(import.meta.dirname, '..');
const tempRoot = path.join(root, '.local', 'qa-temp');
process.env.TEMP = process.env.TMP = process.env.TMPDIR = tempRoot;
const html = await readFile(path.join(root, 'webui/index.html'), 'utf8');
const origin = 'https://app-unit2.invalid';
const id = '12345678-1234-1234-1234-123456789012';
const key = 'campus.app.connection';
const token = 'unit2-token';
const models = [{ id: 'unit2-model', label: 'unit2-model' }];
const meta = () => ({ ok: true, models, model: { name: models[0].id }, services: {} });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let n = 0; n < 8; n++) await new Promise(resolve => setImmediate(resolve)); };
const until = async predicate => { for (let n = 0; n < 80; n++) { if (predicate()) return; await flush(); } assert.fail('DOM state did not settle'); };
function platform(w) {
  for (const collection of [w.document.querySelectorAll('*'), w.document.querySelectorAll('.tab'), w.document.body.childNodes]) {
    const proto = Object.getPrototypeOf(collection);
    if (!proto[Symbol.iterator]) Object.defineProperty(proto, Symbol.iterator, { value: Array.prototype[Symbol.iterator] });
  }
  const N = w.Node.prototype, E = w.Element.prototype;
  for (const [name, fn] of Object.entries({
    append(...items) { for (const item of items) this.appendChild(item?.nodeType ? item : this.ownerDocument.createTextNode(String(item))); },
    prepend(...items) { for (const item of items.reverse()) this.insertBefore(item?.nodeType ? item : this.ownerDocument.createTextNode(String(item)), this.firstChild); },
    replaceChildren(...items) { while (this.firstChild) this.removeChild(this.firstChild); this.append(...items); },
  })) if (!N[name]) Object.defineProperty(N, name, { value: fn });
  if (!Object.getOwnPropertyDescriptor(E, 'dataset')) Object.defineProperty(E, 'dataset', { get() { const node = this; const attr = k => 'data-' + String(k).replace(/[A-Z]/g, c => '-' + c.toLowerCase()); return new Proxy({}, { get: (_, k) => node.getAttribute(attr(k)) ?? undefined, set: (_, k, v) => { node.setAttribute(attr(k), String(v)); return true; } }); } });
  if (!Object.getOwnPropertyDescriptor(w.HTMLElement.prototype, 'open')) Object.defineProperty(w.HTMLElement.prototype, 'open', { get() { return this.hasAttribute('open'); }, set(v) { if (v) this.setAttribute('open', ''); else this.removeAttribute('open'); } });
  if (!Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, 'value')) Object.defineProperty(w.HTMLSelectElement.prototype, 'value', { get() { const options = [...this.querySelectorAll('option')]; return (options.find(x => x.selected) || options[0])?.value || ''; }, set(v) { for (const o of this.querySelectorAll('option')) o.selected = o.value === String(v); } });
  const captures = new WeakMap();
  for (const [name, fn] of Object.entries({ getBoundingClientRect() { return { width: 1000, height: 400, left: 0, right: 1000, top: 0, bottom: 400 }; }, setPointerCapture(n) { captures.set(this, n); }, hasPointerCapture(n) { return captures.get(this) === n; }, releasePointerCapture() { captures.delete(this); } })) if (!E[name]) Object.defineProperty(E, name, { value: fn });
  for (const [name, value] of Object.entries({ clientWidth: 1280, clientHeight: 400, scrollHeight: 800 })) if (!Object.getOwnPropertyDescriptor(E, name)) Object.defineProperty(E, name, { configurable: true, get: () => value });
  for (const proto of [w.HTMLInputElement.prototype, w.HTMLTextAreaElement.prototype]) {
    if (!proto.setSelectionRange) Object.defineProperty(proto, 'setSelectionRange', { value(a, b) { this.selectionStart = a; this.selectionEnd = b; } });
    if (!proto.select) Object.defineProperty(proto, 'select', { value() { this.setSelectionRange(0, this.value.length); } });
  }
}
let imports = 0;
async function boot(t, { paired = true, href = origin + '/', routes: overrides = {}, storageError = false, width = 1280, theme = '' } = {}) {
  const w = domino.createWindow(html, href); platform(w);
  if (theme) w.document.documentElement.dataset.theme = theme;
  const saved = new Map(paired ? [[key, JSON.stringify({ version: 1, base: origin, token })]] : []);
  const localStorage = { getItem(k) { if (storageError) throw new Error('fixture storage blocked'); return saved.get(k) ?? null; }, setItem(k, v) { if (storageError) throw new Error('fixture storage blocked'); saved.set(k, String(v)); }, removeItem(k) { if (storageError) throw new Error('fixture storage blocked'); saved.delete(k); } };
  w.localStorage = localStorage;
  const routes = new Map(Object.entries({ 'GET /api/meta': meta(), 'GET /api/sessions': { ok: true, sessions: [] }, 'GET /api/workspace/storage': { ok: true, storage: { mode: 'cloud', state: 'unavailable' } }, 'GET /api/sidebar/assignments': { ok: true, state: 'ready', fetchedAt: '2026-11-15T00:00:00.000Z', active: [], expired: [], ungraded: [], courseErrors: [] }, 'GET /api/gitlab/config': { ok: true, baseUrl: 'https://git.tsinghua.edu.cn', configured: false, masked: '', source: 'none' }, 'GET /api/account': { ok: true, configured: false, masked: '', source: 'none' }, 'GET /api/service': { ok: true, supported: false }, 'GET /api/providers': { ok: true, providers: [], activeId: '' }, ...overrides }));
  const calls = [], denied = [], streams = [], timers = new Map(), frames = new Map(); let serial = 0, now = 0;
  const a = { w, document: w.document, saved, routes, calls,
    $: s => w.document.querySelector(s), all: s => [...w.document.querySelectorAll(s)],
    event(target, type, values = {}) { const node = typeof target === 'string' ? a.$(target) : target; assert.ok(node, 'Missing DOM target: ' + target); const event = new w.Event(type, { bubbles: true, cancelable: true }); Object.assign(event, values); node.dispatchEvent(event); return event; },
    click(target) { a.event(target, 'click'); }, input(target, value, event = 'input') { const node = typeof target === 'string' ? a.$(target) : target; node.value = value; a.event(node, event); },
    button(text, scope = w.document) { const node = [...scope.querySelectorAll('button')].find(n => n.textContent === text); assert.ok(node, 'Missing button: ' + text); return node; },
    nav(view) { a.click(`.tab[data-view="${view}"]`); }, count(route) { return calls.filter(c => c.method + ' ' + c.url.pathname === route).length; },
    frame() { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(now); },
    async tick(ms) { now += ms; for (const [n, item] of [...timers]) if (item.at <= now) { timers.delete(n); item.fn(); } await flush(); a.frame(); },
    async send(text) { a.input('#composer', text); a.click('#chat-send'); await flush(); },
    stream() { let controller, closed = false; const body = new ReadableStream({ start(c) { controller = c; } }); const stream = { response: new Response(body), raw(text) { controller.enqueue(new TextEncoder().encode(text)); }, emit(event, payload) { this.raw(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); }, close() { if (!closed) { closed = true; controller.close(); } } }; streams.push(stream); return stream; },
  };
  const replacements = { window: w, document: w.document, location: w.location, history: { replaceState: (_, __, url) => { w.location.href = new URL(url, w.location.href).href; } }, navigator: { platform: '', clipboard: { writeText: async () => {} } }, localStorage, innerWidth: width, getComputedStyle: () => ({ paddingLeft: '24', paddingRight: '24' }), confirm: () => true,
    setTimeout: (fn, delay = 0) => { const n = ++serial; timers.set(n, { fn, at: now + delay }); return n; }, clearTimeout: n => timers.delete(n), requestAnimationFrame: fn => { const n = ++serial; frames.set(n, fn); return n; }, cancelAnimationFrame: n => frames.delete(n),
    fetch: async (url, options = {}) => { const parsed = new URL(url, origin), method = options.method || 'GET', routeKey = method + ' ' + parsed.pathname + parsed.search; if (parsed.origin !== origin || !routes.has(routeKey)) { denied.push(routeKey); throw new Error('Unexpected fixture fetch ' + routeKey); } const call = { url: parsed, method, options, body: options.body ? JSON.parse(options.body) : undefined }; calls.push(call); const handler = routes.get(routeKey); const result = typeof handler === 'function' ? await handler(call) : handler; return result instanceof Response ? result : Response.json(result); },
  };
  const previous = new Map(); for (const [k, v] of Object.entries(replacements)) { previous.set(k, Object.getOwnPropertyDescriptor(globalThis, k)); Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v }); }
  t.after(async () => { for (const stream of streams) stream.close(); w.dispatchEvent(new w.Event('pagehide')); await flush(); for (const [k, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, k, descriptor); else delete globalThis[k]; } assert.deepEqual(denied, [], 'Network must stay within explicitly planned fixture routes'); });
  t.mock.method(Date, 'now', () => Date.parse('2026-11-14T12:00:00Z') + now);
  await import(new URL('../webui/app.js?unit2=' + ++imports, import.meta.url)); await flush();
  return a;
}

for (const [status, code, paired] of [[401, undefined, true], [403, 'AUTH_REQUIRED', true], [403, undefined, false]]) test(`unit2: HTTP ${status}/${code || 'fallback'} keeps honest connection state`, async t => {
  const a = await boot(t, { routes: { 'GET /api/meta': Response.json({ error: code ? { code } : {} }, { status }) } });
  if (paired) { assert.equal(a.$('#pair').hidden, false); assert.match(a.$('#pair-error').textContent, /重新配对/); assert.equal(JSON.parse(a.saved.get(key)).token, ''); }
  else { assert.equal(a.$('#account').textContent, '服务连接失败'); assert.match(a.$('#toast').textContent, /HTTP 403/); assert.equal(JSON.parse(a.saved.get(key)).token, token); }
  assert.equal(a.count('GET /api/workspace/storage'), 0);
});

test('unit2: malformed deep-link parameters are stripped without redeeming or credential forwarding', async t => {
  const a = await boot(t, { paired: false, href: origin + '/?base=javascript%3Aalert(1)&code=12xx56&token=bad%20token#junk=1' });
  assert.equal(a.w.location.search, ''); assert.equal(a.w.location.hash, ''); assert.equal(a.$('#pair-code').value, '');
  await a.tick(1000); assert.equal(a.calls.length, 0); assert.equal(a.saved.has(key), false);
  a.event('#pair-code', 'keydown', { key: 'x' }); assert.equal(a.calls.length, 0);
});

test('unit2: blocked storage remains usable and dark theme does not fail boot', async t => {
  const a = await boot(t, { paired: false, storageError: true, theme: 'dark' });
  assert.equal(a.$('#pair').hidden, false); assert.equal(a.document.documentElement.dataset.theme, 'dark');
  a.click('#theme-light'); assert.equal(a.document.documentElement.dataset.theme, 'light'); assert.equal(a.calls.length, 0);
});

test('unit2: pairing transport error/fallback device name and non-string issued token are validated', async t => {
  const a = await boot(t, { paired: false, routes: { 'POST /api/pair/redeem': () => { throw new Error('fixture network offline'); } } });
  a.input('#pair-code', '123456'); a.click('#pair-submit'); await flush(); assert.match(a.$('#pair-error').textContent, /fixture network offline/); assert.equal(a.$('#pair-submit').disabled, false);
  assert.equal(a.calls[0].body.deviceName, '浏览器');
  a.routes.set('POST /api/pair/redeem', { ok: true }); a.click('#pair-submit'); await flush(); assert.match(a.$('#pair-error').textContent, /不合法/); assert.equal(a.saved.has(key), false);
});

test('unit2: non-array model catalog and concurrent refresh clicks are recoverable', async t => {
  const pending = deferred();
  const a = await boot(t, { routes: { 'GET /api/meta': { ok: true, models: {}, model: {} }, 'GET /api/models?refresh=1': () => pending.promise } });
  assert.equal(a.$('#chat-send').disabled, true); assert.equal(a.$('#chat-model option').textContent, '暂无可用模型'); assert.equal(a.$('#chat-model option').disabled, true);
  const button = a.$('[aria-label="刷新模型"]'); a.click(button); a.click(button); assert.equal(a.count('GET /api/models'), 1);
  pending.resolve(new Response('not JSON', { status: 200 })); await flush(); assert.match(a.$('.model-status').textContent, /非 JSON/); assert.equal(button.disabled, false);
  a.routes.set('GET /api/models?refresh=1', { ok: true, models: [null, {}, ...models] }); a.click(button); await flush();
  assert.equal(a.$('#chat-send').disabled, false); assert.equal(a.all('#chat-model option').length, 1);
  a.input('#composer', '   '); a.click('#chat-send'); assert.equal(a.count('POST /api/chat'), 0);
});

test('unit2: duplicate send click consumes a draft once and pre-ready stop aborts the actual request', async t => {
  const pending = deferred(); let requestSignal;
  const a = await boot(t, { routes: { 'POST /api/chat': call => { requestSignal = call.options.signal; requestSignal.addEventListener('abort', () => pending.reject(new DOMException('fixture abort', 'AbortError')), { once: true }); return pending.promise; } } });
  a.input('#composer', '只发一次'); a.click('#chat-send'); a.click('#chat-send'); await flush();
  assert.equal(a.count('POST /api/chat'), 1); assert.deepEqual(a.calls.find(c => c.method === 'POST').body, { text: '只发一次', model: 'unit2-model' });
  a.click('#chat-stop'); await flush(); assert.equal(requestSignal.aborted, true); assert.equal(a.$('#chat-stop').hidden, true); assert.equal(a.$('.bubble.err'), undefined);
  assert.match(a.$('#messages').textContent, /只发一次/); assert.equal(a.count(`POST /api/chat/${id}/abort`), 0);
});

for (const [label, response, expected] of [
  ['non-JSON HTTP', () => new Response('gateway HTML', { status: 503 }), /对话失败（HTTP 503）/],
  ['empty body', () => new Response(null, { status: 200 }), /对话失败（HTTP 200）/],
]) test(`unit2: ${label} chat response exposes fallback failure`, async t => {
  const a = await boot(t, { routes: { 'POST /api/chat': response() } }); await a.send('保留问题');
  assert.match(a.$('.bubble.err').textContent, expected); assert.match(a.$('#messages').textContent, /保留问题/); assert.equal(a.$('#chat-stop').hidden, true);
});

test('unit2: SSE malformed frames and reverse reasoning order preserve DOM order and ignore unknown events', async t => {
  const a = await boot(t); const s = a.stream(); a.routes.set('POST /api/chat', s.response); await a.send('乱序检查');
  s.raw('event: token\ndata: {bad\n\nevent: token\ndata: []\n\n: heartbeat\n\n');
  s.emit('ready', { sessionId: id }); s.emit('unknown', { message: '不应出现' }); s.emit('token', { text: '先到正文' }); s.emit('reasoning', { text: 1 }); s.emit('reasoning', { text: '后到思考' }); s.emit('reasoning', { text: '追加' });
  await flush(); a.frame();
  assert.match(a.$('#messages').textContent, /后到思考追加.*先到正文/); assert.equal(a.$('.reasoning-block').nextElementSibling.classList.contains('assistant'), true);
  const reasoning = a.$('.reasoning-block'); reasoning.open = true; a.event(reasoning, 'toggle');
  const scroller = reasoning.querySelector('.reasoning-content'); scroller.scrollTop = 0; a.event(scroller, 'scroll'); assert.equal(scroller.dataset.followTail, 'false');
  s.emit('message', { role: 'assistant', interrupted: true, reasoning: '最终思考', content: '最终正文' }); s.emit('done', {}); s.close(); await flush();
  assert.equal(reasoning.dataset.state, 'error'); assert.equal(reasoning.open, true); assert.match(a.$('#messages').textContent, /最终思考.*最终正文/); assert.doesNotMatch(a.$('#messages').textContent, /不应出现|bad/);
});

test('unit2: SSE notice/error defaults, aborted message and late tool receipts keep individual states', async t => {
  const a = await boot(t); const s = a.stream(); a.routes.set('POST /api/chat', s.response); await a.send('状态顺序'); await a.send('待发');
  s.emit('ready', { sessionId: id }); s.emit('notice', { message: '先提示' }); s.emit('tool', { phase: 'start', args: null });
  s.emit('tool', { phase: 'end', ok: false }); s.emit('reasoning', { text: '公开思考' }); s.emit('message', { role: 'assistant', aborted: true }); s.emit('error', {}); s.emit('done', { aborted: true }); s.close(); await flush();
  assert.equal(a.$('.tool-card').dataset.state, 'failed'); assert.match(a.$('.tool-card').textContent, /工具.*失败/);
  assert.equal(a.$('.reasoning-block').dataset.state, 'stopped'); assert.equal(a.$('.bubble.notice').textContent, '先提示'); assert.equal(a.$('.bubble.err').textContent, '本轮失败。');
  assert.match(a.$('.queue-reason').textContent, /停止/); assert.equal(a.count('POST /api/chat'), 1);
});

test('unit2: confirm without tool name, failed decision, and denied receipt are visible in sequence', async t => {
  const a = await boot(t, { routes: { [`POST /api/chat/${id}/confirm`]: new Response('bad JSON', { status: 500 }) } }); const s = a.stream(); a.routes.set('POST /api/chat', s.response); await a.send('审批错误');
  s.emit('ready', { sessionId: id }); s.emit('confirm', { callId: 'unit2-confirm', args: '{"x":1}', risk: '  ' }); await flush();
  let card = a.$('.confirm-card'); assert.match(card.textContent, /工具.*此操作会改动校园数据/s); const payload = card.querySelector('.confirm-details'); payload.open = true; a.event(payload, 'toggle');
  a.click(a.button('拒绝', card)); await flush(); assert.equal(card.open, true); assert.match(card.querySelector('[role="alert"]').textContent, /非 JSON/);
  a.routes.set(`POST /api/chat/${id}/confirm`, { ok: true, decided: true }); a.click(a.button('拒绝', card)); await flush(); assert.equal(card.dataset.state, 'denied'); assert.equal(card.open, false); assert.equal(payload.open, false);
  assert.deepEqual(a.calls.filter(c => c.url.pathname.endsWith('/confirm')).at(-1).body, { callId: 'unit2-confirm', allow: false });
  s.emit('done', { sessionId: id }); s.close(); await flush();
});

test('unit2: empty/overlong rename failures retain editor and failed delete retains active conversation', async t => {
  const sessions = [{ id, title: '', updatedAt: '2026-11-14T12:00:00Z', messageCount: 1 }];
  const a = await boot(t, { routes: { 'GET /api/sessions': { ok: true, sessions }, [`GET /api/sessions/${id}`]: { ok: true, session: { id, messages: [] } }, [`PATCH /api/sessions/${id}`]: c => ({ ok: false, error: { message: c.body.title ? '标题过长' : '标题不能为空' } }), [`DELETE /api/sessions/${id}`]: { ok: false, error: { message: 'fixture delete denied' } } } });
  a.nav('sessions'); await flush(); assert.match(a.$('.session-row').textContent, /未命名对话/); a.click(a.button('重命名')); a.input('[aria-label="会话标题"]', ''); a.click(a.button('保存')); await flush(); assert.match(a.$('#toast').textContent, /不能为空/); assert.ok(a.$('[aria-label="会话标题"]'));
  a.input('[aria-label="会话标题"]', '长'.repeat(81)); a.click(a.button('保存')); await flush(); assert.equal(a.calls.filter(c => c.method === 'PATCH').at(-1).body.title.length, 81); assert.match(a.$('#toast').textContent, /过长/);
  a.click(a.button('取消')); a.click(a.button('删除')); await flush(); assert.match(a.$('#toast').textContent, /delete denied/); assert.ok(a.$('.session-row'));
});

test('unit2: session fallback blocks handle absent fields, orphan tools and stale open after navigation', async t => {
  const pending = deferred(); const sessions = [{ id, title: '空记录', updatedAt: '2026-11-14T12:00:00Z', messageCount: 0 }];
  const a = await boot(t, { routes: { 'GET /api/sessions': { ok: true, sessions }, [`GET /api/sessions/${id}`]: () => pending.promise, 'GET /api/tools': { ok: true } } });
  a.click('.recent-session'); a.nav('tools'); pending.resolve({ ok: true, session: { id, messages: [{ role: 'assistant', content: '不可覆盖工具页' }] } }); await flush();
  assert.equal(a.$('#view').dataset.view, 'tools'); assert.match(a.$('.list').textContent, /没有匹配/);
  a.routes.set(`GET /api/sessions/${id}`, { ok: true, session: { id, messages: [{ role: 'tool', content: '{}' }, { role: 'user' }, { role: 'assistant', toolCalls: [{}, { name: 'empty_tool' }] }, { role: 'tool' }, { role: 'ignored' }] } });
  a.click('.recent-session'); await flush(); assert.equal(a.all('.tool-card').length, 2); assert.match(a.$('.tool-card').textContent, /工具/); assert.match(a.all('.tool-card')[1].textContent, /\{\}/); assert.equal(a.$('.bubble.user').textContent, '');
});

test('unit2: artifact non-JSON failure and thrown transport retain retry link', async t => {
  const artifact = `/api/workspaces/${id}/files?path=unit2.txt`;
  const a = await boot(t, { routes: { 'GET /api/sessions': { ok: true, sessions: [{ id, title: '下载', updatedAt: '2026-11-14', messageCount: 1 }] }, [`GET /api/sessions/${id}`]: { ok: true, session: { id, messages: [{ role: 'assistant', content: `[产物](${artifact})` }] } }, ['GET ' + artifact]: new Response('not JSON', { status: 502 }) } });
  a.click('.recent-session'); await flush(); const link = a.$('.artifact-link'); a.click(link); await flush(); assert.match(a.$('.download-error').textContent, /HTTP 502.*重试/); assert.equal(link.hasAttribute('aria-busy'), false);
  a.routes.set('GET ' + artifact, () => { throw new Error('fixture download disconnected'); }); a.click(link); await flush(); assert.equal(a.all('.download-error').length, 1); assert.match(a.$('.download-error').textContent, /disconnected/); assert.equal(link.hasAttribute('aria-busy'), false);
});

test('unit2: width boundaries, no-op keys and ignored pointer IDs never clobber drafts', async t => {
  const a = await boot(t, { width: 900 }); const handle = a.$('.chat-resize-handle[data-edge="left"]'); a.input('#composer', '保留草稿');
  const max = handle.getAttribute('aria-valuemax'); assert.ok(!a.$('#chat-width-picker'));
  a.event(handle, 'keydown', { key: 'End' }); assert.equal(a.saved.get('campus.app.chatWidth'), max);
  a.event(handle, 'keydown', { key: 'F2' }); assert.equal(a.saved.get('campus.app.chatWidth'), max);
  a.event(handle, 'keydown', { key: 'Enter' }); assert.equal(a.saved.has('campus.app.chatWidth'), false);
  a.event(handle, 'pointerdown', { button: 1, pointerId: 1, clientX: 20 }); assert.equal(a.document.body.classList.contains('chat-resizing'), false);
  a.event(handle, 'pointerdown', { button: 0, pointerId: 2, clientX: 20 }); a.event(a.document, 'pointermove', { pointerId: 3, clientX: 100 }); a.event(a.document, 'pointermove', { pointerId: 2, clientX: 21 }); a.event(handle, 'keydown', { key: 'Home' }); a.event(a.document, 'pointerup', { pointerId: 3 }); assert.equal(a.document.body.classList.contains('chat-resizing'), true);
  a.event(handle, 'lostpointercapture'); assert.equal(a.saved.has('campus.app.chatWidth'), false);
  globalThis.innerWidth = 899; a.event(a.w, 'resize'); assert.equal(handle.hidden, true); a.event(handle, 'pointerdown', { button: 0, pointerId: 4, clientX: 20 }); assert.equal(a.document.body.classList.contains('chat-resizing'), false);
  globalThis.innerWidth = 900; Object.defineProperty(a.$('#view'), 'clientWidth', { configurable: true, value: 400 }); a.event(a.w, 'resize'); assert.equal(handle.hidden, true); assert.equal(a.$('#composer').value, '保留草稿');
});

test('unit2: tool missing schema, omitted optional values, catalog cache and response fallback', async t => {
  const tools = [{ name: 'fixture_minimal' }, { name: 'fixture_optional', inputSchema: { properties: { count: { type: 'number' }, text: { type: 'string' }, yes: { type: 'boolean' } } } }];
  const a = await boot(t, { routes: { 'GET /api/tools': { ok: true, tools }, 'POST /api/tools/fixture_minimal': { ok: true }, 'POST /api/tools/fixture_optional': new Response('', { status: 504 }) } });
  a.nav('tools'); await flush(); const cards = a.all('.list > details'); assert.match(cards[0].textContent, /写入.*无描述/); a.event(cards[0].querySelector('form'), 'submit'); await flush(); assert.match(cards[0].querySelector('pre').textContent, /"ok": true/);
  a.event(cards[1].querySelector('form'), 'submit'); await flush(); assert.deepEqual(a.calls.filter(c => c.method === 'POST').at(-1).body, { yes: false }); assert.match(cards[1].querySelector('pre').textContent, /BAD_RESPONSE.*非 JSON/);
  a.nav('chat'); a.nav('tools'); assert.equal(a.count('GET /api/tools'), 1);
});

test('unit2: service errors, startup-folder diagnostics and invalid invite produce no unsafe links', async t => {
  const a = await boot(t, { routes: { 'GET /api/keepalive': new Response('', { status: 503 }), 'GET /api/service': { ok: true, supported: true, mode: 'startup-folder', installed: false, startup: { installed: false, entryPath: 'fixture-only' } }, 'POST /api/pair/invite': { ok: true, code: null } } });
  a.nav('services'); await flush(); const keepaliveCard = a.all('.card').find(card => /自检/.test(card.textContent)); assert.match(keepaliveCard.textContent, /非 JSON/);
  a.nav('settings'); await flush(); assert.match(a.$('.settings-page').textContent, /启动文件夹.*未安装.*未创建/); a.click(a.button('生成配对码')); await flush(); assert.equal(a.all('.pair-links input').length, 0);
  a.routes.set('POST /api/pair/invite', { ok: true, code: '123456' }); a.click(a.button('生成配对码')); await flush(); assert.equal(a.all('.pair-links input').length, 2); assert.equal(a.$('.pair-links input').value, origin + '/#code=123456');
});
