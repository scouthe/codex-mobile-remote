package com.codex.mobile

import android.os.Handler
import android.os.Looper
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/** Selects a responsive Codex endpoint without waiting for every saved address. */
class EndpointSelector internal constructor(
    private val dispatcher: EndpointDispatcher,
    private val executor: ExecutorService,
    private val cleanupExecutor: ExecutorService,
    private val probeFactory: (RemoteConnectionStore.Profile) -> EndpointProbe,
    private val budgetMs: Long = 3_000,
    private val settleMs: Long = 120,
) {
    constructor() : this(
        MainEndpointDispatcher(),
        // The store contains at most 16 profiles. Starting them together keeps
        // a slow DNS lookup from holding a later LAN address behind a queue.
        Executors.newFixedThreadPool(MAX_PARALLEL_PROBES),
        Executors.newFixedThreadPool(2),
        ::HttpEndpointProbe,
    )

    data class ProbeResult(
        val profile: RemoteConnectionStore.Profile,
        val reachable: Boolean,
        val latencyMs: Long?,
        val statusCode: Int?,
        val error: String?,
    )

    private class Selection(
        val token: Int,
        val profiles: List<RemoteConnectionStore.Profile>,
        val onComplete: (RemoteConnectionStore.Profile?, List<ProbeResult>) -> Unit,
    ) {
        val results = arrayOfNulls<ProbeResult>(profiles.size)
        val probes = mutableListOf<EndpointProbe>()
        val futures = mutableListOf<Future<*>>()
        var deadline: EndpointCancellation? = null
        var settle: EndpointCancellation? = null
    }

    private val generation = AtomicInteger()
    private val closed = AtomicBoolean()
    // Selection state is accessed only on the serial dispatcher (Android main).
    private var active: Selection? = null

    fun select(
        profiles: List<RemoteConnectionStore.Profile>,
        onComplete: (RemoteConnectionStore.Profile?, List<ProbeResult>) -> Unit,
    ) {
        val token = generation.incrementAndGet()
        val candidates = profiles.take(MAX_PARALLEL_PROBES).toList()
        dispatcher.post {
            if (closed.get() || token != generation.get()) return@post
            cancelActive()
            val selection = Selection(token, candidates, onComplete)
            active = selection
            if (candidates.isEmpty()) {
                complete(selection)
                return@post
            }
            // This timer runs independently of DNS/connect/read work. Even an
            // uninterruptible platform DNS lookup cannot prolong the picker.
            selection.deadline = dispatcher.postDelayed(budgetMs) { complete(selection) }
            candidates.forEachIndexed { index, profile ->
                val probe = probeFactory(profile)
                selection.probes.add(probe)
                selection.futures.add(executor.submit {
                    val result = try {
                        probe.run()
                    } catch (error: Exception) {
                        ProbeResult(profile, false, null, null, error.message?.take(160))
                    }
                    dispatcher.post { record(selection, index, result) }
                })
            }
        }
    }

    fun cancel() {
        val token = generation.incrementAndGet()
        dispatcher.post {
            if ((active?.token ?: token) < token) cancelActive()
        }
    }

    fun shutdown() {
        closed.set(true)
        generation.incrementAndGet()
        dispatcher.post {
            cancelActive()
            executor.shutdownNow()
            cleanupExecutor.shutdown()
        }
    }

    private fun record(selection: Selection, index: Int, result: ProbeResult) {
        if (!isCurrent(selection)) return
        selection.results[index] = result
        if (selection.results.all { it != null }) {
            complete(selection)
        } else if (result.reachable && selection.settle == null) {
            // A short race window absorbs thread/handler scheduling jitter and
            // lets an almost-simultaneous, lower-latency response win.
            selection.settle = dispatcher.postDelayed(settleMs) { complete(selection) }
        }
    }

    private fun complete(selection: Selection) {
        if (!isCurrent(selection)) return
        val selected = selection.results.filterNotNull()
            .filter { it.reachable }
            .minByOrNull { it.latencyMs ?: Long.MAX_VALUE }
            ?.profile
        val results = selection.profiles.mapIndexed { index, profile ->
            selection.results[index] ?: ProbeResult(
                profile, false, null, null,
                if (selected == null) "Selection deadline exceeded" else "Probe canceled after selection",
            )
        }
        cancelActive()
        // A cancel/new selection can arrive from another thread during cleanup.
        if (!closed.get() && selection.token == generation.get()) {
            selection.onComplete(selected, results)
        }
    }

    private fun isCurrent(selection: Selection): Boolean {
        return !closed.get() && active === selection && selection.token == generation.get()
    }

    private fun cancelActive() {
        val previous = active ?: return
        active = null
        previous.deadline?.cancel()
        previous.settle?.cancel()
        previous.futures.forEachIndexed { index, future ->
            if (previous.results[index] != null) return@forEachIndexed
            future.cancel(true)
            // Some platform disconnect implementations wait for socket locks;
            // never let cleanup block the UI or its selection deadline.
            cleanupExecutor.execute { previous.probes[index].cancel() }
        }
        (executor as? ThreadPoolExecutor)?.purge()
    }

    private companion object {
        const val MAX_PARALLEL_PROBES = 16
    }
}

internal fun interface EndpointCancellation {
    fun cancel()
}

internal interface EndpointDispatcher {
    fun post(action: () -> Unit)
    fun postDelayed(delayMs: Long, action: () -> Unit): EndpointCancellation
}

private class MainEndpointDispatcher : EndpointDispatcher {
    private val handler = Handler(Looper.getMainLooper())

    override fun post(action: () -> Unit) {
        handler.post(action)
    }

    override fun postDelayed(delayMs: Long, action: () -> Unit): EndpointCancellation {
        val runnable = Runnable(action)
        handler.postDelayed(runnable, delayMs)
        return EndpointCancellation { handler.removeCallbacks(runnable) }
    }
}
