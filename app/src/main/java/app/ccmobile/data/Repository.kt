package app.ccmobile.data

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.TimeZone
import android.util.Base64
import android.util.LruCache
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.snapshots.SnapshotStateList
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

data class DiffState(
    val loading: Boolean = false,
    val files: List<FileDiff> = emptyList(),
    val truncated: Boolean = false,
    val branch: String? = null,
)

/**
 * App-wide state backed by the bridge. Lives for the whole process (held by CcApp) so the
 * notification service and the UI share one connection. Call from the main thread.
 */
private const val OUTDATED_BRIDGE = "This bridge is too old to log in from the app. Restart it to update it."

class Repository(private val scope: CoroutineScope, val settings: Settings) {
    val client = BridgeClient(scope)
    /** Dictation through Claude's speech-to-text on the bridge. */
    val voice = VoiceInput(scope, send = { op, fields -> send(op, *fields) }, open = { fields ->
        val reply = call("voice_start", quiet = true, *fields)
        when {
            reply == null -> "The bridge didn't answer."
            reply.str("ev") != "error" -> null
            reply.str("message")?.startsWith("Unknown op") == true -> "This bridge is too old for voice. Restart it to update it."
            else -> reply.str("message") ?: "Couldn't start voice."
        }
    })

    private val _sessions = MutableStateFlow<List<SessionSummary>>(emptyList())
    val sessions: StateFlow<List<SessionSummary>> = _sessions.asStateFlow()
    private val _repos = MutableStateFlow<List<Repo>>(emptyList())
    val repos: StateFlow<List<Repo>> = _repos.asStateFlow()
    private val _roots = MutableStateFlow<List<String>>(emptyList())
    /** The folders the bridge scans for repos (its --roots); new folders go in one of these. */
    val roots: StateFlow<List<String>> = _roots.asStateFlow()
    private val _claudeSessions = MutableStateFlow<List<ClaudeSession>?>(null)
    /** Sessions from Claude Code elsewhere that can be resumed here; null until loaded. */
    val claudeSessions: StateFlow<List<ClaudeSession>?> = _claudeSessions.asStateFlow()
    private val _limits = MutableStateFlow<Limits?>(null)
    /** Plan limits as of Claude's last reply; null until the bridge has seen one. */
    val limits: StateFlow<Limits?> = _limits.asStateFlow()
    private val _usageTick = MutableStateFlow(0L)
    /** Bumped whenever token usage or plan limits change on the bridge. */
    val usageTick: StateFlow<Long> = _usageTick.asStateFlow()
    private val _approvals = MutableStateFlow<List<Approval>>(emptyList())
    val approvals: StateFlow<List<Approval>> = _approvals.asStateFlow()
    private val _items = MutableStateFlow<Map<String, List<Item>>>(emptyMap())
    val items: StateFlow<Map<String, List<Item>>> = _items.asStateFlow()
    private val _diffs = MutableStateFlow<Map<String, DiffState>>(emptyMap())
    val diffs: StateFlow<Map<String, DiffState>> = _diffs.asStateFlow()
    private val _errors = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val errors: SharedFlow<String> = _errors

    /** True while an activity is visible; approval notifications are held back then. */
    val foreground = MutableStateFlow(false)

    private val _terminal = MutableSharedFlow<JsonObject>(extraBufferCapacity = 4096)
    /** term_output, term_exit and term_link events for the Terminal screen. */
    val terminal: SharedFlow<JsonObject> = _terminal
    // Keystrokes go out one at a time, in order (separate coroutines could reorder fast typing).
    private val termInputs = Channel<Pair<String, String>>(Channel.UNLIMITED)

    private val transcripts = HashMap<String, Transcript>()
    // Images are about a megabyte each; keep the recent ones so scrolling back doesn't refetch.
    private val imageCache = object : LruCache<String, ByteArray>(32 * 1024 * 1024) {
        override fun sizeOf(key: String, value: ByteArray) = value.size
    }
    private val open = mutableSetOf<String>()
    // Picked but unsent attachments, by task id like Settings.draft; memory only, as they can be megabytes.
    private val draftAttachments = HashMap<String, SnapshotStateList<PendingAttachment>>()
    private var nextRef = 1
    private val waiting = HashMap<Int, CompletableDeferred<JsonObject?>>()
    private val quietRefs = mutableSetOf<Int>()

