export class RainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "RainError";
  }
}
export function publicError(e: unknown) {
  const system = e as NodeJS.ErrnoException | undefined;
  const systemCode = [
    "EACCES",
    "EPERM",
    "EBUSY",
    "ENOENT",
    "ENOSPC",
    "EIO",
    "EEXIST",
    "EMFILE",
    "ENFILE",
    "ENOTDIR",
    "EISDIR",
    "ELOOP",
    "ECONNRESET",
    "ETIMEDOUT",
  ].includes(system?.code || "")
    ? system?.code
    : undefined;
  const syscall = [
    "rename",
    "unlink",
    "rmdir",
    "mkdir",
    "open",
    "write",
    "read",
    "stat",
    "lstat",
    "connect",
  ].includes(system?.syscall || "")
    ? system?.syscall
    : undefined;
  return e instanceof RainError
    ? { code: e.code, message: e.message }
    : {
        code: "OPERATION_FAILED",
        message:
          "操作失败；请检查网络、会话与本地路径。诊断不包含凭据或原始响应。",
        systemCode,
        syscall,
      };
}

export interface SessionContext {
  identity: string;
  checkAuth(): Promise<void>;
}
export interface Lesson {
  id: string;
  classroomId: string;
  title: string;
  presentationId?: string;
  status: "active" | "ended" | "unknown";
  startedAt?: number;
}
export interface Question {
  id: string;
  lessonId: string;
  presentationId: string;
  slideId: string;
  type: "single" | "multiple" | "poll" | "blank" | "subjective" | "unknown";
  prompt: string;
  options: { key: string; text: string }[];
  published: boolean;
  answered: boolean;
  answer?: unknown;
  startAt?: number;
  publicationTimeSource?: "server" | "observed";
  endAt?: number;
  imageUrl?: string;
}
export interface Resource {
  id: string;
  lessonId: string;
  kind: "slide" | "video" | "file";
  title: string;
  url: string;
  presentationId?: string;
  index: number;
  size?: number;
}
export interface LessonData {
  account: string;
  lessonId: string;
  lessonToken?: string;
  lessonBearerToken?: string;
  expiresAt?: number | null;
  presentationId?: string;
  publishedSlides?: Record<string, string[]>;
  questions: Question[];
  resources: Resource[];
  published: string[];
  joinedAt?: string;
  finished?: boolean;
  locallyLeft?: boolean;
  timings?: Record<string, { startAt?: number; endAt?: number; publicationTimeSource?: "server" | "observed" }>;
}
