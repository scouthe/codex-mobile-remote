package com.codex.mobile

import java.util.concurrent.AbstractExecutorService
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class EndpointSelectorTest {
    @Test fun fastAddressWinsWithoutWaitingForStalledAddresses() {
        val fixture = Fixture()
        fixture.select("slow", "fast", "dns")
        fixture.dispatcher.advanceTo(50)
        fixture.finishProbe(1, latencyMs = 50)
        fixture.dispatcher.advanceTo(169)
        assertTrue(fixture.callbacks.isEmpty())
        fixture.dispatcher.advanceTo(170)
        assertEquals("fast", fixture.callbacks.single().first?.id)
        assertTrue(fixture.executor.tasks[0].isCancelled)
        assertTrue(fixture.executor.tasks[2].isCancelled)
        fixture.cleanup.runAll()
        assertTrue(fixture.probes[0].canceled)
        assertTrue(fixture.probes[2].canceled)
        fixture.dispatcher.advanceTo(10_000)
        assertEquals(1, fixture.callbacks.size)
    }

    @Test fun shortRaceWindowStillChoosesLowestMeasuredLatency() {
        val fixture = Fixture()
        fixture.select("first", "faster", "stalled")
        fixture.dispatcher.advanceTo(80)
        fixture.finishProbe(0, latencyMs = 80)
        fixture.dispatcher.advanceTo(100)
        fixture.finishProbe(1, latencyMs = 40)
        fixture.dispatcher.advanceTo(200)
        assertEquals("faster", fixture.callbacks.single().first?.id)
    }

    @Test fun totalBudgetDoesNotDependOnWorkerOrDnsCompletion() {
        val fixture = Fixture()
        fixture.select(*(0 until 16).map { "blocked-$it" }.toTypedArray())
        assertEquals(16, fixture.executor.tasks.size)
        // No worker returns: the deadline is serviced on a separate dispatcher.
        fixture.dispatcher.advanceTo(2_999)
        assertTrue(fixture.callbacks.isEmpty())
        fixture.dispatcher.advanceTo(3_000)
        assertNull(fixture.callbacks.single().first)
        assertEquals(16, fixture.callbacks.single().second.size)
        assertTrue(fixture.executor.tasks.all { it.isCancelled })
    }

    @Test fun failedProxyDoesNotBeatWorkingLoginPage() {
        val fixture = Fixture()
        fixture.select("proxy-502", "codex-login")
        fixture.finishProbe(0, reachable = false, latencyMs = 10)
        assertTrue(fixture.callbacks.isEmpty())
        fixture.dispatcher.advanceTo(80)
        fixture.finishProbe(1, latencyMs = 80)
        assertEquals("codex-login", fixture.callbacks.single().first?.id)
        assertEquals(80L, fixture.dispatcher.now)
    }

    @Test fun allFailuresReturnNullWithoutWaitingForDeadline() {
        val fixture = Fixture()
        fixture.select("bad")
        fixture.finishProbe(0, reachable = false)
        assertNull(fixture.callbacks.single().first)
        assertEquals(0L, fixture.dispatcher.now)
    }

    @Test fun newSelectionSuppressesAlreadyPostedOldResultAndCancelsOldWork() {
        val fixture = Fixture()
        fixture.select("old", "blocked")
        fixture.executor.tasks[0].run() // Its result is queued, not yet delivered.
        fixture.selector.select(listOf(profile("new"))) { selected, results ->
            fixture.callbacks.add(selected to results)
        }
        fixture.dispatcher.runCurrent()
        assertTrue(fixture.callbacks.isEmpty())
        assertTrue(fixture.executor.tasks[1].isCancelled)
        fixture.executor.tasks[2].run()
        fixture.dispatcher.runCurrent()
        assertEquals("new", fixture.callbacks.single().first?.id)
        fixture.dispatcher.advanceTo(5_000)
        assertEquals(1, fixture.callbacks.size)
    }

    @Test fun cancelAndShutdownCannotDeliverLateSelection() {
        val fixture = Fixture()
        fixture.select("first", "blocked")
        fixture.finishProbe(0)
        fixture.selector.cancel()
        fixture.dispatcher.advanceTo(3_000)
        assertTrue(fixture.callbacks.isEmpty())
        fixture.select("another")
        fixture.executor.tasks.last().run()
        fixture.selector.shutdown()
        fixture.dispatcher.runCurrent()
        assertTrue(fixture.callbacks.isEmpty())
        assertTrue(fixture.executor.isShutdown)
        assertTrue(fixture.cleanup.isShutdown)
    }

    private class Fixture {
        val dispatcher = ManualDispatcher()
        val executor = ManualExecutor()
        val cleanup = ManualExecutor()
        val probes = mutableListOf<FakeProbe>()
        val callbacks = mutableListOf<Pair<RemoteConnectionStore.Profile?, List<EndpointSelector.ProbeResult>>>()
        val selector = EndpointSelector(dispatcher, executor, cleanup, { profile ->
            FakeProbe(profile).also(probes::add)
        })

        fun select(vararg ids: String) {
            selector.select(ids.map(::profile)) { selected, results -> callbacks.add(selected to results) }
            dispatcher.runCurrent()
        }

        fun finishProbe(index: Int, reachable: Boolean = true, latencyMs: Long = 10) {
            probes[index].result = probes[index].result.copy(reachable = reachable, latencyMs = latencyMs)
            executor.tasks[index].run()
            dispatcher.runCurrent()
        }
    }

    private class FakeProbe(profile: RemoteConnectionStore.Profile) : EndpointProbe {
        var result = EndpointSelector.ProbeResult(profile, true, 10, 200, null)
        var canceled = false
        override fun run() = result
        override fun cancel() { canceled = true }
    }

    private class ManualExecutor : AbstractExecutorService() {
        val tasks = mutableListOf<java.util.concurrent.FutureTask<*>>()
        private var stopped = false
        override fun execute(command: Runnable) {
            tasks.add(command as? java.util.concurrent.FutureTask<*>
                ?: java.util.concurrent.FutureTask(command, null))
        }
        fun runAll() { tasks.forEach { it.run() } }
        override fun shutdown() { stopped = true }
        override fun shutdownNow(): MutableList<Runnable> {
            stopped = true
            tasks.forEach { it.cancel(true) }
            return mutableListOf()
        }
        override fun isShutdown() = stopped
        override fun isTerminated() = stopped
        override fun awaitTermination(timeout: Long, unit: TimeUnit) = stopped
    }

    private class ManualDispatcher : EndpointDispatcher {
        private data class Pending(val at: Long, val action: () -> Unit, var canceled: Boolean = false)
        private val pending = mutableListOf<Pending>()
        var now = 0L
            private set
        override fun post(action: () -> Unit) { postDelayed(0, action) }
        override fun postDelayed(delayMs: Long, action: () -> Unit): EndpointCancellation {
            val item = Pending(now + delayMs, action)
            pending.add(item)
            return EndpointCancellation { item.canceled = true }
        }
        fun runCurrent() = advanceTo(now)
        fun advanceTo(time: Long) {
            while (true) {
                val item = pending.filter { !it.canceled && it.at <= time }.minByOrNull { it.at } ?: break
                pending.remove(item)
                now = item.at
                item.action()
            }
            now = time
        }
    }

    private companion object {
        fun profile(id: String) = RemoteConnectionStore.Profile(id, id, "http://$id.invalid", null)
    }
}