    init {
        scope.launch { for ((id, data) in termInputs) send("term_input", "id" to id, "data" to data) }
        // Subscribed before any connection exists: the bridge sends its task list right after hello,
        // and an event emitted before anyone collects is lost (that left the task list nearly empty).
        scope.launch(start = CoroutineStart.UNDISPATCHED) { client.events.collect(::onEvent) }
        scope.launch {
            client.state.collect { state ->
                if (state is ConnState.Connected) {
                    send("sessions") // also sent unasked on connect; asking again can't hurt
                    send("repos")
                    open.forEach { send("subscribe", "sid" to it) }
                }
            }
        }
    }

    fun connect() {
        settings.config()?.let(client::connect)
    }

    private var expectedPairing: Pair<Int, Long>? = null

    /** The user just asked to start the bridge on [port]; its pairing link may skip the confirmation. */
    fun expectPairing(port: Int) { expectedPairing = port to System.currentTimeMillis() + 60_000 }

    /** True (once) for a pairing link from the bridge the user just started on this phone. */
    fun isExpectedPairing(host: String, port: Int): Boolean {
        val (p, until) = expectedPairing ?: return false
        val ok = p == port && System.currentTimeMillis() < until && (host == "127.0.0.1" || host == "localhost")
        if (ok) expectedPairing = null
        return ok
    }

    fun pair(host: String, port: Int, token: String) {
        settings.host = host
        settings.port = port
        settings.token = token
        connect()
    }

    // ---- actions ----

    /** Starts a task and returns its session id, or null if the bridge refused or didn't answer. */
    suspend fun start(
        cwd: String, prompt: String, mode: String, model: String?, effort: String?,
        attachments: List<PendingAttachment> = emptyList(),
        autoContinue: Boolean = settings.autoContinue,
    ): String? {
        settings.lastRepo = cwd
        val reply = request(
            "start", "cwd" to cwd, "prompt" to prompt, "mode" to mode, "model" to model, "effort" to effort,
            "autoContinue" to autoContinue.takeIf { it }, "attachments" to attachmentsJson(attachments),
        )
        val session = reply?.obj("session") ?: return null
        val summary = json.decodeFromJsonElement(SessionSummary.serializer(), session)
        upsertSession(summary)
        open(summary.id)
        return summary.id
    }

    /** Brings a Claude Code session started elsewhere into the bridge and returns its id (the same session id). */
    suspend fun resume(id: String): String? {
        val reply = request("resume", "id" to id) ?: return null
        val summary = json.decodeFromJsonElement(SessionSummary.serializer(), reply.obj("session") ?: return null)
        upsertSession(summary)
        _claudeSessions.update { list -> list?.filterNot { it.id == id } }
        open(summary.id)
        return summary.id
    }

    /** Creates a git repo folder named [name] (may be "a/b") under [root] and returns its path, or the bridge's error. */
    suspend fun createFolder(root: String, name: String): Result<String> {
        val reply = call("mkdir", quiet = true, "root" to root, "name" to name)
            ?: return Result.failure(Exception("The bridge didn't answer."))
        val path = reply.str("created") ?: return Result.failure(Exception(reply.str("message") ?: "Couldn't create the folder."))
        settings.lastRepo = path
        return Result.success(path)
    }

    /** Token use over the last [days] days, bucketed by this phone's calendar days. */
    suspend fun loadUsage(days: Int, quiet: Boolean = false): Usage? {
        val tzOffsetMin = TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60_000
        val reply = call("usage", quiet = quiet, "days" to days, "tzOffsetMin" to tzOffsetMin)
            ?.takeUnless { it.str("ev") == "error" } ?: return null
        reply.obj("limits")?.let { _limits.value = json.decodeFromJsonElement(Limits.serializer(), it) }
        return json.decodeFromJsonElement(Usage.serializer(), reply)
    }

    /** An image Claude looked at in session [sid], fetched from the bridge (see Transcript.imagesIn). */
    suspend fun image(sid: String, ref: String): ByteArray? {
        imageCache.get(ref)?.let { return it }
        val reply = call("image", quiet = true, "sid" to sid, "image" to ref) ?: return null
        val data = reply.str("data") ?: return null
        val bytes = withContext(Dispatchers.Default) { Base64.decode(data, Base64.DEFAULT) }
        imageCache.put(ref, bytes)
        return bytes
    }

