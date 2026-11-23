// 由 scripts/build-mobile-core.mjs 从 packages/mobile-core/spec.json 生成，请勿手改。
package cn.edu.tsinghua.campusapp

object MobileCore {
    const val EXCHANGE_PATH = "/api/session/exchange"
    const val REDEEM_QUERY = "session"
    const val FALLBACK_FRAGMENT = "token"
    const val PAIRING_PATH = "/api/pair/redeem"
    const val META_PATH = "/api/meta"
    const val COPY_FALLBACK = "无法获取一次性会话码，已改用令牌片段打开；如担心暴露，请关闭窗口后重试。"
    const val COPY_PAIRING_FAILED = "配对失败，请检查电脑地址与配对码。"
    const val COPY_AUTH_REJECTED = "设备令牌已失效，请重新配对。"
    const val COPY_UNREACHABLE = "无法连接电脑上的运行时，请确认同一网络且应用正在运行。"
}
