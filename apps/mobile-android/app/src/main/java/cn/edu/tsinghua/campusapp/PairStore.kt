package cn.edu.tsinghua.campusapp

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 设备令牌存储。
 *
 * 不用 androidx.security:security-crypto：它已停止维护，且会给这个瘦客户端
 * 增加一个不必要的依赖。这里直接用 Android Keystore 里的 AES-256-GCM 密钥
 * 加密令牌明文，SharedPreferences 只保存 IV 与密文。
 *
 * 密钥不可导出，绑定本机与当前应用；清除应用数据或换机会使令牌失效，
 * 需要重新配对，这与「令牌不随备份迁移」的安全预期一致。
 */
class PairStore(context: Context) {
    private val prefs = context.getSharedPreferences("campus-app", Context.MODE_PRIVATE)

    val baseUrl: String
        get() = prefs.getString(KEY_BASE, "") ?: ""

    var token: String
        get() {
            val payload = prefs.getString(KEY_TOKEN, "") ?: ""
            if (payload.isEmpty()) return ""
            return try {
                decrypt(payload)
            } catch (_: Exception) {
                ""
            }
        }
        private set(value) {}

    fun save(base: String, token: String) {
        prefs.edit()
            .putString(KEY_BASE, base.trimEnd('/'))
            .putString(KEY_TOKEN, encrypt(token))
            .apply()
    }

    fun clear() {
        prefs.edit().remove(KEY_BASE).remove(KEY_TOKEN).apply()
    }

    private fun secretKey(): SecretKey {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (store.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    private fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val cipherText = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        val packed = cipher.iv + cipherText
        return Base64.encodeToString(packed, Base64.NO_WRAP)
    }

    private fun decrypt(payload: String): String {
        val packed = Base64.decode(payload, Base64.NO_WRAP)
        if (packed.size <= IV_BYTES) return ""
        val iv = packed.copyOfRange(0, IV_BYTES)
        val cipherText = packed.copyOfRange(IV_BYTES, packed.size)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(TAG_BITS, iv))
        return String(cipher.doFinal(cipherText), Charsets.UTF_8)
    }

    companion object {
        private const val KEY_BASE = "baseUrl"
        private const val KEY_TOKEN = "deviceToken"
        private const val KEY_ALIAS = "campus-app-device-token"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12
        private const val TAG_BITS = 128
    }
}