    /** Asks the bridge to continue tasks whose usage limit has reset (see ResumeAlarm). */
    suspend fun tick(): Boolean = send("tick")

    /** The bridge user's processes, or null if the bridge didn't answer. */
    suspend fun processes(): List<ProcInfo>? = call("processes", quiet = true)?.let(::processList)

    /** Sends [signal] (SIGTERM, SIGKILL, SIGSTOP, SIGCONT) and returns the new list, or the bridge's error. */
    suspend fun signal(pid: Int, signal: String): Result<List<ProcInfo>> =
        processReply(call("signal", quiet = true, "pid" to pid, "signal" to signal))

    /** Stops [pid] and runs its command again; returns the new list, or the bridge's error. */
    suspend fun restartProcess(pid: Int): Result<List<ProcInfo>> =
        processReply(call("restart_process", quiet = true, "pid" to pid))

    private fun processList(reply: JsonObject): List<ProcInfo>? =
        reply.arr("processes")?.let { json.decodeFromJsonElement(ListSerializer(ProcInfo.serializer()), it) }

    private fun processReply(reply: JsonObject?): Result<List<ProcInfo>> = when {
        reply == null -> Result.failure(Exception("The bridge didn't answer."))
        reply.str("ev") == "error" -> Result.failure(Exception(reply.str("message") ?: "Failed"))
        else -> processList(reply)?.let { Result.success(it) } ?: Result.failure(Exception("Bad reply"))
    }

    /**
     * Opens (or attaches to) the Debian terminal, or with [login] a `claude auth login` on the bridge;
     * returns it or the bridge's error.
     */
    suspend fun termOpen(cols: Int, rows: Int, id: String?, fresh: Boolean = false, login: Boolean = false): Result<TermOpened> {
        val reply = call(
            "term_open", quiet = true, "cols" to cols, "rows" to rows, "id" to id, "fresh" to fresh.takeIf { it },
            "kind" to "login".takeIf { login },
        ) ?: return Result.failure(Exception("The bridge didn't answer."))
        if (reply.str("ev") == "error") return Result.failure(Exception(reply.str("message") ?: "Couldn't open the terminal."))
        // A bridge from before logins ignores the kind and hands back its shell.
        if (login && reply.str("kind") != "login") return Result.failure(Exception(OUTDATED_BRIDGE))
        val links = reply.arr("links")?.let { json.decodeFromJsonElement(ListSerializer(TermLink.serializer()), it) }.orEmpty()
        return Result.success(TermOpened(reply.str("id") ?: "", reply.str("data") ?: "", links))
    }

    /** Who Claude Code on the bridge is signed in as. */
    suspend fun authStatus(): Result<AuthStatus> {
        val reply = call("auth", quiet = true) ?: return Result.failure(Exception("The bridge didn't answer."))
        if (reply.str("ev") == "error") {
            val message = reply.str("message")
            return Result.failure(Exception(if (message?.startsWith("Unknown op") == true) OUTDATED_BRIDGE else message ?: "Couldn't check the Claude login."))
        }
        return runCatching { json.decodeFromJsonElement(AuthStatus.serializer(), reply.obj("auth")!!) }
    }

    fun termInput(id: String, base64: String) { termInputs.trySend(id to base64) }
    fun termResize(id: String, cols: Int, rows: Int) = fire("term_resize", "id" to id, "cols" to cols, "rows" to rows)
    fun termDetach(id: String) { scope.launch { send("term_detach", "id" to id) } }
    fun termClose(id: String) = fire("term_close", "id" to id)

    /** Moves task [sid] to working folder [cwd]; Claude carries on there from the next message. */
    suspend fun moveTask(sid: String, cwd: String): Result<Unit> {
        val reply = call("cwd", quiet = true, "sid" to sid, "cwd" to cwd)
            ?: return Result.failure(Exception("The bridge didn't answer."))
        if (reply.str("ev") == "error") return Result.failure(Exception(reply.str("message") ?: "Couldn't change the folder."))
        reply.obj("session")?.let { upsertSession(json.decodeFromJsonElement(SessionSummary.serializer(), it)) }
        return Result.success(Unit)
    }

    fun refreshClaudeSessions() = fire("claude_sessions")

