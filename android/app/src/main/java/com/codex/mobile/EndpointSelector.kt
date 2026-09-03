package com.codex.mobile

import android.os.Handler
import android.os.Looper
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * Probes saved codexapp addresses in parallel and returns the fastest one.
 *
 * A response from the server (including 401/403) is considered reachable: the
 * WebView may still need to submit the profile's saved password, but the
 * network path itself is healthy. No password is sent during probing.
 */
class EndpointSelector {

    data class ProbeResult(
        val profile: RemoteConnectionStore.Profile,
        val reachable: Boolean,
        val latencyMs: Long?,
        val statusCode: Int?,
        val error: String?,
    )

    private val mainHandler = Handler(Looper.getMainLooper())
    private val executor = Executors.newFixedThreadPool(4)
    @Volatile
    private var generation = 0

    fun select(
        profiles: List<RemoteConnectionStore.Profile>,
        onComplete: (RemoteConnectionStore.Profile?, List<ProbeResult>) -> Unit,
    ) {
        val token = ++generation
        if (profiles.isEmpty()) {
            mainHandler.post { if (token == generation) onComplete(null, emptyList()) }
            return
        }

        val results = arrayOfNulls<ProbeResult>(profiles.size)
        val remaining = AtomicInteger(profiles.size)
        profiles.forEachIndexed { index, profile ->
            executor.execute {
                val result = probe(profile)
                results[index] = result
                if (remaining.decrementAndGet() == 0) {
                    mainHandler.post {
                        if (token != generation) return@post
                        val completed = results.mapNotNull { it }
                        val selected = completed
                            .asSequence()
                            .filter { it.reachable }
                            .minWithOrNull(compareBy<ProbeResult> { it.latencyMs ?: Long.MAX_VALUE })
                            ?.profile
                            ?: profiles.first()
                        onComplete(selected, completed)
                    }
                }
            }
        }
    }

    fun cancel() {
        generation++
    }

    fun shutdown() {
        cancel()
        executor.shutdownNow()
        mainHandler.removeCallbacksAndMessages(null)
    }

    private fun probe(profile: RemoteConnectionStore.Profile): ProbeResult {
        val startedAt = System.nanoTime()
        var connection: HttpURLConnection? = null
        return try {
            val baseUrl = profile.baseUrl.trimEnd('/')
            connection = URL("$baseUrl/codex-api/app-server/status").openConnection() as HttpURLConnection
            connection.requestMethod = "GET"
            connection.connectTimeout = CONNECT_TIMEOUT_MS
            connection.readTimeout = READ_TIMEOUT_MS
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("X-Codex-Client-Type", "android")
            connection.setRequestProperty("X-Codex-Client-Mode", "observer")
            val statusCode = connection.responseCode
            ProbeResult(
                profile = profile,
                reachable = statusCode in 100..599,
                latencyMs = elapsedMs(startedAt),
                statusCode = statusCode,
                error = null,
            )
        } catch (error: Exception) {
            ProbeResult(
                profile = profile,
                reachable = false,
                latencyMs = null,
                statusCode = null,
                error = error.message?.take(160) ?: error.javaClass.simpleName,
            )
        } finally {
            connection?.disconnect()
        }
    }

    private fun elapsedMs(startedAt: Long): Long {
        return ((System.nanoTime() - startedAt) / 1_000_000L).coerceAtLeast(0L)
    }

    private companion object {
        private const val CONNECT_TIMEOUT_MS = 1_500
        private const val READ_TIMEOUT_MS = 2_500
    }
}
