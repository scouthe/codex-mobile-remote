package com.codex.mobile

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper

/**
 * Small lifecycle-aware network-state coordinator for the remote WebView.
 * The WebView remains the HTTP/WebSocket client; this class only tells the
 * activity when connectivity changes. Connection retries are explicit so the
 * activity can keep its saved endpoint picker visible after a failure.
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
        mainHandler.removeCallbacksAndMessages(null)
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

}
