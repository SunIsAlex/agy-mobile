package app.ccmobile.data

import android.content.SharedPreferences
import kotlinx.coroutines.CompletableDeferred
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
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.nio.file.Files
import java.time.Instant
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap

/**
 * Full Client-to-CLI ("C to C") end-to-end integration tests:
 * Android Kotlin [Repository] + [Settings] + [BridgeClient] + [Transcript] + [DiffParser]
 * <-> real Node `ccm-bridge.mjs` over TCP NDJSON
 * <-> `fake-claude.mjs` in AGY native `stream-json` mode (`CCM_LEGACY_PROTO=0`, `FAKE_AGY_STREAM=1`).
 */
class ClientToCliEndToEndTest {

    private class InMemoryPrefs : SharedPreferences {
        private val data = ConcurrentHashMap<String, Any>()
        private val listeners = ConcurrentHashMap.newKeySet<SharedPreferences.OnSharedPreferenceChangeListener>()

        override fun getAll(): MutableMap<String, *> = HashMap(data)
        override fun getString(key: String?, defValue: String?): String? = (data[key] as? String) ?: defValue
        @Suppress("UNCHECKED_CAST")
        override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? =
            (data[key] as? Set<String>)?.toMutableSet() ?: defValues
        override fun getInt(key: String?, defValue: Int): Int = (data[key] as? Int) ?: defValue
        override fun getLong(key: String?, defValue: Long): Long = (data[key] as? Long) ?: defValue
        override fun getFloat(key: String?, defValue: Float): Float = (data[key] as? Float) ?: defValue
        override fun getBoolean(key: String?, defValue: Boolean): Boolean = (data[key] as? Boolean) ?: defValue
        override fun contains(key: String?): Boolean = key != null && data.containsKey(key)

        override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
            private val staged = HashMap<String, Any?>()
            private var clearAll = false

            override fun putString(key: String, value: String?) = apply { staged[key] = value }
            override fun putStringSet(key: String, values: MutableSet<String>?) = apply { staged[key] = values?.toSet() }
            override fun putInt(key: String, value: Int) = apply { staged[key] = value }
            override fun putLong(key: String, value: Long) = apply { staged[key] = value }
            override fun putFloat(key: String, value: Float) = apply { staged[key] = value }
            override fun putBoolean(key: String, value: Boolean) = apply { staged[key] = value }
            override fun remove(key: String) = apply { staged[key] = null }
            override fun clear() = apply { clearAll = true }
            override fun commit(): Boolean { applyChanges(); return true }
            override fun apply() { applyChanges() }

            private fun applyChanges() {
                if (clearAll) data.clear()
                for ((k, v) in staged) {
                    if (v == null) data.remove(k) else data[k] = v
                    listeners.forEach { it.onSharedPreferenceChanged(this@InMemoryPrefs, k) }
                }
            }
        }

