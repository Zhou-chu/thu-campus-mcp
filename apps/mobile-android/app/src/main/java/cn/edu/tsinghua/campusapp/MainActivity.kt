package cn.edu.tsinghua.campusapp

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.io.BufferedReader
import java.io.ByteArrayInputStream
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * 瘦客户端：校园协议跑在电脑上的运行时里，这里只负责配对、保存令牌，
 * 然后用 WebView 加载运行时提供的同一套 WebUI。
 */
class MainActivity : Activity() {

    private lateinit var store: PairStore
    private lateinit var web: WebView
    private lateinit var pairPanel: ScrollView
    private lateinit var baseInput: EditText
    private lateinit var codeInput: EditText
    private lateinit var pairButton: Button
    private lateinit var errorText: TextView
    private val worker = Executors.newSingleThreadExecutor()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        store = PairStore(this)
        web = findViewById(R.id.web)
        pairPanel = findViewById(R.id.pairPanel)
        baseInput = findViewById(R.id.baseInput)
        codeInput = findViewById(R.id.codeInput)
        pairButton = findViewById(R.id.pairButton)
        errorText = findViewById(R.id.errorText)
        pairButton.setOnClickListener { startPair() }
        handleDeepLink(intent)
        val savedBase = store.baseUrl
        val savedToken = store.token
        if (savedBase.isNotEmpty() && savedToken.isNotEmpty()) {
            baseInput.setText(savedBase)
            // 旧版本可能存过公网 http 地址：升级后按新策略重新校验，不放行。
            if (RuntimeHub.checkBase(savedBase) == null) {
                verifyAndShow(savedBase, savedToken)
            } else {
                store.clear()
                showPair(getString(R.string.pair_cleartext_blocked))
            }
        } else {
            showPair()
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        if (intent != null) handleDeepLink(intent)
    }

    /** 支持 thucampus://pair?base=...&code=...，从桌面端二维码或链接一键带入。 */
    private fun handleDeepLink(intent: Intent?) {
        val data: Uri = intent?.data ?: return
        if (data.scheme != "thucampus" || data.host != "pair") return
        data.getQueryParameter("base")?.let { baseInput.setText(it) }
        data.getQueryParameter("code")?.let {
            codeInput.setText(it)
            if (baseInput.text.isNotEmpty()) startPair()
        }
    }

    private fun showPair(message: String? = null) {
        pairPanel.visibility = View.VISIBLE
        web.visibility = View.GONE
        errorText.visibility = if (message == null) View.GONE else View.VISIBLE
        errorText.text = message ?: ""
    }

    private fun showError(message: String) {
        errorText.visibility = View.VISIBLE
        errorText.text = message
    }

    private fun startPair() {
        val base = RuntimeHub.normalize(baseInput.text.toString())
        val code = codeInput.text.toString().trim()
        // 地址策略统一在 RuntimeHub 判定：https 放行，http 只允许内网/隧道地址。
        when (RuntimeHub.checkBase(base)) {
            HostPolicy.BaseProblem.MALFORMED -> {
                showError(getString(R.string.pair_invalid_base))
                return
            }
            HostPolicy.BaseProblem.CLEARTEXT_NOT_PRIVATE -> {
                showError(getString(R.string.pair_cleartext_blocked))
                return
            }
            null -> Unit
        }
        if (!Regex("^\\d{6}$").matches(code)) {
            showError(getString(R.string.pair_invalid_code))
            return
        }
        errorText.visibility = View.GONE
        pairButton.isEnabled = false
        pairButton.text = getString(R.string.pair_busy)
        worker.execute {
            val payload = JSONObject()
                .put("code", code)
                .put("deviceName", android.os.Build.MODEL ?: "Android")
                .put("platform", "android")
            val result = request("POST", "$base${MobileCore.PAIRING_PATH}", payload.toString(), null)
            runOnUiThread {
                pairButton.isEnabled = true
                pairButton.text = getString(R.string.pair_submit)
                if (result.first == 200) {
                    val json = runCatching { JSONObject(result.second) }.getOrNull()
                    val token = json?.optString("token").orEmpty()
                    if (token.isEmpty()) {
                        showError(getString(R.string.pair_failed, "响应缺少令牌"))
                        return@runOnUiThread
                    }
                    store.save(base, token)
                    codeInput.setText("")
                    showWeb(base, token)
                } else {
                    val json = runCatching { JSONObject(result.second) }.getOrNull()
                    val codeText = json?.optJSONObject("error")?.optString("code").orEmpty()
                    val message = when (codeText) {
                        "PAIRING_EXPIRED" -> "配对码无效或已过期，请在电脑上重新生成"
                        "PAIRING_LOCKED" -> "尝试过于频繁，请稍后再试"
                        "PAIRING_INVALID" -> "配对码格式不对"
                        "PAIRING_DISABLED" -> "这台电脑使用固定令牌，请改用带令牌的链接"
                        else -> json?.optJSONObject("error")?.optString("message")
                            ?: "HTTP ${result.first}"
                    }
                    showError(getString(R.string.pair_failed, message))
                }
            }
        }
    }

