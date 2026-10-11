package com.codex.mobile

import java.net.ServerSocket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class EndpointProbeTest {
    @Test fun recognizesAuthStatusLoginAndFirstSetup() {
        assertTrue(EndpointResponsePolicy.isUsable(200, """{"passwordProtected":true,"lanOnly":false}"""))
        assertTrue(EndpointResponsePolicy.isUsable(200, """{ "lanOnly": true, "passwordProtected": false }"""))
        assertTrue(EndpointResponsePolicy.isUsable(200, LOGIN_PAGE))
        assertTrue(EndpointResponsePolicy.isUsable(200,
            """Codex Remote <form id="password-form"><script>fetch('/auth/setup')</script>"""))
    }

    @Test fun distinguishesAuthenticationFromPublicAccessDenial() {
        assertTrue(EndpointResponsePolicy.isUsable(401, ""))
        assertTrue(EndpointResponsePolicy.isUsable(403, LOGIN_PAGE))
        assertFalse(EndpointResponsePolicy.isUsable(403,
            "<title>Codex Remote</title><h1>已禁止公网访问</h1><p>未设置访问密码，仅允许从本机或局域网访问。</p>"))
        assertFalse(EndpointResponsePolicy.isUsable(403, "Forbidden"))
        for (status in listOf(301, 302, 404, 429, 500, 502, 503)) {
            assertFalse("HTTP $status", EndpointResponsePolicy.isUsable(status, LOGIN_PAGE))
        }
        assertFalse(EndpointResponsePolicy.isUsable(200, "<title>Router login</title>"))
        assertFalse(EndpointResponsePolicy.isUsable(200, """{"passwordProtected":"true","lanOnly":false}"""))
    }

    @Test fun probesAuthStatusWithoutSendingStoredPassword() {
        withResponse(200, """{"passwordProtected":false,"lanOnly":true}""") { profile, request ->
            val result = HttpEndpointProbe(profile).run()
            assertTrue(result.reachable)
            assertEquals(200, result.statusCode)
            val headers = request()
            assertTrue(headers.startsWith("GET /auth/status HTTP/1.1"))
            assertFalse(headers.contains("audit-secret"))
            assertFalse(headers.contains("/app-server/"))
        }
    }

    @Test fun readsForbiddenLoginBodyAndRejectsLargeUnknownPage() {
        withResponse(403, LOGIN_PAGE) { profile, _ ->
            assertTrue(HttpEndpointProbe(profile).run().reachable)
        }
        withResponse(200, "x".repeat(32 * 1_024)) { profile, _ ->
            assertFalse(HttpEndpointProbe(profile).run().reachable)
        }
    }

    @Test fun canceledProbeDoesNotOpenConnection() {
        val profile = RemoteConnectionStore.Profile("test", "Test", "http://127.0.0.1:1", null)
        val probe = HttpEndpointProbe(profile)
        probe.cancel()
        val result = probe.run()
        assertFalse(result.reachable)
        assertEquals("Probe canceled", result.error)
        assertNull(result.statusCode)
    }

    private fun withResponse(
        status: Int,
        body: String,
        test: (RemoteConnectionStore.Profile, () -> String) -> Unit,
    ) {
        val worker = Executors.newSingleThreadExecutor()
        ServerSocket(0).use { server ->
            server.soTimeout = 5_000
            val request = worker.submit<String> {
                server.accept().use { socket ->
                    socket.soTimeout = 5_000
                    val reader = socket.getInputStream().bufferedReader()
                    val headers = buildString {
                        while (true) {
                            val line = reader.readLine() ?: break
                            if (line.isEmpty()) break
                            appendLine(line)
                        }
                    }
                    val bytes = body.toByteArray(Charsets.UTF_8)
                    val output = socket.getOutputStream()
                    output.write("HTTP/1.1 $status Test\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
                    output.write(bytes)
                    output.flush()
                    headers
                }
            }
            try {
                val profile = RemoteConnectionStore.Profile("test", "Test", "http://127.0.0.1:${server.localPort}", "audit-secret")
                test(profile) { request.get(5, TimeUnit.SECONDS) }
            } finally {
                worker.shutdownNow()
            }
        }
    }

    private companion object {
        const val LOGIN_PAGE = """<title>Codex Web</title><form id="f"><input id="pw" type="password"><script>fetch('/auth/login')</script>"""
    }
}
