package cn.edu.tsinghua.campusapp

import java.net.URI
import java.net.URISyntaxException

/**
 * 服务器地址与请求放行策略：只用 `java.net.URI`，不含任何 Android 依赖，
 * 因此可以用普通 JUnit 单测覆盖（见 `src/test/java/.../HostPolicyTest.kt`）。
 *
 * 为什么策略在这里而不是在 `network-security-config.xml`：
 * 运行时在局域网/Tailscale 内以明文 http 提供 WebUI，而 NSC 的 domain 只能写死域名，
 * **无法表达 192.168.0.0/16 这类网段**，所以平台层不得不整体放开 cleartext。
 * 真正把明文限制在内网/隧道内的是本类，它对「配对地址」和「WebView 的每一次请求」同时生效：
 *   1. 配对/接口调用前 —— RuntimeHub.checkBase()
 *   2. 主框架导航 —— WebViewClient.shouldOverrideUrlLoading()
 *   3. 子资源请求（XHR/fetch/img/script/SSE）—— WebViewClient.shouldInterceptRequest()
 */
object HostPolicy {

    enum class BaseProblem { MALFORMED, CLEARTEXT_NOT_PRIVATE }

    /** 不经过网络的 scheme：页面内资源与页面内跳转，放行。 */
    private val INLINE_SCHEMES = setOf("data", "blob", "about", "javascript")

    fun normalize(rawBase: String): String = rawBase.trim().trimEnd('/')

    /** 配对地址是否可用；返回 null 表示可用。 */
    fun checkBase(rawBase: String): BaseProblem? {
        val base = normalize(rawBase)
        if (base.isEmpty()) return BaseProblem.MALFORMED
        val uri = parse(base) ?: return BaseProblem.MALFORMED
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") return BaseProblem.MALFORMED
        val host = uri.host?.lowercase()
        if (host.isNullOrEmpty()) return BaseProblem.MALFORMED
        // 地址里带用户名/口令只会制造「看起来连这里、其实连那里」的歧义，直接拒绝。
        if (uri.userInfo != null) return BaseProblem.MALFORMED
        if (!isValidPort(uri.port)) return BaseProblem.MALFORMED
        if (scheme == "https") return null
        return if (isPrivateHost(host)) null else BaseProblem.CLEARTEXT_NOT_PRIVATE
    }

    /**
     * 目标 URL 是否允许在 WebView 内加载：与配对地址同源（scheme+host+有效端口）或页面内 scheme。
     * 其它一律拒绝——主框架导航交给系统浏览器，子资源请求直接返回空响应。
     */
    fun requestAllowed(rawBase: String, rawTarget: String): Boolean {
        val target = rawTarget.trim()
        if (target.isEmpty()) return false
        val targetUri = parse(target) ?: return false
        if (targetUri.userInfo != null) return false
        val targetScheme = targetUri.scheme?.lowercase() ?: return false
        if (targetScheme in INLINE_SCHEMES) return true
        if (targetScheme != "http" && targetScheme != "https") return false
        if (!isValidPort(targetUri.port)) return false

        val baseUri = parse(normalize(rawBase)) ?: return false
        val baseScheme = baseUri.scheme?.lowercase() ?: return false
        if (baseScheme != targetScheme) return false
        val baseHost = baseUri.host?.lowercase()
        val targetHost = targetUri.host?.lowercase()
        if (baseHost.isNullOrEmpty() || targetHost.isNullOrEmpty()) return false
        if (baseHost != targetHost) return false
        return effectivePort(baseUri, baseScheme) == effectivePort(targetUri, targetScheme)
    }

    /** 该主机是否属于「明文可接受」的内网/链路/隧道地址。 */
    fun isPrivateHost(rawHost: String): Boolean {
        val host = rawHost.trim('[', ']').lowercase()
        if (host.isEmpty()) return false
        if (host == "localhost" || host.endsWith(".localhost")) return true
        // Tailscale MagicDNS：*.ts.net 解析到 100.64/10，流量走隧道而不是公网。
        if (host == "ts.net" || host.endsWith(".ts.net")) return true
        // mDNS 名字只在本链路内可解析。
        if (host.endsWith(".local")) return true
        // 单标签主机名（NetBIOS/路由器下发的主机名）只能是本地链路；但纯数字与 0x 十六进制
        // 是旧式 IPv4 写法（2130706433、0x7f000001 都等于 127.0.0.1），不能借这条规则混进来。
        if (!host.contains('.') && !host.contains(':')) {
            if (host.all { it in '0'..'9' }) return false
            if (host.startsWith("0x") && host.length > 2 &&
                host.drop(2).all { it in '0'..'9' || it in 'a'..'f' }
            ) {
                return false
            }
            return true
        }

        val ipv4 = parseIpv4(host)
        if (ipv4 != null) return isPrivateIpv4(ipv4)
        return isPrivateIpv6(host)
    }

    private fun parse(raw: String): URI? = try {
        URI(raw)
    } catch (_: URISyntaxException) {
        null
    }

    private fun isValidPort(port: Int): Boolean = port == -1 || port in 1..65535

    private fun effectivePort(uri: URI, scheme: String): Int =
        if (uri.port != -1) uri.port else if (scheme == "https") 443 else 80

    private fun parseIpv4(host: String): IntArray? {
        val parts = host.split('.')
        if (parts.size != 4) return null
        val out = IntArray(4)
        for (i in 0 until 4) {
            val value = parts[i].toIntOrNull() ?: return null
            if (value !in 0..255) return null
            out[i] = value
        }
        return out
    }

    private fun isPrivateIpv4(ip: IntArray): Boolean {
        val a = ip[0]
        val b = ip[1]
        return when {
            a == 127 -> true                        // 127.0.0.0/8 环回
            a == 10 -> true                         // 10.0.0.0/8
            a == 192 && b == 168 -> true            // 192.168.0.0/16
            a == 172 && b in 16..31 -> true         // 172.16.0.0/12
            a == 169 && b == 254 -> true            // 169.254.0.0/16 链路本地
            a == 100 && b in 64..127 -> true        // 100.64.0.0/10 Tailscale CGNAT
            else -> false
        }
    }

    private fun isPrivateIpv6(host: String): Boolean {
        if (!host.contains(':')) return false
        if (host == "::1" || host == "0:0:0:0:0:0:0:1") return true
        // fc00::/7 唯一本地地址（Tailscale 的 fd7a:115c:a1e0::/48 落在其中）。
        val head = host.substringBefore(':')
        if (head.length < 2) return false
        val firstByte = head.substring(0, 2).toIntOrNull(16) ?: return false
        return (firstByte and 0xFE) == 0xFC
    }
}