package cn.edu.tsinghua.campusapp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * HostPolicy 的 hermetic 单测：纯 JVM，只用 java.net.URI 解析字符串，
 * 不触碰 Android、不联网、不做 DNS 解析，任何机器上可重复。
 */
class HostPolicyTest {

    private val lan = "http://192.168.1.23:8971"
    private val blocked = HostPolicy.BaseProblem.CLEARTEXT_NOT_PRIVATE

    // ---------- checkBase：scheme ----------

    @Test
    fun httpsAllowsAnyHost() {
        assertNull(HostPolicy.checkBase("https://campus.example.edu:8443"))
        assertNull(HostPolicy.checkBase("https://example.com"))
        assertNull(HostPolicy.checkBase("HTTPS://EXAMPLE.COM"))
    }

    @Test
    fun httpToPublicHostIsRejected() {
        assertEquals(blocked, HostPolicy.checkBase("http://example.com"))
        assertEquals(blocked, HostPolicy.checkBase("http://8.8.8.8"))
        assertEquals(blocked, HostPolicy.checkBase("http://1.1.1.1:8971"))
    }

    @Test
    fun nonHttpSchemesAreMalformed() {
        assertEquals(HostPolicy.BaseProblem.MALFORMED, HostPolicy.checkBase("ftp://192.168.1.23"))
        assertEquals(HostPolicy.BaseProblem.MALFORMED, HostPolicy.checkBase("file:///etc/passwd"))
        assertEquals(HostPolicy.BaseProblem.MALFORMED, HostPolicy.checkBase("javascript:alert(1)"))
        assertEquals(HostPolicy.BaseProblem.MALFORMED, HostPolicy.checkBase("ws://192.168.1.23:8971"))
    }

    @Test
    fun emptyOrSchemelessIsMalformed() {
        assertEquals(HostPolicy.BaseProblem.MALFORMED, HostPolicy.checkBase(""))
        assertEquals(HostPolicy.BaseProblem.MALFORMED, HostPolicy.checkBase("   "))
        assertEquals(HostPolicy.BaseProblem.MALFORMED, HostPolicy.checkBase("192.168.1.23:8971"))
    }

    // ---------- checkBase：内网地址 ----------

    @Test
    fun loopbackIsAllowedOverCleartext() {
        assertNull(HostPolicy.checkBase("http://127.0.0.1:8971"))
        assertNull(HostPolicy.checkBase("http://127.8.9.10:8971"))
        assertNull(HostPolicy.checkBase("http://localhost:8971"))
        assertNull(HostPolicy.checkBase("http://LOCALHOST:8971"))
    }

    @Test
    fun ipv6LoopbackIsAllowed() {
        assertNull(HostPolicy.checkBase("http://[::1]:8971"))
    }

    @Test
    fun rfc1918IsAllowed() {
        assertNull(HostPolicy.checkBase(lan))
        assertNull(HostPolicy.checkBase("http://10.0.0.5:8971"))
        assertNull(HostPolicy.checkBase("http://172.16.0.1:8971"))
        assertNull(HostPolicy.checkBase("http://172.31.255.254:8971"))
    }

    @Test
    fun rfc1918NeighbouringRangesAreRejected() {
        assertEquals(blocked, HostPolicy.checkBase("http://172.15.255.255:8971"))
        assertEquals(blocked, HostPolicy.checkBase("http://172.32.0.1:8971"))
        assertEquals(blocked, HostPolicy.checkBase("http://192.169.1.1:8971"))
        assertEquals(blocked, HostPolicy.checkBase("http://11.0.0.1:8971"))
    }

    @Test
    fun linkLocalIsAllowed() {
        assertNull(HostPolicy.checkBase("http://169.254.1.1:8971"))
    }

    @Test
    fun tailscaleCgnatIsAllowed() {
        assertNull(HostPolicy.checkBase("http://100.64.0.1:8971"))
        assertNull(HostPolicy.checkBase("http://100.101.102.103:8971"))
        assertNull(HostPolicy.checkBase("http://100.127.255.255:8971"))
    }

    @Test
    fun cgnatNeighbourIsRejected() {
        assertEquals(blocked, HostPolicy.checkBase("http://100.63.255.255:8971"))
        assertEquals(blocked, HostPolicy.checkBase("http://100.128.0.1:8971"))
    }

    @Test
    fun tailscaleMagicDnsAndMdnsAreAllowed() {
        assertNull(HostPolicy.checkBase("http://desktop-abc.tail1234.ts.net:8971"))
        assertNull(HostPolicy.checkBase("http://mypc.local:8971"))
        assertNull(HostPolicy.checkBase("http://mypc:8971"))
    }

    // ---------- checkBase：混淆与畸形 ----------

    @Test
    fun userinfoInBaseIsRejected() {
        assertEquals(HostPolicy.BaseProblem.MALFORMED, HostPolicy.checkBase("http://user:pass@192.168.1.23:8971"))
        // 看起来像内网、实际 host 是公网域名
        assertEquals(HostPolicy.BaseProblem.MALFORMED, HostPolicy.checkBase("http://192.168.1.23@evil.com:8971"))
    }