    fun open(sid: String) {
        if (open.add(sid)) scope.launch { send("subscribe", "sid" to sid) }
    }

    fun close(sid: String) {
        if (open.remove(sid)) scope.launch { send("unsubscribe", "sid" to sid) }
    }

    fun draftAttachments(key: String): SnapshotStateList<PendingAttachment> = draftAttachments.getOrPut(key) { mutableStateListOf() }

    fun sendMessage(sid: String, text: String, attachments: List<PendingAttachment> = emptyList()) =
        fire("send", "sid" to sid, "text" to text, "attachments" to attachmentsJson(attachments))
    fun setAutoContinue(sid: String, on: Boolean) = fire("auto_continue", "sid" to sid, "on" to on)
    fun reportError(message: String) { _errors.tryEmit(message) }
    fun interrupt(sid: String) = fire("interrupt", "sid" to sid)
    fun setMode(sid: String, mode: String) = fire("mode", "sid" to sid, "mode" to mode)
    /** Changes model from the next turn; blank goes back to the default model. */
    fun setModel(sid: String, model: String) = fire("model", "sid" to sid, "model" to model.ifBlank { null })
    /** Changes effort from the next turn; blank goes back to the model's default. */
    fun setEffort(sid: String, effort: String) = fire("effort", "sid" to sid, "effort" to effort.ifBlank { null })
    fun stop(sid: String) = fire("stop", "sid" to sid)
    fun archive(sid: String) = fire("archive", "sid" to sid)
    fun refreshRepos() = fire("repos")

    fun answer(approval: Approval, allow: Boolean, always: Boolean = false) {
        _approvals.update { list -> list.filterNot { it.requestId == approval.requestId } }
        fire("permission", "sid" to approval.sid, "requestId" to approval.requestId,
            "decision" to if (allow) "allow" else "deny", "always" to always)
    }

    /** Answers Claude's questions: {question text: chosen label(s), or the user's own words}; null skips them. */
    fun answerQuestions(approval: Approval, answers: Map<String, String>?) {
        _approvals.update { list -> list.filterNot { it.requestId == approval.requestId } }
        fire("permission", "sid" to approval.sid, "requestId" to approval.requestId, "decision" to "allow",
            "answers" to answers?.let { JsonObject(it.mapValues { (_, v) -> JsonPrimitive(v) }) })
    }

    fun loadDiff(sid: String) {
        _diffs.update { it + (sid to (it[sid] ?: DiffState()).copy(loading = true)) }
        scope.launch {
            val reply = request("diff", "sid" to sid)
            val files = reply?.str("diff")?.let(DiffParser::parse).orEmpty()
            _diffs.update {
                it + (sid to DiffState(false, files, reply?.bool("truncated") == true, reply?.str("branch")))
            }
        }
    }

    // ---- wire ----

    private fun fire(op: String, vararg fields: Pair<String, Any?>) {
        scope.launch {
            if (!send(op, *fields)) _errors.tryEmit("Not connected to the bridge.")
        }
    }

    private suspend fun send(op: String, vararg fields: Pair<String, Any?>): Boolean {
        val map = mutableMapOf<String, JsonElement>("op" to JsonPrimitive(op))
        for ((k, v) in fields) when (v) {
            null -> {}
            is String -> map[k] = JsonPrimitive(v)
            is Number -> map[k] = JsonPrimitive(v)
            is Boolean -> map[k] = JsonPrimitive(v)
            is JsonElement -> map[k] = v
            else -> error("Unsupported field type for $k")
        }
        return client.send(JsonObject(map))
    }

    private suspend fun request(op: String, vararg fields: Pair<String, Any?>): JsonObject? =
        call(op, quiet = false, *fields)?.takeUnless { it.str("ev") == "error" }

    /**
     * Sends [op] and waits for the reply with its ref, or an error event with it. Unless [quiet],
     * errors also go to [errors]; a quiet caller shows them itself.
     */
    private suspend fun call(op: String, quiet: Boolean, vararg fields: Pair<String, Any?>): JsonObject? {
        val ref = nextRef++
        val deferred = CompletableDeferred<JsonObject?>()
        waiting[ref] = deferred
        if (quiet) quietRefs += ref
        if (!send(op, *fields, "ref" to ref)) {
            waiting.remove(ref)
            quietRefs -= ref
            _errors.tryEmit("Not connected to the bridge.")
            return null
        }
        return withTimeoutOrNull(20_000) { deferred.await() }.also { waiting.remove(ref); quietRefs -= ref }
    }

