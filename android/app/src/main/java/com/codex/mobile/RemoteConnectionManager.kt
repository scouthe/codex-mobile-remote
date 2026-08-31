package com.codex.mobile

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper

/**
 * Small lifecycle-aware network/retry coordinator for the remote WebView.
 * The WebView remains the HTTP/WebSocket client; this class only tells the
 * activity when connectivity changes and bounds automatic reload attempts.
 */
class RemoteConnectionManager(
    context: Context,
    private val onNetworkAvailable: () -> Unit,
    private val onNetworkLost: () -> Unit,
) {
    private val connectivityManager =
        context.applicationContext.getSystemService(ConnectivityManager::class.java)
    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile
    private var registered = false
    private var retryAttempt = 0

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            if (registered) mainHandler.post(onNetworkAvailable)
        }

        override fun onLost(network: Network) {
            if (registered && !isOnline()) mainHandler.post(onNetworkLost)
        }

        override fun onCapabilitiesChanged(
            network: Network,
            networkCapabilities: NetworkCapabilities,
        ) {
            if (registered && networkCapabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
                mainHandler.post(onNetworkAvailable)
            }
        }
    }

    fun start() {
        if (registered) return
        registered = true
        try {
            connectivityManager.registerDefaultNetworkCallback(networkCallback)
        } catch (_: Exception) {
            registered = false
        }
    }

    fun stop() {
        cancelReconnect()
        if (!registered) return
        registered = false
        try {
            connectivityManager.unregisterNetworkCallback(networkCallback)
        } catch (_: Exception) {
            // The callback can already be gone during process teardown.
        }
    }

    fun isOnline(): Boolean {
        val active = connectivityManager.activeNetwork ?: return false
        val capabilities = connectivityManager.getNetworkCapabilities(active) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    /**
     * Retry immediately, then back off to 30 seconds. Calling this repeatedly
     * replaces the pending callback, preventing reload fan-out.
     */
    fun scheduleReconnect(action: () -> Unit) {
        mainHandler.removeCallbacksAndMessages(RETRY_TOKEN)
        val delay = RETRY_DELAYS_MS[retryAttempt.coerceAtMost(RETRY_DELAYS_MS.lastIndex)]
        retryAttempt = (retryAttempt + 1).coerceAtMost(RETRY_DELAYS_MS.lastIndex)
        mainHandler.postAtTime(action, RETRY_TOKEN, android.os.SystemClock.uptimeMillis() + delay)
    }

    fun markConnected() {
        retryAttempt = 0
        mainHandler.removeCallbacksAndMessages(RETRY_TOKEN)
    }

    fun cancelReconnect() {
        retryAttempt = 0
        mainHandler.removeCallbacksAndMessages(RETRY_TOKEN)
    }

    private companion object {
        private val RETRY_TOKEN = Any()
        private val RETRY_DELAYS_MS = longArrayOf(0, 1_000, 2_000, 5_000, 10_000, 30_000)
    }
}
