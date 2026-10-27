import path from "node:path";
import { AuthStore, type AuthData } from "./auth.js";
import { ORIGIN, type Config } from "./config.js";
import {
  RainError,
  type LessonData,
  type Lesson,
  type Resource,
} from "./types.js";
import {
  identifier,
  id,
  dataOf,
  parseJson,
  activeLessons,
  questions,
  resourcesFromSummary,
} from "./protocol.js";
import { digest, withLock } from "./storage.js";
export function apiUrl(value: string) {
  const u = new URL(value, ORIGIN);
  if (
    u.origin !== ORIGIN ||
    u.protocol !== "https:" ||
    u.username ||
    u.password
  )
    throw new RainError("UNSAFE_URL", "课堂 API 只允许荷塘雨课堂同源 HTTPS。");
  return u;
}
export interface RequestGate {
  beforeSend?: () => Promise<void>;
  assertNow?: () => void;
}
export class RainClient {
  identity = "";
  private auth?: AuthData;
  private epoch?: string;
  private invalid = false;
  private queue: Promise<unknown> = Promise.resolve();
  private store: AuthStore;
  constructor(public config: Config) {
    this.store = new AuthStore(config.stateDir);
  }
  checkAuth(): Promise<void> {
    const p = this.queue
      .catch(() => {})
      .then(async () => {
        if (this.invalid)
          throw new RainError("AUTH_CHANGED", "认证已变化，当前操作停止。");
        const epoch = await this.store.generation();
        if (this.epoch && epoch !== this.epoch) {
          this.invalid = true;
          this.auth = undefined;
          this.identity = "";
          throw new RainError("AUTH_CHANGED", "认证已变化，当前操作停止。");
        }
        if (!this.auth) {
          const saved = await this.store.loadVersioned();
          if (!saved)
            throw new RainError(
              "AUTH_REQUIRED",
              "尚未登录荷塘雨课堂，请在本机运行 auth browser。",
            );
          if ((await this.store.generation()) !== epoch) {
            this.invalid = true;
            throw new RainError("AUTH_CHANGED", "登录读取期间认证变化。");
          }
          this.auth = saved.data;
          this.epoch = epoch;
          this.identity = digest(this.auth.account).slice(0, 16);
        }
      });
    this.queue = p;
    return p;
  }
  async generation() {
    await this.checkAuth();
    return this.epoch!;
  }
  async request(
    endpoint: string,
    init: RequestInit = {},
    lessonToken?: string,
    lessonBearerToken?: string,
    captureBearer?: (bearer: string | undefined) => void,
    gate?: RequestGate,
  ): Promise<any> {
    await this.checkAuth();
    const u = apiUrl(endpoint);
    const sentBearer = lessonBearerToken ?? this.auth!.bearerToken;
    const csrf = /(?:^|;\s*)csrftoken=([^;]+)/.exec(
      this.auth!.cookieHeader,
    )?.[1];
    await gate?.beforeSend?.();
    gate?.assertNow?.();
    const response = await fetch(u, {
      ...init,
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        xtbz: "ykt",
        "x-client": "h5",
        Origin: ORIGIN,
        Referer: ORIGIN + "/",
        Cookie: this.auth!.cookieHeader,
        ...(csrf ? { "x-csrftoken": csrf } : {}),
        ...(this.auth!.bearerToken
          ? { Authorization: "Bearer " + this.auth!.bearerToken }
          : {}),
        ...(lessonToken ? { "lesson-token": lessonToken } : {}),
        ...(lessonBearerToken
          ? { Authorization: "Bearer " + lessonBearerToken }
          : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    await this.checkAuth();
    if (!response.ok) {
      await response.body?.cancel();
      throw new RainError(
        response.status === 401 || response.status === 403
          ? "AUTH_REQUIRED"
          : "HTTP_ERROR",
        `课堂接口返回 HTTP ${response.status}。`,
        response.status >= 300 &&
        response.status < 400 &&
        init.method === "POST"
          ? 500
          : response.status,
      );
    }
    const text = await response.text();
    await this.checkAuth();
    let result: any;
    try {
      result = parseJson(text);
    } catch {
      throw new RainError(
        "INVALID_RESPONSE",
        "接口未返回预期 JSON，未暴露原始响应。",
        init.method === "POST" ? 500 : undefined,
      );
    }
    if (result?.code !== undefined && Number(result.code) !== 0)
      throw new RainError(
        "API_REJECTED",
        `课堂服务拒绝请求（代码 ${Number.isFinite(Number(result.code)) ? Number(result.code) : "unknown"}）。`,
        400,
      );
    const setAuth = response.headers.get("set-auth");
    if (setAuth) this.auth!.bearerToken = setAuth.replace(/^Bearer\s+/i, "");
    captureBearer?.(setAuth ? setAuth.replace(/^Bearer\s+/i, "") : sentBearer);
    return result;
  }
  async user() {
    const d = dataOf(await this.request("/api/v3/user/basic-info"));
    const u = d.userInfo ?? d.user_info ?? d;
    return {
      id: identifier(u.userId ?? u.user_id ?? u.id),
      name: String(u.name ?? u.nickname ?? ""),
    };
  }
  async active() {
    return activeLessons(await this.request("/api/v3/classroom/on-lesson"));
  }
  async courses() {
    const d = dataOf(await this.request("/v2/api/web/courses/list?identity=2"));
    if (!Array.isArray(d.list))
      throw new RainError("INVALID_RESPONSE", "无法识别课程列表。");
    return d.list.map((c: any) => ({
      id: identifier(c.classroom_id ?? c.id),
      name: String(c.name ?? c.course?.name ?? "课程"),
      role: c.role,
      term: c.term ?? c.semester ?? null,
    }));
  }
  async lessons(classroomId: string, maxPages = 25) {
    const out: Lesson[] = [];
    const seen = new Set<string>();
    let complete = false;
    for (let page = 0; page < maxPages; page++) {
      const d = dataOf(
        await this.request(
          `/v2/api/web/logs/learn/${encodeURIComponent(classroomId)}?page=${page}&offset=200&sort=0&actype=-1`,
        ),
      );
      if (!Array.isArray(d.activities))
        throw new RainError("INVALID_RESPONSE", "无法识别课堂活动。");
      const key = digest(JSON.stringify(d.activities));
      if (seen.has(key) && d.activities.length)
        throw new RainError("PAGINATION", "活动分页重复，未声称完整。");
      seen.add(key);
      for (const a of d.activities)
        if (Number(a.type) === 14 && id(a.courseware_id ?? a.lesson_id))
          out.push({
            id: identifier(a.courseware_id ?? a.lesson_id),
            classroomId,
            title: String(a.title ?? "课堂"),
            status: a.is_finished === true ? "ended" : "unknown",
          });
      if (d.activities.length < 200) {
        complete = true;
        break;
      }
    }
    return { items: out, complete };
  }
  private async lessonStore(lessonId: string) {
    await this.checkAuth();
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(lessonId))
      throw new RainError("INVALID_ID", "课堂 ID 格式无效。");
    return new AuthStore<LessonData>(
      path.join(this.config.stateDir, "lessons", digest(this.epoch!), lessonId),
    );
  }
  async state(lessonId: string) {
    const state = await (await this.lessonStore(lessonId)).load();
    await this.checkAuth();
    return state?.account === this.identity ? state : undefined;
  }
  async updateState(
    lessonId: string,
    fn: (current: LessonData | undefined) => LessonData,
  ) {
    const store = await this.lessonStore(lessonId);
    return withLock(path.join(store.directory, "mutation-lock"), async () => {
      await this.checkAuth();
      const old = await store.load();
      if (old && old.account !== this.identity)
        throw new RainError("AUTH_CHANGED", "课堂记录属于另一账号。");
      const next = fn(old);
      await store.save(next);
      await this.checkAuth();
      return next;
    });
  }
  async saveState(state: LessonData) {
    await this.updateState(state.lessonId, () => state);
  }
  async join(lessonId: string, beforeWrite?: () => Promise<void>) {
    const active = await this.active();
    const lesson = active.find((x) => x.id === lessonId);
    if (!lesson)
      throw new RainError("NOT_ACTIVE", "该课堂未在当前账号的正在上课列表中。");
    const old = await this.state(lessonId);
    if (
      old?.lessonToken &&
      (old.expiresAt === null || !old.expiresAt || old.expiresAt > Date.now())
    ) {
      await this.updateState(lessonId, (s) => ({ ...s!, locallyLeft: false }));
      return { lessonId, joined: true, alreadyJoined: true };
    }
    await beforeWrite?.();
    let checkedBearer: string | undefined;
    const d = dataOf(
      await this.request(
        "/api/v3/lesson/checkin",
        {
          method: "POST",
          body: JSON.stringify({
            source: 1,
            lessonId,
            ...(lesson.classroomId ? { classroomId: lesson.classroomId } : {}),
          }),
        },
        undefined,
        undefined,
        (bearer) => {
          checkedBearer = bearer;
        },
      ),
    );
    const token = d.lessonToken ?? d.lesson_token;
    if (typeof token !== "string" || !token)
      throw new RainError(
        "JOIN_UNKNOWN",
        "进入请求已响应，但缺少课堂会话，未重试。",
        500,
      );
    await this.saveState({
      account: this.identity,
      lessonId,
      lessonToken: token,
      lessonBearerToken: checkedBearer,
      expiresAt:
        d.expiresAt ??
        (d.expiresIn ? Date.now() + Number(d.expiresIn) * 1000 : null),
      presentationId: lesson.presentationId,
      questions: [],
      resources: [],
      published: [],
      joinedAt: new Date().toISOString(),
    });
    return { lessonId, joined: true };
  }
  async refreshQuestions(lessonId: string) {
    const s = await this.state(lessonId);
    if (!s?.lessonToken)
      throw new RainError("JOIN_REQUIRED", "请先进入当前课堂。");
    if (!s.presentationId)
      return { items: s.questions, notice: "等待课件发布事件。" };
    const r = await this.request(
      "/api/v3/lesson/presentation/fetch?presentation_id=" +
        encodeURIComponent(s.presentationId),
      {},
      s.lessonToken,
      s.lessonBearerToken,
    );
    const result = await this.updateState(lessonId, (current) => {
      const latest = current || s;
      const fresh = questions(
        r,
        lessonId,
        s.presentationId!,
        new Set(latest.published),
      );
      latest.questions = fresh.map((q) => {
        const old = latest.questions.find((x) => x.id === q.id);
        return {
          ...q,
          published: q.published || old?.published === true,
          answered: q.answered || old?.answered === true,
          answer: q.answer ?? old?.answer,
          startAt: latest.timings?.[q.id]?.startAt ?? old?.startAt ?? q.startAt,
          publicationTimeSource: latest.timings?.[q.id]?.publicationTimeSource ?? old?.publicationTimeSource ?? q.publicationTimeSource,
          endAt: [q.endAt, latest.timings?.[q.id]?.endAt, old?.endAt].some(
            (v) => v !== undefined,
          )
            ? Math.min(
                ...[q.endAt, latest.timings?.[q.id]?.endAt, old?.endAt].filter(
                  (v): v is number => v !== undefined,
                ),
              )
            : undefined,
        };
      });
      return latest;
    });
    return { items: result.questions };
  }
  async collectResources(lessonId: string) {
    await this.checkAuth();
    const live = await this.state(lessonId);
    if (
      live?.lessonToken &&
      !live.finished &&
      (await this.active()).some((x) => x.id === lessonId)
    ) {
      const ids = Object.keys(live.publishedSlides || {});
      if (!ids.length)
        throw new RainError(
          "LIVE_SNAPSHOT_REQUIRED",
          "实时课堂尚未同步已发布课件，请等待课堂连接后重试。",
        );
      const presentations: Record<string, any> = {},
        catalog = [];
      for (const pid of ids) {
        const response = await this.request(
          "/api/v3/lesson/presentation/fetch?presentation_id=" +
            encodeURIComponent(pid),
          {},
          live.lessonToken,
          live.lessonBearerToken,
        );
        const deck = dataOf(response),
          allowed = new Set(live.publishedSlides![pid]);
        if (!Array.isArray(deck.slides))
          throw new RainError("INVALID_RESPONSE", "实时课件缺少可识别的页面。");
        presentations[pid] = {
          ...deck,
          slides: deck.slides.filter((s: any) => allowed.has(identifier(s.id))),
        };
        catalog.push({ id: pid, title: String(deck.title || "课堂课件") });
      }
      const resources = resourcesFromSummary(
        lessonId,
        { presentations: catalog },
        presentations,
        {},
      );
      await this.updateState(lessonId, (s) => ({ ...s!, resources }));
      return {
        title: catalog.at(-1)!.title,
        resources,
        replayUnavailable: true,
        scope: "published-live-snapshot",
      };
    }
    const summary = dataOf(
      await this.request(
        "/api/v3/lesson-summary/student?lesson_id=" +
          encodeURIComponent(lessonId),
      ),
    );
    if (summary.errorCode !== undefined && Number(summary.errorCode) !== 0)
      throw new RainError(
        "RESOURCES_NOT_READY",
        "平台尚未生成可用的课后资源汇总。",
      );
    const presentations: Record<string, any> = {};
    for (const p of summary.presentations ?? []) {
      const pid = identifier(p.id ?? p.presentation_id);
      presentations[pid] = await this.request(
        `/api/v3/lesson-summary/student/presentation?lesson_id=${encodeURIComponent(lessonId)}&presentation_id=${encodeURIComponent(pid)}`,
      );
    }
    let replay: any = {};
    let replayUnavailable = false;
    try {
      replay = dataOf(
        await this.request(
          "/api/v3/lesson-summary/replay?lesson_id=" +
            encodeURIComponent(lessonId),
        ),
      );
    } catch (e) {
      if (e instanceof RainError && e.code === "AUTH_CHANGED") throw e;
      replayUnavailable = true;
    }
    const resources = resourcesFromSummary(
      lessonId,
      summary,
      presentations,
      replay,
    );
    await this.updateState(lessonId, (old) => ({
      ...(old || {
        account: this.identity,
        lessonId,
        questions: [],
        published: [],
      }),
      resources,
    }));
    return {
      title: String(summary.lesson?.title ?? "课堂"),
      resources,
      replayUnavailable,
    };
  }
}
