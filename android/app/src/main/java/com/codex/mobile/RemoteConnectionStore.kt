package com.codex.mobile

import android.content.Context
import android.net.Uri
import android.util.Base64
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties

/**
 * Persists the remote codexapp address and (optionally) its web password.
 *
 * The address is not secret. The password is encrypted with an AES/GCM key
 * held by the Android Keystore, so a preferences backup does not contain the
 * password in plaintext. The password is optional because Tailscale Serve
 * deployments commonly authenticate at the network layer.
 */
class RemoteConnectionStore(context: Context) {

    data class Profile(
        val baseUrl: String,
        val password: String?,
    )

    companion object {
        private const val PREFS = "codex_remote_connection"
        private const val URL_KEY = "base_url"
        private const val PASSWORD_KEY = "password_gcm"
        private const val KEY_ALIAS = "codex_remote_connection_key"
        private const val GCM_TAG_BITS = 128

        /** Normalize and validate a URL before it is persisted or loaded. */
        fun normalizeUrl(raw: String): String? {
            val value = raw.trim()
            if (value.isEmpty() || value.length > 2048) return null
            if (value.any { it.isISOControl() || it.isWhitespace() }) return null
            val uri = try {
                Uri.parse(value)
            } catch (_: Exception) {
                return null
            }
            val scheme = uri.scheme?.lowercase() ?: return null
            if (scheme != "http" && scheme != "https") return null
            if (uri.host.isNullOrBlank() || uri.userInfo != null) return null
            val port = try {
                uri.port
            } catch (_: Exception) {
                return null
            }
            if (port !in -1..65535) return null
            if (uri.query != null || uri.fragment != null) return null
            return value.trimEnd('/')
        }
    }

    private val appContext = context.applicationContext
    private val preferences = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun load(): Profile? {
        val url = preferences.getString(URL_KEY, null)?.let(::normalizeUrl) ?: return null
        val encryptedPassword = preferences.getString(PASSWORD_KEY, null)
        val password = encryptedPassword?.let { decrypt(it) }
        return Profile(url, password?.takeIf(String::isNotEmpty))
    }

    fun save(baseUrl: String, password: String?) {
        val normalized = normalizeUrl(baseUrl)
            ?: throw IllegalArgumentException("Enter a valid http(s) server URL")
        val editor = preferences.edit().putString(URL_KEY, normalized)
        if (password.isNullOrBlank()) {
            editor.remove(PASSWORD_KEY)
        } else {
            editor.putString(PASSWORD_KEY, encrypt(password))
        }
        editor.apply()
    }

    fun clear() {
        preferences.edit().clear().apply()
    }

    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val encrypted = cipher.doFinal(value.toByteArray(StandardCharsets.UTF_8))
        val payload = ByteArray(cipher.iv.size + encrypted.size)
        cipher.iv.copyInto(payload, 0)
        encrypted.copyInto(payload, cipher.iv.size)
        return Base64.encodeToString(payload, Base64.NO_WRAP)
    }

    private fun decrypt(value: String): String? {
        return try {
            val payload = Base64.decode(value, Base64.NO_WRAP)
            if (payload.size <= 12) return null
            val iv = payload.copyOfRange(0, 12)
            val encrypted = payload.copyOfRange(12, payload.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                getOrCreateKey(),
                GCMParameterSpec(GCM_TAG_BITS, iv),
            )
            String(cipher.doFinal(encrypted), StandardCharsets.UTF_8)
        } catch (_: Exception) {
            // A key can be invalidated after a device restore or lock-screen
            // change. Forget the unreadable value instead of blocking startup.
            try {
                KeyStore.getInstance("AndroidKeyStore").apply {
                    load(null)
                    deleteEntry(KEY_ALIAS)
                }
            } catch (_: Exception) {
                // Best effort; the next save will surface a useful error.
            }
            preferences.edit().remove(PASSWORD_KEY).apply()
            null
        }
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = keyStore.getKey(KEY_ALIAS, null)
        if (existing is SecretKey) return existing

        val generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            "AndroidKeyStore",
        )
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

}
