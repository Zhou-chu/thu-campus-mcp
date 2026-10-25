import { launchEphemeral } from "@thu-campus/browser";
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { AuthStore } from "./auth.js";
import { RainClient } from "./client.js";
import { ORIGIN, type Config } from "./config.js";
import { RainError } from "./types.js";
import { digest, guardedPath } from "./storage.js";
export async function captureClassroom(
  client: RainClient,
  cfg: Config,
  lessonId: string,
) {
  const state = await client.state(lessonId);
  if (!state?.lessonToken || state.finished || state.locallyLeft)
    throw new RainError("JOIN_REQUIRED", "截图前需要显式进入尚未结束的课堂。");
  const auth = await new AuthStore(cfg.stateDir).load();
  if (!auth) throw new RainError("AUTH_REQUIRED", "未登录荷塘雨课堂。");
  const browser = await launchEphemeral({ headless: true });
  try {
    await client.checkAuth();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1080 },
    });
    await context.addCookies(
      auth.cookieHeader.split(";").flatMap((piece) => {
        const at = piece.indexOf("=");
        return at < 1
          ? []
          : [
              {
                name: piece.slice(0, at).trim(),
                value: piece.slice(at + 1),
                url: ORIGIN,
                secure: true,
              },
            ];
      }),
    );
    const page = await context.newPage();
    await page.goto(
      ORIGIN + "/lesson/student/v3/" + encodeURIComponent(lessonId),
      { waitUntil: "domcontentloaded", timeout: 45000 },
    );
    await page
      .waitForLoadState("networkidle", { timeout: 15000 })
      .catch(() => {});
    if (
      new URL(page.url()).origin !== ORIGIN ||
      /login|wechat/i.test(new URL(page.url()).pathname)
    )
      throw new RainError("AUTH_REQUIRED", "课堂截图转向登录页面。");
    await page.evaluate(() => document.fonts.ready);
    await client.checkAuth();
    const dir = await guardedPath(cfg.outputDir, ".课堂截图");
    await mkdir(dir, { recursive: true });
    const file = await guardedPath(
      dir,
      digest(lessonId).slice(0, 12) + "-" + Date.now() + ".png",
    );
    const bytes = await page.screenshot({ path: file, fullPage: false });
    await client.checkAuth();
    return {
      filePath: file,
      _image: { data: bytes.toString("base64"), mimeType: "image/png" },
    };
  } finally {
    await browser.close();
  }
}