    @Test
    fun hexIpLiteralIsRejected() {
        // java.net.URI 对 "0x7f.0.0.1" 只给出 registry-based authority（host=null），走 MALFORMED。
        assertEquals(HostPolicy.BaseProblem.MALFORMED, HostPolicy.checkBase("http://0x7f.0.0.1:8971"))
        // "0x7f000001" 会被解析成单标签 host，必须靠 isPrivateHost 的数值写法拦截。
        assertEquals(blocked, HostPolicy.checkBase("http://0x7f000001:8971"))
        assertEquals(blocked, HostPolicy.checkBase("http://2130706433:8971"))
    }

    @Test
    fun numericSingleLabelHostIsNotTreatedAsLan() {
        // 旧式 IPv4 写法等价 127.0.0.1，属于「混淆 host」，不允许当作本地主机。
        assertFalse(HostPolicy.isPrivateHost("2130706433"))
        assertFalse(HostPolicy.isPrivateHost("0x7f000001"))
        // 真正的单标签名字（NetBIOS/mDNS）仍按本地链路处理。
        assertTrue(HostPolicy.isPrivateHost("mypc"))
        assertTrue(HostPolicy.isPrivateHost("desktop-01"))
    }

    @Test
    fun trailingDotFqdnIsRejected() {
        assertEquals(blocked, HostPolicy.checkBase("http://evil.com.:8971"))
    }

    @Test
    fun invalidPortIsMalformed() {
        assertEquals(HostPolicy.BaseProblem.MALFORMED, HostPolicy.checkBase("http://192.168.1.23:99999"))
        assertEquals(HostPolicy.BaseProblem.MALFORMED, HostPolicy.checkBase("http://192.168.1.23:0"))
    }

    @Test
    fun normalizeStripsWhitespaceAndTrailingSlash() {
        assertEquals("http://192.168.1.23:8971", HostPolicy.normalize("  http://192.168.1.23:8971/  "))
    }

    // ---------- requestAllowed：WebView 边界 ----------

    @Test
    fun sameOriginRequestsAreAllowed() {
        assertTrue(HostPolicy.requestAllowed(lan, "http://192.168.1.23:8971/app.js"))
        assertTrue(HostPolicy.requestAllowed(lan, "http://192.168.1.23:8971/api/chat"))
        assertTrue(HostPolicy.requestAllowed("$lan/", "http://192.168.1.23:8971/"))
    }

    @Test
    fun differentHostPortOrSchemeIsRejected() {
        assertFalse(HostPolicy.requestAllowed(lan, "http://192.168.1.24:8971/app.js"))
        assertFalse(HostPolicy.requestAllowed(lan, "http://192.168.1.23:8972/app.js"))
        assertFalse(HostPolicy.requestAllowed(lan, "https://192.168.1.23:8971/app.js"))
        assertFalse(HostPolicy.requestAllowed(lan, "http://example.com/app.js"))
    }

    @Test
    fun defaultPortIsNormalised() {
        assertTrue(HostPolicy.requestAllowed("http://192.168.1.23", "http://192.168.1.23:80/app.js"))
        assertTrue(HostPolicy.requestAllowed("https://campus.example.edu", "https://campus.example.edu:443/a.js"))
    }

    @Test
    fun inlineSchemesAreAllowed() {
        assertTrue(HostPolicy.requestAllowed(lan, "data:text/plain,hi"))
        assertTrue(HostPolicy.requestAllowed(lan, "blob:http://192.168.1.23:8971/abc"))
        assertTrue(HostPolicy.requestAllowed(lan, "about:blank"))
        assertTrue(HostPolicy.requestAllowed(lan, "javascript:void(0)"))
    }

    @Test
    fun fileAndContentSchemesAreRejected() {
        assertFalse(HostPolicy.requestAllowed(lan, "file:///etc/passwd"))
        assertFalse(HostPolicy.requestAllowed(lan, "content://com.example/x"))
    }

    @Test
    fun relativeAndEmptyTargetsAreRejected() {
        assertFalse(HostPolicy.requestAllowed(lan, "app.js"))
        assertFalse(HostPolicy.requestAllowed(lan, ""))
    }

    @Test
    fun userinfoInTargetIsRejected() {
        assertFalse(HostPolicy.requestAllowed(lan, "http://192.168.1.23:8971@evil.com/x"))
        assertFalse(HostPolicy.requestAllowed(lan, "http://user:pass@192.168.1.23:8971/x"))
    }

    @Test
    fun invalidTargetPortIsRejected() {
        assertFalse(HostPolicy.requestAllowed(lan, "http://192.168.1.23:99999/x"))
    }

    @Test
    fun ipv6SameOriginIsAllowed() {
        assertTrue(HostPolicy.requestAllowed("http://[::1]:8971", "http://[::1]:8971/app.js"))
        assertFalse(HostPolicy.requestAllowed("http://[::1]:8971", "http://[::2]:8971/app.js"))
    }

    // ---------- isPrivateHost 直接覆盖 ----------

    @Test
    fun privateHostAcceptsBracketedIpv6Ula() {
        assertTrue(HostPolicy.isPrivateHost("[fd7a:115c:a1e0::1]"))
        assertTrue(HostPolicy.isPrivateHost("fc00::1"))
        assertFalse(HostPolicy.isPrivateHost("fe80::1"))
    }

    @Test
    fun privateHostRejectsPublicNames() {
        assertFalse(HostPolicy.isPrivateHost("example.com"))
        assertFalse(HostPolicy.isPrivateHost("metadata.google.internal"))
    }
}