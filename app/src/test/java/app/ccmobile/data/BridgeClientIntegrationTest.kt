package app.ccmobile.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.nio.file.Files

/** Runs the real bridge (with test/fake-claude.mjs standing in for the CLI) against [BridgeClient]. Skipped without node. */
class BridgeClientIntegrationTest {
    private fun obj(vararg pairs: Pair<String, Any>) = JsonObject(pairs.associate { (k, v) ->
        k to when (v) {
            is Boolean -> JsonPrimitive(v)
            is Number -> JsonPrimitive(v)
            else -> JsonPrimitive(v.toString())
        }
    })

    @Test
    fun startApproveAndFinish() = runBlocking {
        val node = listOf("/data/data/com.termux/files/usr/bin/node", "/usr/bin/node", "/usr/local/bin/node", "/opt/homebrew/bin/node")
            .firstOrNull { File(it).canExecute() }
        assumeTrue("node not found", node != null)
        val bridgeDir = File("../bridge").canonicalFile
        val tmp = Files.createTempDirectory("ccm-it").toFile()
        val repo = File(tmp, "repos/demo").apply { mkdirs() }
        val sh = listOf("/bin/sh", "/system/bin/sh").first { File(it).exists() }
        val fake = File(tmp, "claude").apply {
            writeText("#!$sh\nexec \"$node\" \"${File(bridgeDir, "test/fake-claude.mjs")}\" \"$@\"\n")
            setExecutable(true)
        }
        val port = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1")).use { it.localPort }
        val proc = ProcessBuilder(node, File(bridgeDir, "ccm-bridge.mjs").path, "--port", "$port", "--roots", File(tmp, "repos").path, "--state-dir", File(tmp, "state").path)
            .apply {
                val env = environment()
                env.keys.removeAll(setOf("AGY_SESSION_ID", "ANTIGRAVITY_CONVERSATION_ID", "ANTIGRAVITY_SOURCE_METADATA", "GEMINI_API_KEY", "GOOGLE_API_KEY", "AGY_ADC_AUTH", "GOOGLE_APPLICATION_CREDENTIALS"))
                env["CCM_CLAUDE_BIN"] = fake.path
                env["CCM_LEGACY_PROTO"] = "1"
                env["CCM_ROOT"] = "0"
                env["CCM_AGY_DIR"] = File(tmp, "agy-data").path
                env["CLAUDE_CONFIG_DIR"] = File(tmp, "claude-config").path
                env["CLOUDSDK_CONFIG"] = File(tmp, "gcloud-config").path
            }
            .redirectErrorStream(true)
            .start()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            val reader = proc.inputStream.bufferedReader()
            while (true) {
                val line = reader.readLine() ?: error("ccm-bridge exited before listening")
                if (line.contains("ccm-bridge listening")) break
            }
            scope.launch { runCatching { reader.forEachLine { } } }
            val token = File(tmp, "state/token").readText().trim()
            val client = BridgeClient(scope)
            val events = mutableListOf<JsonObject>()
            // UNDISPATCHED: subscribed before connect(), so no event is missed.
            val collector = scope.launch(start = CoroutineStart.UNDISPATCHED) {
                client.events.collect { synchronized(events) { events.add(it) } }
            }

            suspend fun await(pred: (JsonObject) -> Boolean): JsonObject = withTimeout(10_000) {
                var found: JsonObject? = null
                while (found == null) {
                    found = synchronized(events) { events.firstOrNull(pred)?.also { events.remove(it) } }
                    if (found == null) delay(20)
                }
                found
            }

            client.connect(BridgeConfig("127.0.0.1", port, token))
            withTimeout(10_000) { client.state.first { it is ConnState.Connected } }

            client.send(obj("op" to "start", "ref" to 1, "cwd" to repo.path, "prompt" to "hello"))
            val started = await { it.str("ev") == "started" }
            val sid = started.obj("session")!!.str("id")!!

            val approvalEv = await { it.str("ev") == "approval" }
            val approval = approvalFrom(sid, "hello", approvalEv.obj("request")!!)!!
            assertEquals("touch x", approval.summary)

            client.send(obj("op" to "permission", "sid" to sid, "requestId" to approval.requestId, "decision" to "allow"))
            await { it.str("ev") == "session" && it.obj("session")?.str("status") == "idle" }

            // A bad token is reported as a non-retrying failure.
            val bad = BridgeClient(scope)
            bad.connect(BridgeConfig("127.0.0.1", port, "nope"))
            val failed = withTimeout(10_000) { bad.state.first { it is ConnState.Failed } } as ConnState.Failed
            assertEquals(false, failed.retrying)

            collector.cancel()
            client.disconnect()
        } finally {
            scope.cancel()
            proc.destroy()
            proc.waitFor()
            // Claude (here fake-claude) runs under keepers that outlive the bridge; stop them too.
            File(tmp, "state/keepers").listFiles().orEmpty().forEach { dir ->
                val pid = Regex("\"pid\":(\\d+)").find(File(dir, "keeper.json").takeIf { it.exists() }?.readText().orEmpty())?.groupValues?.get(1)?.toLong()
                pid?.let { ProcessHandle.of(it).ifPresent(ProcessHandle::destroy) }
            }
            tmp.deleteRecursively()
        }
    }
}
