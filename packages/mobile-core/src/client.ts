/** 服务状态与上游错误码：与 lib/app/states.mjs 的语义保持一致，移动端只消费不臆造。 */
export type ServiceState = "ready" | "expired" | "unknown" | "login-required" | "unavailable" | "mock";

export interface ServiceStatus {
  state: ServiceState;
  verified: boolean;
  code?: string;
  source?: string;
  checkedAt?: string;
}

export interface CampusMeta {
  version?: string;
  services?: Record<string, ServiceStatus | null>;
  model?: { route?: string; name?: string };
}

export interface TimetableCourse {
  id: string;
  name: string;
  teacher?: string;
  location?: string;
  timeAndLocation?: string;
  slots?: Array<{ day: number; from: number; to: number; location?: string }>;
}

export interface TimetablePayload {
  state: "ready" | "unavailable" | "empty";
  semester?: { id?: string; startDate?: string };
  courses: TimetableCourse[];
  error?: { code: string; message: string };
}

export interface SeatLibrary {
  id: number;
  name: string;
  valid: boolean;
}

export interface SportsSession {
  begin: string;
  end: string;
  capacity: number | null;
  reserved: number | null;
  status?: string;
  price: number | null;
  site: string;
}

export class CampusApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CampusApiError";
  }
}

export interface ClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** 移动端唯一的出网入口：只依赖公开 HTTP API，不直接调用 lib/ 内部模块。 */
export class CampusClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new CampusApiError("NETWORK_ERROR", `连不上校园助手：${(error as Error)?.message ?? "网络错误"}`);
    }
    const text = await response.text();
    const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok || payload.ok === false) {
      const error = (payload.error ?? {}) as { code?: string; message?: string };
      throw new CampusApiError(error.code ?? `HTTP_${response.status}`, error.message ?? `请求失败（HTTP ${response.status}）`, response.status);
    }
    return payload as T;
  }

  meta(): Promise<CampusMeta> {
    return this.request<CampusMeta>("/api/meta");
  }

  timetable(): Promise<TimetablePayload> {
    return this.request<TimetablePayload>("/api/timetable");
  }

  seatLibraries(): Promise<{ libraries: SeatLibrary[] }> {
    return this.request<{ libraries: SeatLibrary[] }>("/api/seat/libraries");
  }

  sportsVenues(sport: string): Promise<{ sport: string; venues: string[] }> {
    return this.request<{ sport: string; venues: string[] }>(`/api/sports/venues?sport=${encodeURIComponent(sport)}`);
  }

  sportsSlots(sport: string, venue: string, date: string): Promise<{ sessions: SportsSession[] }> {
    const query = new URLSearchParams({ sport, venue, date }).toString();
    return this.request<{ sessions: SportsSession[] }>(`/api/sports/slots?${query}`);
  }
}