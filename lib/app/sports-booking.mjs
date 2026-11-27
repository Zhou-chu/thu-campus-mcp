import { openBrowserWithRetry } from "./browser-open.mjs";

const HOME = "https://www.sports.tsinghua.edu.cn/venue/index.html#/home";

export class BookingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BookingError";
    this.code = code;
  }
}

let active = null;

const clickByText = async (page, text, { exact = true, timeout = 8000 } = {}) => {
  const locator = exact ? page.getByText(text, { exact: true }) : page.getByText(text);
  const target = locator.first();
  if ((await target.count()) === 0) return false;
  await target.click({ timeout }).catch(() => {});
  return true;
};

const visibleText = page => page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " "));

/**
 * 打开有头窗口，自动走到「场馆页面已选好时段、已点预约、已同意规则」这一步，
 * 把滑块验证与支付留给用户本人完成。窗口保持打开，直到 closeBooking()。
 */
export async function prepareBooking({ sport = "游泳", venue = "陈明游泳馆", start, end, date } = {}) {
  if (active && !active.page.isClosed()) throw new BookingError("BOOKING_SESSION_ACTIVE", "已有预约流程在进行，请先关闭当前窗口或调用关闭接口。");
  if (active) {
    // 用户已经关掉窗口：清掉陈旧状态，不能永久卡死后续预约。
    active = null;
  }
  const slotMode = Boolean(start && end);
  // 记录失败发生在哪一步：闪退时日志里能直接看出卡在开窗、导航还是点击。
  let phase = "open-browser";

  let browser;
  try {
    browser = await openBrowserWithRetry({ label: "sports:booking" });
  } catch (error) {
    const busy = error?.code === "BROWSER_BUSY";
    throw new BookingError(
      busy ? "BOOKING_WINDOW_BUSY" : "BOOKING_UNREACHABLE",
      busy ? "已经有一个预约窗口在运行，请先在窗口中完成或关闭它。" : "无法启动浏览器打开预约窗口。",
    );
  }
  try {
    phase = "new-page";
    const page = await browser.context.newPage();
    page.once("close", () => {
      if (active?.page === page) active = null;
      void browser.close().catch(() => {});
    });
    phase = "goto";
    await page.goto(HOME, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForTimeout(1500);

    // 先判断是不是被统一认证挡住：这时候说“未登录”，而不是笼统的页面异常。
    const blocked = await visibleText(page).catch(() => "");
    if (/统一身份认证登录|校内登录|校外登录|请登录/.test(blocked))
      throw new BookingError("SPORTS_LOGIN_REQUIRED", "体育系统需要先登录：请先在「服务 → 体育场馆」登录后再打开预约窗口。");

    // SPA 首屏是异步渲染的，等“场地预约”真的出现再点，避免点空导致随后闪退。
    phase = "page-ready";
    await page.waitForFunction(() => (document.body.innerText || "").includes("场地预约"), null, { timeout: 20_000 })
      .catch(() => { throw new BookingError("BOOKING_PAGE_UNEXPECTED", "体育页面没有加载出“场地预约”（可能网络慢或登录已过期）。"); });

    phase = "click-booking";
    await clickByText(page, "场地预约");
    await page.waitForTimeout(800);
    phase = "click-sport";
    await clickByText(page, sport);
    await page.waitForTimeout(800);
    phase = "click-venue";
    await clickByText(page, venue, { exact: false });
    await page.waitForTimeout(3000);

    if (!(await page.getByText("预约", { exact: true }).count()))
      throw new BookingError("BOOKING_PAGE_UNEXPECTED", "没有打开场馆预约页，可能需要先登录体育系统。");

    if (date) {
      phase = "pick-date";
      const pickedDate = await clickByText(page, date, { exact: false }).catch(() => false);
      if (!pickedDate) {
        // 把当天实际能看到的日期带回去，用户才知道是“没开放”而不是“程序坏了”。
        const pageText = await visibleText(page).catch(() => "");
        const seen = [...pageText.matchAll(/\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}/g)].slice(0, 6).map(match => match[0]).join("、");
        throw new BookingError("DATE_NOT_AVAILABLE", `预约页没有可选日期 ${date}，可能尚未开放${seen ? `（页面上可见：${seen}）` : ""}。`);
      }
    }

    let confirmed = false;
    if (slotMode) {
      phase = "pick-slot";
      const slotLabel = `${start}~${end}`;
      const picked = await clickByText(page, slotLabel, { exact: false });
      if (!picked) throw new BookingError("SLOT_NOT_FOUND", `没有找到时段 ${slotLabel}。`);
      await page.waitForTimeout(500);

      await page.getByText("预约", { exact: true }).last().click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1500);

      // 规则弹窗：确认继续
      confirmed = await clickByText(page, "确认");
      await page.waitForTimeout(2500);
    } else {
      await page.waitForTimeout(1200);
    }

    const text = await visibleText(page);
    const needsVerification = /安全验证|滑动完成验证|验证码/.test(text);
    const payment = /支付|二维码|扫码/.test(text);
    const step = !slotMode ? "select" : needsVerification ? "verification" : payment ? "payment" : "unknown";

    active = { browser, page, createdAt: new Date().toISOString(), step, sport, venue, start, end, confirmed };
    return {
      ok: true,
      step,
      needsVerification,
      confirmed,
      message: !slotMode
        ? "已打开该场馆的预约页，请自行选择时间；需要人工验证与支付时在窗口内完成。"
        : needsVerification
          ? "已在窗口里走到滑块验证这一步：请拖动滑块完成验证并支付。"
          : "已打开场馆页面，请按窗口提示继续。",
      url: page.url(),
    };
  } catch (error) {
    // 只带“哪一步”，不记录页面内容或凭据。
    if (error && typeof error === "object" && !error.phase) error.phase = phase;
    await browser.close().catch(() => {});
    throw error;
  }
}

/** 把失败压缩成可安全写日志的几个字段：只留代码/类型/步骤，不含页面内容或凭据。 */
export function bookingFailureLog(error) {
  const code = typeof error?.code === "string" && /^[A-Z][A-Z_]{0,63}$/.test(error.code) ? error.code : "UNEXPECTED";
  const name = typeof error?.name === "string" && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "Error";
  return { code, name, phase: typeof error?.phase === "string" ? error.phase : "" };
}

export function bookingStatus() {
  if (!active) return { active: false };
  if (active.page.isClosed()) {
    active = null;
    return { active: false };
  }
  return {
    active: true,
    step: active.step,
    sport: active.sport,
    venue: active.venue,
    start: active.start,
    end: active.end,
    createdAt: active.createdAt,
    url: active.page.url(),
  };
}

export async function closeBooking() {
  if (!active) return { ok: true, closed: false };
  const { browser } = active;
  active = null;
  await browser.close().catch(() => {});
  return { ok: true, closed: true };
}