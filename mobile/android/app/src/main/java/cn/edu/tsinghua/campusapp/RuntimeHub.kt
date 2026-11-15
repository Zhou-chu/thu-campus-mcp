package cn.edu.tsinghua.campusapp

import android.net.Uri

/**
 * Android 侧适配层：把 `Uri` 换成字符串，交给纯 JVM 的 [HostPolicy] 判定。
 *
 * 判定逻辑全部在 HostPolicy（有 JUnit 单测覆盖），这里刻意保持“零逻辑”，
 * 避免出现「测试过的是 A、实际跑的是 B」。
 */
object RuntimeHub {

    fun normalize(raw: String): String = HostPolicy.normalize(raw)

    fun checkBase(rawBase: String): HostPolicy.BaseProblem? = HostPolicy.checkBase(rawBase)

    /** WebView 主框架导航与子资源请求共用同一条边界。 */
    fun requestAllowed(base: String, url: Uri): Boolean =
        HostPolicy.requestAllowed(base, url.toString())
}