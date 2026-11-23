// 由 scripts/build-mobile-core.mjs 从 packages/mobile-core/spec.json 生成，请勿手改。
export class MobileCore {
  static readonly EXCHANGE_PATH: string = '/api/session/exchange';
  static readonly REDEEM_QUERY: string = 'session';
  static readonly FALLBACK_FRAGMENT: string = 'token';
  static readonly PAIRING_PATH: string = '/api/pair/redeem';
  static readonly META_PATH: string = '/api/meta';
  static readonly COPY_FALLBACK: string = '无法获取一次性会话码，已改用令牌片段打开；如担心暴露，请关闭窗口后重试。';
  static readonly COPY_PAIRING_FAILED: string = '配对失败，请检查电脑地址与配对码。';
  static readonly COPY_AUTH_REJECTED: string = '设备令牌已失效，请重新配对。';
  static readonly COPY_UNREACHABLE: string = '无法连接电脑上的运行时，请确认同一网络且应用正在运行。';
}
