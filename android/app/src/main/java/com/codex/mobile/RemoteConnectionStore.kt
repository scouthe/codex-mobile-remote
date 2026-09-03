package com.codex.mobile

import android.content.Context
import android.net.Uri
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties

/**
 * Persists remote codexapp addresses and (optionally) their web passwords.
 *
 * The address is not secret. The password is encrypted with an AES/GCM key
 * held by the Android Keystore, so a preferences backup does not contain the
 * passwords in plaintext. Passwords are optional because Tailscale Serve
 * deployments commonly authenticate at the network layer.
 */
class RemoteConnectionStore(context: Context) {

    data class Profile(
        val id: String,
        val label: String,
        val baseUrl: String,
        val password: String?,
    )

    companion object {
        private const val PREFS = "codex_remote_connection"
        private const val PROFILES_KEY = "profiles_json"
        private const val URL_KEY = "base_url"
        private const val PASSWORD_KEY = "password_gcm"
        private const val KEY_ALIAS = "codex_remote_connection_key"
        private const val GCM_TAG_BITS = 128
        private const val MAX_PROFILES = 16
        private const val MAX_LABEL_LENGTH = 80

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

        private fun defaultLabel(url: String): String {
            return Uri.parse(url).host?.takeIf { it.isNotBlank() } ?: url
        }

        private fun normalizeLabel(label: String?, url: String): String {
            val value = label?.trim()?.take(MAX_LABEL_LENGTH).orEmpty()
            return value.ifBlank { defaultLabel(url) }
        }
    }

    private val appContext = context.applicationContext
    private val preferences = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Load all saved profiles, migrating the pre-multi-address format once. */
    fun loadProfiles(): List<Profile> {
        val encoded = preferences.getString(PROFILES_KEY, null)
        if (!encoded.isNullOrBlank()) {
            val parsed = parseProfiles(encoded)
            if (parsed.isNotEmpty()) return parsed
        }

        val legacyUrl = preferences.getString(URL_KEY, null)?.let(::normalizeUrl) ?: return emptyList()
        val legacyPassword = preferences.getString(PASSWORD_KEY, null)
            ?.let { decrypt(it) }
            ?.takeIf(String::isNotEmpty)
        val migrated = Profile(
            id = "legacy-${legacyUrl.hashCode().toUInt().toString(16)}",
            label = normalizeLabel(null, legacyUrl),
            baseUrl = legacyUrl,
            password = legacyPassword,
        )
        saveProfiles(listOf(migrated))
        return listOf(migrated)
    }

    fun load(): Profile? = loadProfiles().firstOrNull()

    /** Replace the persisted profile list. Invalid entries are rejected. */
    fun saveProfiles(profiles: List<Profile>) {
        val normalizedProfiles = profiles.asSequence()
            .mapNotNull { profile ->
                val url = normalizeUrl(profile.baseUrl) ?: return@mapNotNull null
                Profile(
                    id = profile.id.trim().ifBlank { UUID.randomUUID().toString() },
                    label = normalizeLabel(profile.label, url),
                    baseUrl = url,
                    password = profile.password?.takeIf(String::isNotBlank),
                )
            }
            .distinctBy { it.id }
            .take(MAX_PROFILES)
            .toList()

        val encoded = JSONArray().apply {
            normalizedProfiles.forEach { profile ->
                put(JSONObject().apply {
                    put("id", profile.id)
                    put("label", profile.label)
                    put("url", profile.baseUrl)
                    profile.password?.let { put("passwordGcm", encrypt(it)) }
                })
            }
        }.toString()
        preferences.edit()
            .putString(PROFILES_KEY, encoded)
            // Remove the old keys after the migrated list is safely written.
            .remove(URL_KEY)
            .remove(PASSWORD_KEY)
            .apply()
    }

    fun clear() {
        preferences.edit().clear().apply()
    }

    private fun parseProfiles(encoded: String): List<Profile> {
        return try {
            val array = JSONArray(encoded)
            buildList {
                for (index in 0 until minOf(array.length(), MAX_PROFILES)) {
                    val item = array.optJSONObject(index) ?: continue
                    val url = normalizeUrl(item.optString("url")) ?: continue
                    val id = item.optString("id").trim().ifBlank { UUID.randomUUID().toString() }
                    val label = normalizeLabel(item.optString("label"), url)
                    val password = item.optString("passwordGcm")
                        .takeIf(String::isNotBlank)
                        ?.let { decrypt(it) }
                        ?.takeIf(String::isNotEmpty)
                    add(Profile(id, label, url, password))
                }
            }.distinctBy { it.id }
        } catch (_: Exception) {
            emptyList()
        }
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