    /** 已保存令牌时先校验一次，401 就清掉令牌回到配对页。 */
    private fun verifyAndShow(base: String, token: String) {
        worker.execute {
            val result = request("GET", "$base${MobileCore.META_PATH}", null, token)
            runOnUiThread {
                when (result.first) {
                    200 -> showWeb(base, token)
                    401 -> {
                        store.clear()
                        showPair(getString(R.string.login_required))
                    }
                    else -> showPair("无法连接电脑上的运行时：HTTP ${result.first}")
                }
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun showWeb(base: String, token: String) {
        pairPanel.visibility = View.GONE
        web.visibility = View.VISIBLE
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = WebSettings.LOAD_DEFAULT
        }
        web.webViewClient = object : WebViewClient() {
            // 主框架导航：同源留在应用内，其它交给系统浏览器。
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (RuntimeHub.requestAllowed(base, request.url)) return false
                val scheme = request.url.scheme?.lowercase()
                if (scheme == "http" || scheme == "https") {
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                }
                return true
            }

            // 子资源请求（XHR / fetch / SSE / img / script）不会被 shouldOverrideUrlLoading 拦住，
            // 所以这里补同一道白名单：非配对主机的请求直接返回空响应，
            // 页面脚本无法把令牌或数据发到本机运行时之外的地址。
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? {
                if (RuntimeHub.requestAllowed(base, request.url)) return null
                return WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
            }
        }
        loadEntry(base, token)
    }

    /**
     * 优先调用 /api/session/exchange 换取一次性会话码，令牌只出现在 POST 请求体里；
     * 旧版运行时或明文远程拒绝兑换时才回退令牌片段，并明确提示。
     */
    private fun loadEntry(base: String, token: String) {
        worker.execute {
            val result = request("POST", "$base" + MobileCore.EXCHANGE_PATH, "{}", token)
            val code = if (result.first == 200) {
                runCatching { JSONObject(result.second).optString("code") }.getOrDefault("")
            } else ""
            runOnUiThread {
                if (code.isNotEmpty()) {
                    web.loadUrl("$base/?" + MobileCore.REDEEM_QUERY + "=" + Uri.encode(code))
                } else {
                    Toast.makeText(this, MobileCore.COPY_FALLBACK, Toast.LENGTH_LONG).show()
                    web.loadUrl("$base/#" + MobileCore.FALLBACK_FRAGMENT + "=" + Uri.encode(token))
                }
            }
        }
    }

    @Deprecated("Activity 未用 AndroidX OnBackPressedDispatcher")
    override fun onBackPressed() {
        if (web.visibility == View.VISIBLE && web.canGoBack()) {
            web.goBack()
            return
        }
        if (web.visibility == View.VISIBLE) {
            moveTaskToBack(true)
            return
        }
        @Suppress("DEPRECATION")
        super.onBackPressed()
    }

    override fun onDestroy() {
        web.destroy()
        worker.shutdownNow()
        super.onDestroy()
    }

    private data class Response(val status: Int, val body: String)

    private fun request(method: String, url: String, body: String?, token: String?): Pair<Int, String> {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 15000
                readTimeout = 20000
                setRequestProperty("Accept", "application/json")
                if (body != null) {
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json; charset=utf-8")
                }
                if (token != null) setRequestProperty("Authorization", "Bearer $token")
            }
            if (body != null) {
                OutputStreamWriter(connection.outputStream, Charsets.UTF_8).use { it.write(body) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.let {
                BufferedReader(InputStreamReader(it, Charsets.UTF_8)).use { reader -> reader.readText() }
            } ?: ""
            Pair(status, text)
        } catch (e: Exception) {
            Pair(0, """{"ok":false,"error":{"code":"NETWORK","message":"${e.message ?: "网络错误"}"}}""")
        } finally {
            connection?.disconnect()
        }
    }
}