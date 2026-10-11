package com.codex.mobile

import java.io.InterruptedIOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

internal interface EndpointProbe {
    fun run(): EndpointSelector.ProbeResult
    fun cancel()
}

internal class HttpEndpointProbe(private val profile: RemoteConnectionStore.Profile) : EndpointProbe {
    private val canceled = AtomicBoolean()
    @Volatile private var connection: HttpURLConnection? = null

    override fun run(): EndpointSelector.ProbeResult {
        val startedAt = System.nanoTime()
        var statusCode: Int? = null
        return try {
            checkCanceled()
            val request = URL("${profile.baseUrl.trimEnd('/')}/auth/status")
                .openConnection() as HttpURLConnection
            connection = request
            checkCanceled()
            request.requestMethod = "GET"
            request.connectTimeout = 1_500
            request.readTimeout = 2_500
            request.instanceFollowRedirects = false
            request.useCaches = false
            request.setRequestProperty("Accept", "application/json, text/html")
            request.setRequestProperty("X-Codex-Client-Type", "android")
            request.setRequestProperty("X-Codex-Client-Mode", "observer")
            statusCode = request.responseCode
            // 401 is an authentication challenge. A generic 403, redirect,
            // 404 or 5xx does not establish that this is a usable Codex page.
            val reachable = when (statusCode) {
                401 -> true
                200, 403 -> readRecognizedResponse(request, statusCode)
                else -> false
            }
            checkCanceled()
            EndpointSelector.ProbeResult(
                profile, reachable, (System.nanoTime() - startedAt) / 1_000_000L,
                statusCode, if (reachable) null else "Not a usable Codex response (HTTP $statusCode)",
            )
        } catch (error: Exception) {
            EndpointSelector.ProbeResult(
                profile, false, null, statusCode,
                error.message?.take(160) ?: error.javaClass.simpleName,
            )
        } finally {
            connection?.disconnect()
        }
    }

    override fun cancel() {
        canceled.set(true)
        connection?.disconnect()
    }

    private fun checkCanceled() {
        if (canceled.get() || Thread.currentThread().isInterrupted) {
            throw InterruptedIOException("Probe canceled")
        }
    }

    private fun readRecognizedResponse(request: HttpURLConnection, status: Int): Boolean {
        val stream = if (status >= 400) request.errorStream else request.inputStream
        if (stream == null) return false
        return stream.use {
            val bytes = ByteArray(MAX_RESPONSE_BYTES)
            var count = 0
            while (count < bytes.size) {
                checkCanceled()
                val read = it.read(bytes, count, minOf(1_024, bytes.size - count))
                if (read < 0) break
                count += read
                if (EndpointResponsePolicy.isUsable(status, String(bytes, 0, count, Charsets.UTF_8))) {
                    return@use true
                }
            }
            false
        }
    }

    private companion object {
        const val MAX_RESPONSE_BYTES = 16 * 1_024
    }
}

/** Recognizes the existing auth response without sending credentials or starting Codex. */
internal object EndpointResponsePolicy {
    // /auth/status has exactly these two boolean fields, in either order.
    private val authStatus = Regex(
        """\{\s*(?:"passwordProtected"\s*:\s*(?:true|false)\s*,\s*"lanOnly"\s*:\s*(?:true|false)|"lanOnly"\s*:\s*(?:true|false)\s*,\s*"passwordProtected"\s*:\s*(?:true|false))\s*}""",
    )
    private val loginForm = Regex("""<form\b[^>]*\bid=["']f["']""")
    private val passwordInput = Regex("""<input\b[^>]*\bid=["']pw["']""")
    private val setupForm = Regex("""<form\b[^>]*\bid=["']password-form["']""")

    fun isUsable(status: Int, body: String): Boolean {
        if (status == 401) return true
        if (status != 200 && status != 403) return false
        val login = body.contains("<title>Codex Web</title>") &&
            loginForm.containsMatchIn(body) && passwordInput.containsMatchIn(body) &&
            body.contains("/auth/login")
        if (login) return true
        // In particular, the LAN-only public-access denial is not a login page.
        if (status == 403) return false
        val setup = body.contains("Codex Remote") &&
            setupForm.containsMatchIn(body) && body.contains("/auth/setup")
        return setup || authStatus.matches(body.trim())
    }
}