        override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) {
            listeners.add(listener)
        }

        override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) {
            listeners.remove(listener)
        }
    }

    private fun findExecutable(vararg candidates: String): String? =
        candidates.firstOrNull { File(it).canExecute() }

    private fun runGit(cwd: File, vararg args: String) {
        val git = findExecutable(
            "/data/data/com.termux/files/usr/bin/git",
            "/usr/bin/git",
            "/usr/local/bin/git",
            "/opt/homebrew/bin/git",
        ) ?: error("git executable not found")
        val proc = ProcessBuilder(listOf(git) + args)
            .directory(cwd)
            .redirectErrorStream(true)
            .start()
        val out = proc.inputStream.bufferedReader().readText()
        check(proc.waitFor() == 0) { "git ${args.joinToString(" ")} failed: $out" }
    }

    private suspend fun awaitUntil(timeoutMs: Long = 12_000, check: () -> Boolean) {
        withTimeout(timeoutMs) {
            while (!check()) delay(25)
        }
    }

    @Test
    fun fullAgyClientToCliLifecycle() = runBlocking {
        val node = findExecutable(
            "/data/data/com.termux/files/usr/bin/node",
            "/usr/bin/node",
            "/usr/local/bin/node",
            "/opt/homebrew/bin/node",
        )
        assumeTrue("node not found", node != null)

        val bridgeDir = File("../bridge").canonicalFile
        val tmp = Files.createTempDirectory("ccm-c2c").toFile()
        val reposRoot = File(tmp, "repos").apply { mkdirs() }
        val demoRepo = File(reposRoot, "demo").apply { mkdirs() }
        val stateDir = File(tmp, "state")
        val agyDir = File(tmp, "agy-data")

        // Initialize a real git repository with tracked files so git diff exercises modified, added, and deleted paths.
        runGit(demoRepo, "init", "-q", "-b", "main")
        runGit(demoRepo, "config", "user.email", "test@agy.dev")
        runGit(demoRepo, "config", "user.name", "AGY Test")
        File(demoRepo, "hello.txt").writeText("old line\nkeep line\n")
        File(demoRepo, "obsolete.txt").writeText("remove me\n")
        runGit(demoRepo, "add", "hello.txt", "obsolete.txt")
        runGit(demoRepo, "commit", "-q", "-m", "initial")

        val pngBytes = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 1, 2, 3, 4)
        val jpgBytes = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte(), 9, 8, 7, 0xFF.toByte(), 0xD9.toByte())
        val pngFile = File(demoRepo, "icon.png").apply { writeBytes(pngBytes) }
        val jpgFile = File(demoRepo, "photo.jpg").apply { writeBytes(jpgBytes) }
        runGit(demoRepo, "add", "icon.png", "photo.jpg")
        runGit(demoRepo, "commit", "-q", "-m", "add assets")

        // Seed an external AGY CLI session in brain/<brainId>/.system_generated/logs/transcript.jsonl
        val brainId = "44444444-5555-4666-8777-888888888888"
        val brainLogs = File(agyDir, "brain/$brainId/.system_generated/logs").apply { mkdirs() }
        val nowIso = Instant.now().toString()
        File(agyDir, "history.jsonl").writeText(
            """{"display":"inspect photo","timestamp":${System.currentTimeMillis() - 5000},"workspace":"${demoRepo.path}","conversationId":"$brainId"}""" + "\n"
        )
        val brainTranscript = File(brainLogs, "transcript.jsonl")
        val escapedJpgPath = jpgFile.path.replace("\\", "\\\\").replace("\"", "\\\"")
        brainTranscript.writeText(
            listOf(
                """{"step_index":0,"type":"USER_INPUT","status":"DONE","created_at":"$nowIso","content":"<USER_REQUEST>\ninspect photo\n</USER_REQUEST>"}""",
                """{"step_index":1,"type":"PLANNER_RESPONSE","status":"DONE","created_at":"$nowIso","content":"Reading photo.jpg.","input_tokens":300,"cache_read_tokens":50,"output_tokens":45,"tool_calls":[{"id":"call_jpg_c2c","name":"read_file","args":{"Path":"\"$escapedJpgPath\""}}]}""",
                """{"step_index":2,"type":"GENERIC","status":"DONE","created_at":"$nowIso","content":"Read image file"}""",
            ).joinToString("\n") + "\n"
        )

        val sh = listOf("/bin/sh", "/system/bin/sh").first { File(it).exists() }
        val fakeCli = File(tmp, "agy").apply {
            writeText("#!$sh\nexec \"$node\" \"${File(bridgeDir, "test/fake-claude.mjs")}\" \"$@\"\n")
            setExecutable(true)
        }

        val port = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1")).use { it.localPort }
        val bridgeProc = ProcessBuilder(
            node!!,
            File(bridgeDir, "ccm-bridge.mjs").path,
            "--port", "$port",
            "--roots", reposRoot.path,
            "--state-dir", stateDir.path,
        ).apply {
            val env = environment()
            env.keys.removeAll(
                setOf(
                    "AGY_SESSION_ID",
                    "ANTIGRAVITY_CONVERSATION_ID",
                    "ANTIGRAVITY_SOURCE_METADATA",
                    "GEMINI_API_KEY",
                    "GOOGLE_API_KEY",
                    "AGY_ADC_AUTH",
                    "GOOGLE_APPLICATION_CREDENTIALS",
                )
            )
            env["CCM_CLAUDE_BIN"] = fakeCli.path
            env["CCM_LEGACY_PROTO"] = "0"
            env["FAKE_AGY_STREAM"] = "1"
            env["FAKE_AGY_USAGE"] = "1"
            env["CCM_TERM_SHELL"] = "sh"
            env["CCM_ROOT"] = "0"
            env["CCM_AGY_DIR"] = agyDir.path
            env["CLAUDE_CONFIG_DIR"] = File(tmp, "claude-config").path
            env["CLOUDSDK_CONFIG"] = File(tmp, "gcloud-config").path
        }.redirectErrorStream(true).start()

        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            val reader = bridgeProc.inputStream.bufferedReader()
            var startupLine: String? = null
            while (true) {
                val line = reader.readLine() ?: break
                if (line.contains("ccm-bridge listening")) {
                    startupLine = line
                    break
                }
            }
            assertNotNull("ccm-bridge exited before listening", startupLine)
            // Drain bridge stdout in the background so pipe buffers never block
            scope.launch {
                runCatching {
                    reader.forEachLine { /* drain */ }
                }
            }

            val token = File(stateDir, "token").readText().trim()
            val settings = Settings(InMemoryPrefs(), InMemoryPrefs())
            val repo = Repository(scope, settings)

            // 1. Pair & connect Repository -> Bridge
            repo.pair("127.0.0.1", port, token)
            withTimeout(10_000) { repo.client.state.first { it is ConnState.Connected } }
            awaitUntil { repo.roots.value == listOf(reposRoot.canonicalPath) || repo.roots.value == listOf(reposRoot.path) }
            awaitUntil { repo.repos.value.any { it.name == "demo" && it.branch == "main" } }

            // 2. Create a new git repo folder through Repository.createFolder
            val createdPath = repo.createFolder(repo.roots.value.first(), "work/subrepo").getOrThrow()
            assertTrue(File(createdPath, ".git").exists())
            awaitUntil { repo.repos.value.any { it.name == "subrepo" } }

            // 3. Auth provider switching & interactive AGY login via Terminal
            val geminiStatus = repo.setAuth("gemini", "AIzaClientToCliKey123456").getOrThrow()
            assertTrue(geminiStatus.loggedIn)
            assertEquals("gemini", geminiStatus.provider)
            assertTrue(geminiStatus.hasGeminiKey)
            assertEquals("AIzaClientToCliKey123456", settings.geminiApiKey)

            // Switch to Google OAuth before any OAuth token exists: must NOT remain trapped in Gemini API mode
            val googleUnauth = repo.setAuth("google").getOrThrow()
            assertFalse(googleUnauth.loggedIn)
            assertEquals("google", googleUnauth.provider)
            assertTrue(googleUnauth.hasGeminiKey)

            val termEvents = mutableListOf<kotlinx.serialization.json.JsonObject>()
            val termCollector = scope.launch(start = CoroutineStart.UNDISPATCHED) {
                repo.terminal.collect { synchronized(termEvents) { termEvents.add(it) } }
            }
            val loginTerm = repo.termOpen(cols = 80, rows = 24, id = null, fresh = true, login = true).getOrThrow()
            var loginText = String(Base64.getMimeDecoder().decode(loginTerm.replay))
            withTimeout(10_000) {
                while (!loginText.contains("Paste code here")) {
                    val chunks = synchronized(termEvents) {
                        val out = termEvents.filter { it.str("ev") == "term_output" && it.str("id") == loginTerm.id }
                        termEvents.removeAll(out.toSet())
                        out
                    }
                    chunks.forEach { loginText += String(Base64.getMimeDecoder().decode(it.str("data") ?: "")) }
                    if (!loginText.contains("Paste code here")) delay(25)
                }
            }
            assertTrue("login PTY leaked GEMINI_API_KEY: $loginText", loginText.contains("[gemini-env:absent]"))
            repo.termInput(loginTerm.id, Base64.getEncoder().encodeToString("alice\r".toByteArray()))
            awaitUntil {
                synchronized(termEvents) { termEvents.any { it.str("ev") == "term_exit" && it.str("id") == loginTerm.id } }
            }
            termCollector.cancel()

            val googleLogged = repo.authStatus().getOrThrow()
            assertTrue(googleLogged.loggedIn)
            assertEquals("google", googleLogged.provider)
            assertEquals("alice@example.com", googleLogged.email)
            assertTrue(googleLogged.hasGeminiKey)

            // 4. Start an AGY task with attachment, file edits/writes/deletes, and inspect Transcript + Git Diff
            val attachmentB64 = Base64.getEncoder().encodeToString("spec content".toByteArray())
            val sid = repo.start(
                cwd = demoRepo.path,
                prompt = "edit-and-write",
                mode = "bypassPermissions",
                model = "gemini-3.8-flash",
                effort = "high",
                attachments = listOf(PendingAttachment("spec.txt", "text/plain", 12, attachmentB64, null)),
            )
            assertNotNull(sid)
            sid!!

            awaitUntil { repo.sessions.value.firstOrNull { it.id == sid }?.status == "idle" }
            assertEquals("spec content", File(stateDir, "attachments/$sid/spec.txt").readText())

            awaitUntil {
                val list = repo.items.value[sid].orEmpty()
                list.any { it is TurnEndItem }
            }
            val turn1Items = repo.items.value[sid].orEmpty()
            val userItem = turn1Items.filterIsInstance<UserItem>().first()
            assertEquals("edit-and-write", userItem.text)
            assertEquals(listOf("spec.txt"), userItem.attachments)

            val toolItems = turn1Items.filterIsInstance<ToolItem>()
            val editTool = toolItems.first { it.name == "edit_file" }
            assertEquals("demo/hello.txt", editTool.summary)
            assertEquals(2 to 1, editTool.delta)
            assertEquals(ToolState.Done, editTool.state)

            val writeTool = toolItems.first { it.name == "write_file" }
            assertEquals("demo/created.txt", writeTool.summary)
            assertEquals(1 to 0, writeTool.delta)
            assertEquals(ToolState.Done, writeTool.state)

            val assistantReply = turn1Items.filterIsInstance<AssistantItem>().last()
            assertEquals("Updated hello.txt and wrote created.txt", assistantReply.text)
            assertFalse(assistantReply.streaming)

            // Verify end-to-end git diff parsing (added, modified, AND deleted files!)
            repo.loadDiff(sid)
            awaitUntil { repo.diffs.value[sid]?.loading == false && repo.diffs.value[sid]?.files?.isNotEmpty() == true }
            val diffState = repo.diffs.value.getValue(sid)
            assertEquals("main", diffState.branch)
            val byPath = diffState.files.associateBy { it.path }
            assertEquals("added", byPath.getValue("created.txt").status)
            assertEquals(1, byPath.getValue("created.txt").added)
            assertEquals("modified", byPath.getValue("hello.txt").status)
            assertEquals(2, byPath.getValue("hello.txt").added)
            assertEquals(1, byPath.getValue("hello.txt").removed)
            assertEquals("deleted", byPath.getValue("obsolete.txt").status)
            assertEquals(0, byPath.getValue("obsolete.txt").added)
            assertEquals(1, byPath.getValue("obsolete.txt").removed)

            // 5. Live read_file on .png -> image thumbnail extraction + ByteLruCache hit
            repo.sendMessage(sid, "read-image: ${pngFile.path}")
            awaitUntil {
                repo.items.value[sid].orEmpty().filterIsInstance<ToolItem>().any { it.name == "read_file" && it.state == ToolState.Done }
            }
            awaitUntil { repo.sessions.value.firstOrNull { it.id == sid }?.status == "idle" }
            val readTool = repo.items.value[sid].orEmpty().filterIsInstance<ToolItem>().first { it.name == "read_file" }
            assertEquals("demo/icon.png", readTool.summary)
            val pngRef = readTool.images.single().ref
            assertNotNull(pngRef)
            val fetchedPng = repo.image(sid, pngRef!!)
            assertArrayEquals(pngBytes, fetchedPng)

            // Delete bridge's on-disk image copy and verify Repository's ByteLruCache returns cached bytes
            File(stateDir, "images/$sid/$pngRef").delete()
            assertArrayEquals(pngBytes, repo.image(sid, pngRef))

            // 6. Slash command (/models), runtime mode/model/effort updates, and usage limits
            repo.sendMessage(sid, "/models")
            awaitUntil {
                repo.items.value[sid].orEmpty().filterIsInstance<AssistantItem>().any { it.text.contains("gemini-4-carbon") }
            }
            awaitUntil { repo.sessions.value.firstOrNull { it.id == sid }?.status == "idle" }

            repo.setMode(sid, "plan")
            repo.setModel(sid, "claude-opus-5-5")
            repo.setEffort(sid, "low")
            awaitUntil {
                val s = repo.sessions.value.firstOrNull { it.id == sid }
                s?.mode == "plan" && s.model == "claude-opus-5-5" && s.effort == "low"
            }

            // Send another prompt to trigger usage + limits refresh, then loadUsage
            repo.sendMessage(sid, "check opus")
            awaitUntil {
                repo.items.value[sid].orEmpty().filterIsInstance<AssistantItem>().any { it.text.contains("check opus [effort: low]") }
            }
            awaitUntil { repo.sessions.value.firstOrNull { it.id == sid }?.status == "idle" }

            val usage = repo.loadUsage(days = 7)
            assertNotNull(usage)
            assertEquals(7, usage!!.days.size)
            assertTrue(usage.days.last().output > 0)
            assertNotNull(repo.limits.value)
            assertEquals(listOf("gemini-5h", "gemini-weekly"), repo.limits.value!!.windows.map { it.id })

            // 7. Resume external AGY CLI brain session (GENERIC tool result + .jpg image + incremental syncFromCli)
            repo.refreshClaudeSessions()
            awaitUntil { repo.claudeSessions.value?.any { it.id == brainId } == true }
            assertEquals("inspect photo", repo.claudeSessions.value!!.first { it.id == brainId }.title)

            val resumedId = repo.resume(brainId)
            assertEquals(brainId, resumedId)
            awaitUntil { repo.items.value[brainId]?.isNotEmpty() == true }
            val resumedItems = repo.items.value.getValue(brainId)
            assertEquals("inspect photo", resumedItems.filterIsInstance<UserItem>().single().text)
            val resumedTool = resumedItems.filterIsInstance<ToolItem>().single()
            assertEquals(ToolState.Done, resumedTool.state)
            val jpgRef = resumedTool.images.single().ref!!
            assertTrue(jpgRef.endsWith(".jpg"))
            assertArrayEquals(jpgBytes, repo.image(brainId, jpgRef))

            // Simulate user continuing the session in external AGY CLI while closed in the app
            repo.close(brainId)
            delay(100)
            brainTranscript.appendText(
                listOf(
                    """{"step_index":3,"type":"USER_INPUT","status":"DONE","created_at":"$nowIso","content":"<USER_REQUEST>\nfollow up in cli\n</USER_REQUEST>"}""",
                    """{"step_index":4,"type":"PLANNER_RESPONSE","status":"DONE","created_at":"$nowIso","content":"Done in CLI."}""",
                ).joinToString("\n") + "\n"
            )
            repo.open(brainId)
            awaitUntil {
                repo.items.value[brainId].orEmpty().filterIsInstance<AssistantItem>().any { it.text == "Done in CLI." }
            }
            assertEquals(
                listOf("inspect photo", "follow up in cli"),
                repo.items.value[brainId].orEmpty().filterIsInstance<UserItem>().map { it.text },
            )

            // 8. Stop an active slow-tool -> running tool settles as Failed with zero stuck Running spinners, then archive
            repo.sendMessage(sid, "slow-tool")
            awaitUntil {
                repo.items.value[sid].orEmpty().filterIsInstance<ToolItem>().any { it.summary == "sleep 60" && it.state == ToolState.Running }
            }
            repo.stop(sid)
            awaitUntil { repo.sessions.value.firstOrNull { it.id == sid }?.status == "stopped" }
            awaitUntil {
                repo.items.value[sid].orEmpty().filterIsInstance<ToolItem>().none { it.state == ToolState.Running }
            }
            val stoppedSleepTool = repo.items.value[sid].orEmpty().filterIsInstance<ToolItem>().last { it.summary == "sleep 60" }
            assertEquals(ToolState.Failed, stoppedSleepTool.state)

            repo.archive(sid)
            awaitUntil { repo.sessions.value.none { it.id == sid } && sid !in repo.items.value }

            repo.client.disconnect()
        } finally {
            scope.cancel()
            bridgeProc.destroy()
            bridgeProc.waitFor()
            File(stateDir, "keepers").listFiles().orEmpty().forEach { dir ->
                val pid = Regex("\"pid\":(\\d+)").find(File(dir, "keeper.json").takeIf { it.exists() }?.readText().orEmpty())?.groupValues?.get(1)?.toLong()
                pid?.let { ProcessHandle.of(it).ifPresent(ProcessHandle::destroy) }
            }
            tmp.deleteRecursively()
        }
    }

    @Test
    fun disconnectFailsPendingCallsImmediatelyInsteadOfWaiting20Seconds() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        val authReceived = CompletableDeferred<Unit>()
        val serverJob = scope.launch {
            val sock = server.accept()
            val reader = sock.getInputStream().bufferedReader()
            val writer = sock.getOutputStream().bufferedWriter()
            // Read client hello and reply hello so BridgeClient transitions to Connected
            reader.readLine()
            writer.write("""{"ev":"hello","roots":[]}""" + "\n")
            writer.flush()
            while (true) {
                val line = reader.readLine() ?: break
                if (line.contains("\"op\":\"auth\"")) {
                    authReceived.complete(Unit)
                    // Abruptly drop connection without answering `auth`
                    sock.close()
                    server.close()
                    break
                }
            }
        }

        try {
            val settings = Settings(InMemoryPrefs(), InMemoryPrefs())
            val repo = Repository(scope, settings)
            repo.pair("127.0.0.1", server.localPort, "tok")
            withTimeout(5_000) { repo.client.state.first { it is ConnState.Connected } }

            val startedAt = System.currentTimeMillis()
            val result = withTimeout(3_000) {
                val deferred = scope.launch { authReceived.await() }
                val res = repo.authStatus()
                deferred.join()
                res
            }
            val elapsedMs = System.currentTimeMillis() - startedAt
            assertTrue("expected failure on disconnect", result.isFailure)
            assertTrue("expected fast failure (< 2500ms), took ${elapsedMs}ms", elapsedMs < 2_500)
            repo.client.disconnect()
            serverJob.join()
        } finally {
            runCatching { server.close() }
            scope.cancel()
        }
    }

    @Test
    fun hybridSubscriptionToHydrogenApiLifecycle() = runBlocking {
        assertEquals("Gemini 4 Hydrogen", UsageText.modelName("gemini-4-hydrogen"))
        assertEquals("<$0.01", UsageText.formatUsd(0.004))
        assertEquals("$1.25", UsageText.formatUsd(1.25))
        assertEquals("4 Hydrogen", app.ccmobile.ui.modelLabel("gemini-4-hydrogen"))
        assertEquals("4 Hydrogen", app.ccmobile.ui.modelLabel("gemini-4-hydrogen-medium"))

        val node = findExecutable(
            "/data/data/com.termux/files/usr/bin/node",
            "/usr/bin/node",
            "/usr/local/bin/node",
            "/opt/homebrew/bin/node",
        )
        assumeTrue("node not found", node != null)

        val bridgeDir = File("../bridge").canonicalFile
        val tmp = Files.createTempDirectory("ccm-c2c-hybrid").toFile()
        val reposRoot = File(tmp, "repos").apply { mkdirs() }
        val demoRepo = File(reposRoot, "demo").apply { mkdirs() }
        val stateDir = File(tmp, "state")
        val agyDir = File(tmp, "agy-data").apply { mkdirs() }

        runGit(demoRepo, "init", "-q", "-b", "main")
        val claims = Base64.getUrlEncoder().withoutPadding().encodeToString("""{"email":"sub@agy.dev","name":"Sub User"}""".toByteArray())
        File(agyDir, "antigravity-oauth-token").writeText(
            """{"token":{"access_token":"ya29.sub","refresh_token":"1//sub"},"auth_method":"consumer","id_token":"eyJhbGciOiJSUzI1NiJ9.$claims.sig"}"""
        )

        fun writeFakeUsage(remaining: Double) {
            val resetIso = Instant.now().plusSeconds(3600).toString()
            File(agyDir, "fake-usage.json").writeText(
                """{"status":"SUCCESS","response":"Usage limits","command":{"name":"usage","data":{"groups":[{"buckets":[{"id":"gemini-5h","remaining_fraction":$remaining,"reset_time":"$resetIso"}]}]}}}"""
            )
        }
        writeFakeUsage(0.9)

        val sh = listOf("/bin/sh", "/system/bin/sh").first { File(it).exists() }
        val fakeCli = File(tmp, "agy").apply {
            writeText("#!$sh\nexec \"$node\" \"${File(bridgeDir, "test/fake-claude.mjs")}\" \"$@\"\n")
            setExecutable(true)
        }

        val port = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1")).use { it.localPort }
        val bridgeProc = ProcessBuilder(
            node!!,
            File(bridgeDir, "ccm-bridge.mjs").path,
            "--port", "$port",
            "--roots", reposRoot.path,
            "--state-dir", stateDir.path,
        ).apply {
            val env = environment()
            env.keys.removeAll(
                setOf(
                    "AGY_SESSION_ID",
                    "ANTIGRAVITY_CONVERSATION_ID",
                    "ANTIGRAVITY_SOURCE_METADATA",
                    "GEMINI_API_KEY",
                    "GOOGLE_API_KEY",
                    "AGY_ADC_AUTH",
                    "GOOGLE_APPLICATION_CREDENTIALS",
                )
            )
            env["CCM_CLAUDE_BIN"] = fakeCli.path
            env["CCM_LEGACY_PROTO"] = "0"
            env["FAKE_AGY_STREAM"] = "1"
            env["FAKE_AGY_USAGE"] = "1"
            env["CCM_ROOT"] = "0"
            env["CCM_AGY_DIR"] = agyDir.path
            env["CLAUDE_CONFIG_DIR"] = File(tmp, "claude-config").path
            env["CLOUDSDK_CONFIG"] = File(tmp, "gcloud-config").path
        }.redirectErrorStream(true).start()

        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            val reader = bridgeProc.inputStream.bufferedReader()
            var listening = false
            while (true) {
                val line = reader.readLine() ?: break
                if (line.contains("ccm-bridge listening")) { listening = true; break }
            }
            assertTrue("bridge failed to start", listening)
            scope.launch { runCatching { reader.forEachLine { } } }

            val token = File(stateDir, "token").readText().trim()
            val settings = Settings(InMemoryPrefs(), InMemoryPrefs())
            val repo = Repository(scope, settings)
            repo.pair("127.0.0.1", port, token)
            withTimeout(10_000) { repo.client.state.first { it is ConnState.Connected } }

            // 1. Configure Hybrid mode with $0.02 daily API cap
            val hybridAuth = repo.setAuth("hybrid", "AIzaKotlinHybridKey9999", 0.02).getOrThrow()
            assertTrue(hybridAuth.loggedIn)
            assertEquals("hybrid", hybridAuth.provider)
            assertEquals("sub@agy.dev", hybridAuth.email)
            assertEquals("AIza...9999", hybridAuth.maskedGeminiKey)
            assertEquals(0.02, hybridAuth.dailyApiLimitUsd, 0.0001)
            assertEquals("0.02", settings.dailyApiLimitUsd)

            // 2. Explicit Gemini 4 Hydrogen task
            val h4Sid = repo.start(demoRepo.path, "hydrogen-direct", "bypassPermissions", "gemini-4-hydrogen", null)!!
            repo.open(h4Sid)
            awaitUntil {
                val s = repo.sessions.value.firstOrNull { it.id == h4Sid }
                s?.status == "idle" && s.billing == "api" && s.costUsd > 0.0
            }
            awaitUntil {
                repo.items.value[h4Sid].orEmpty().filterIsInstance<AssistantItem>()
                    .any { it.text.contains("[via:api:gemini-4-hydrogen]") }
            }

            // 3. Hybrid task: Subscription -> 429 spillover to Gemini 4 Hydrogen -> Quota reset back to Subscription
            val hybSid = repo.start(demoRepo.path, "hybrid-turn-1", "bypassPermissions", "gemini-4-argon", null)!!
            repo.open(hybSid)
            awaitUntil {
                val s = repo.sessions.value.firstOrNull { it.id == hybSid }
                s?.status == "idle" && s.billing == "sub" && s.outputTokens > 0
            }
            assertEquals(0.0, repo.sessions.value.first { it.id == hybSid }.costUsd, 0.0)
            awaitUntil {
                repo.items.value[hybSid].orEmpty().filterIsInstance<AssistantItem>()
                    .any { it.text.contains("[via:sub:gemini-4-argon]") }
            }

            // Trigger Subscription 429 limit -> verify seamless failover to Gemini 4 Hydrogen on API
            File(agyDir, "fake-sub-limit").writeText("1")
            writeFakeUsage(0.0)
            repo.sendMessage(hybSid, "hybrid-turn-2")
            awaitUntil {
                repo.items.value[hybSid].orEmpty().filterIsInstance<AssistantItem>()
                    .any { it.text.contains("hybrid-turn-2") && it.text.contains("[via:api:gemini-4-hydrogen]") }
            }
            awaitUntil {
                val s = repo.sessions.value.firstOrNull { it.id == hybSid }
                s?.status == "idle" && s.billing == "api" && s.effectiveModel == "gemini-4-hydrogen" && s.costUsd > 0.0
            }
            assertTrue(
                repo.items.value[hybSid].orEmpty().filterIsInstance<NoteItem>()
                    .any { it.text.contains("Gemini 4 Hydrogen") }
            )

            // Reset Subscription quota -> verify Usage split & automatic revert to Subscription
            File(agyDir, "fake-sub-limit").delete()
            writeFakeUsage(0.95)
            val usage = repo.loadUsage(7)
            assertNotNull(usage)
            assertTrue(usage!!.todayApiCostUsd > 0.0)
            assertEquals(0.02, usage.dailyApiLimitUsd, 0.0001)
            assertTrue(usage.days.last().apiRequests >= 2)
            assertTrue(usage.days.last().output > usage.days.last().apiOutput)

            repo.sendMessage(hybSid, "hybrid-turn-3")
            awaitUntil {
                repo.items.value[hybSid].orEmpty().filterIsInstance<AssistantItem>()
                    .any { it.text.contains("hybrid-turn-3") && it.text.contains("[via:sub:gemini-4-argon]") }
            }
            awaitUntil {
                val s = repo.sessions.value.firstOrNull { it.id == hybSid }
                s?.status == "idle" && s.billing == "sub" && s.running
            }

            repo.client.disconnect()
        } finally {
            scope.cancel()
            bridgeProc.destroy()
            bridgeProc.waitFor()
            File(stateDir, "keepers").listFiles().orEmpty().forEach { dir ->
                val pid = Regex("\"pid\":(\\d+)").find(File(dir, "keeper.json").takeIf { it.exists() }?.readText().orEmpty())?.groupValues?.get(1)?.toLong()
                pid?.let { ProcessHandle.of(it).ifPresent(ProcessHandle::destroy) }
            }
            tmp.deleteRecursively()
        }
    }
}