    private fun attachmentsJson(list: List<PendingAttachment>): JsonArray? = list.takeIf { it.isNotEmpty() }?.let {
        JsonArray(it.map { a -> JsonObject(mapOf("name" to JsonPrimitive(a.name), "mime" to JsonPrimitive(a.mime), "data" to JsonPrimitive(a.base64))) })
    }

    private fun onEvent(ev: JsonObject) {
        val ref = (ev["ref"] as? JsonPrimitive)?.content?.toIntOrNull()
        when (ev.str("ev")) {
            "hello" -> {
                _roots.value = ev.arr("roots").orEmpty().mapNotNull { (it as? JsonPrimitive)?.content }
            }
            "sessions" -> _sessions.value = json.decodeFromJsonElement(ListSerializer(SessionSummary.serializer()), ev["sessions"]!!)
                .sortedByDescending { it.updatedAt }
            "session" -> ev.obj("session")?.let {
                val s = json.decodeFromJsonElement(SessionSummary.serializer(), it)
                upsertSession(s)
                if (s.pending == 0) _approvals.update { list -> list.filterNot { a -> a.sid == s.id } }
            }
            "removed" -> ev.str("sid")?.let { sid ->
                _sessions.update { list -> list.filterNot { it.id == sid } }
                _approvals.update { list -> list.filterNot { it.sid == sid } }
                transcripts.remove(sid)
                _items.update { it - sid }
            }
            "claude_sessions" -> _claudeSessions.value =
                json.decodeFromJsonElement(ListSerializer(ClaudeSession.serializer()), ev["sessions"]!!)
            "term_output", "term_exit", "term_link" -> { _terminal.tryEmit(ev); return }
            "voice" -> { voice.onEvent(ev); return }
            "limits" -> ev.obj("limits")?.let {
                _limits.value = json.decodeFromJsonElement(Limits.serializer(), it)
                _usageTick.value = System.currentTimeMillis()
            }
            "usage_tick" -> {
                _usageTick.value = System.currentTimeMillis()
            }
            "repos" -> _repos.value = json.decodeFromJsonElement(ListSerializer(Repo.serializer()), ev["repos"]!!)
            "history" -> {
                val sid = ev.str("sid") ?: return
                val transcript = Transcript(sid, titleOf(sid))
                transcript.applyAll(ev.arr("events").orEmpty().mapNotNull { it as? JsonObject })
                transcripts[sid] = transcript
                _items.update { it + (sid to transcript.snapshot()) }
            }
            "cli" -> {
                val sid = ev.str("sid") ?: return
                val transcript = transcripts[sid] ?: return
                val msg = ev.obj("msg") ?: return
                transcript.apply(msg)
                if (msg.str("type") == "control_cancel_request") {
                    _approvals.update { list -> list.filterNot { it.requestId == msg.str("request_id") } }
                }
                if (msg.str("type") == "result" || msg.obj("message")?.obj("usage") != null) {
                    _usageTick.value = System.currentTimeMillis()
                }
                _items.update { it + (sid to transcript.snapshot()) }
            }
            "approval" -> {
                val sid = ev.str("sid") ?: return
                val approval = approvalFrom(sid, ev.str("title") ?: titleOf(sid), ev.obj("request") ?: return) ?: return
                _approvals.update { list -> if (list.any { it.requestId == approval.requestId }) list else list + approval }
            }
            "approval_done" -> _approvals.update { list -> list.filterNot { it.requestId == ev.str("requestId") } }
            "error" -> {
                val message = ev.str("message") ?: "Bridge error"
                val quiet = ref != null && quietRefs.remove(ref)
                if (ref != null) waiting.remove(ref)?.complete(ev)
                if (message != "Unauthorized" && !quiet) _errors.tryEmit(message)
                return
            }
        }
        if (ref != null) waiting.remove(ref)?.complete(ev)
    }

    private fun upsertSession(s: SessionSummary) = _sessions.update { list ->
        (list.filterNot { it.id == s.id } + s).sortedByDescending { it.updatedAt }
    }

    private fun titleOf(sid: String) = _sessions.value.firstOrNull { it.id == sid }?.title ?: "Task"
}
