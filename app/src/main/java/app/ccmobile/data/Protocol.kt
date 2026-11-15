package app.ccmobile.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

val json = Json { ignoreUnknownKeys = true }
private val prettyJson = Json { prettyPrint = true }

/** A session as the bridge summarises it (see Session.summary() in ccm-bridge.mjs). */
@Serializable
data class SessionSummary(
    val id: String,
    val cwd: String,
    val title: String,
    val model: String? = null,
    val effectiveModel: String? = null,
    /** Active billing source for this session: "sub" (Google subscription) or "api" (Gemini API). */
    val billing: String? = null,
    /** Reasoning effort (low…max), or null for the model's default. */
    val effort: String? = null,
    val mode: String = "default",
    val status: String = "idle",
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    val lastActivity: String = "",
    val pending: Int = 0,
    val costUsd: Double = 0.0,
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val thinkingTokens: Long = 0,
    val cacheReadTokens: Long = 0,
    val requests: Int = 0,
    val running: Boolean = false,
    /** Continue by itself once a usage limit resets. */
    val autoContinue: Boolean = false,
    /** When a task stopped by a usage limit can go on (status "limited"), epoch ms. */
    val resumeAt: Long? = null,
    /** Background jobs Claude is waiting on (it wakes up when each finishes). */
    val background: List<String> = emptyList(),
    /** TCP ports the task's processes listen on (a dev server, say). */
    val ports: List<Int> = emptyList(),
) {
    val isActive: Boolean get() = status == "working" || status == "needs_approval"
    /** Not finished: working, waiting for approval, paused by a usage limit, or running background work. */
    val isOpen: Boolean get() = isActive || status == "limited" || background.isNotEmpty()
    val repoName: String get() = cwd.trimEnd('/').substringAfterLast('/')
    val readTokens: Long get() = inputTokens + cacheReadTokens
}

/** A Claude Code session on the bridge's machine that the bridge isn't tracking yet (see listCliSessions()). */
@Serializable
data class ClaudeSession(
    val id: String,
    val cwd: String,
    val title: String,
    val lastPrompt: String = "",
    val model: String? = null,
    val updatedAt: Long = 0,
) {
    val repoName: String get() = cwd.trimEnd('/').substringAfterLast('/')
}

/** One plan-limit window from the CLI's rate_limit_event or quota API. */
@Serializable
data class LimitWindow(
    val id: String,
    val utilization: Double,
    val resetsAt: Long = 0,
    val disabled: Boolean = false,
    val description: String? = null,
)

/** The account's plan limits as of Claude's last reply through the bridge. */
@Serializable
data class Limits(val status: String = "allowed", val windows: List<LimitWindow> = emptyList(), val updatedAt: Long = 0)

@Serializable
data class DayUsage(
    val date: String,
    val input: Long = 0,
    val output: Long = 0,
    val thinking: Long = 0,
    val cacheRead: Long = 0,
    val cacheWrite: Long = 0,
    val requests: Int = 0,
    val apiInput: Long = 0,
    val apiOutput: Long = 0,
    val apiRequests: Int = 0,
    val apiCostUsd: Double = 0.0,
) {
    /** Everything Claude read: fresh input plus cache reads and writes. */
    val read: Long get() = input + cacheRead + cacheWrite
}

/** Tokens for one model or project; [input] includes cache reads and writes. */
@Serializable
data class UsageShare(val key: String, val output: Long = 0, val input: Long = 0, val requests: Int = 0)

/** Token use from Claude Code's transcripts on the bridge's machine (see usageSummary()). */
@Serializable
data class Usage(
    val days: List<DayUsage> = emptyList(),
    val models: List<UsageShare> = emptyList(),
    val projects: List<UsageShare> = emptyList(),
    val sessions: Int = 0,
    val dailyApiLimitUsd: Double = 0.0,
    val todayApiCostUsd: Double = 0.0,
)

/** A process running as the bridge's user (see listProcesses() in ccm-bridge.mjs). */
@Serializable
data class ProcInfo(
    val pid: Int,
    val ppid: Int = 0,
    val name: String,
    val args: List<String> = emptyList(),
    val cwd: String? = null,
    /** Linux state letter: R running, S sleeping, T stopped (paused), Z zombie. */
    val state: String = "S",
    val startedAt: Long = 0,
    val cpuSeconds: Double = 0.0,
    /** CPU use since the previous listing, in percent of one core; null on the first listing. */
    val cpu: Double? = null,
    val rssKb: Long = 0,
    /** bridge, keeper, claude, job (started by a task's Claude) or other. */
    val role: String = "other",
    val sid: String? = null,
    /** A job that left its task's process tree (nohup/setsid), found by its environment. */
    val detached: Boolean = false,
    /** Its command can be run again (false for programs that rename themselves, like npm). */
    val restartable: Boolean = false,
) {
    val paused: Boolean get() = state == "T" || state == "t"
}

/** `claude auth status` on the bridge: who Claude Code is signed in as there. */
@Serializable
data class AuthStatus(
    val loggedIn: Boolean = false,
    val authMethod: String? = null,
    val email: String? = null,
    val orgName: String? = null,
    val subscriptionType: String? = null,
    val provider: String? = null,
    val hasGeminiKey: Boolean = false,
    val maskedGeminiKey: String? = null,
    val dailyApiLimitUsd: Double = 0.0,
    val todayApiUsd: Double = 0.0,
)

/** A sign-in page from `claude auth login`. local: it only finishes in a browser on the bridge's machine. */
@Serializable
data class TermLink(val url: String, val local: Boolean)

/** A terminal the bridge opened: its id, recent output (base64) and, for a login, its sign-in pages. */
data class TermOpened(val id: String, val replay: String, val links: List<TermLink>)

@Serializable
data class Repo(val path: String, val name: String, val branch: String? = null)

/** One of Claude's questions (AskUserQuestion) and its choices. */
data class Question(val question: String, val header: String, val multiSelect: Boolean, val options: List<QuestionOption>)
data class QuestionOption(val label: String, val description: String)

/** A pending `can_use_tool` request from Claude Code, waiting for the user. */
data class Approval(
    val sid: String,
    val sessionTitle: String,
    val requestId: String,
    val toolName: String,
    val summary: String,
    val detail: String,
    val canAlways: Boolean,
    /** Set when Claude is asking (AskUserQuestion): answered by choosing, not by allowing. */
    val questions: List<Question> = emptyList(),
)

fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject
fun JsonObject.arr(key: String): JsonArray? = this[key] as? JsonArray
fun JsonObject.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.booleanOrNull
fun JsonObject.num(key: String): Double? = (this[key] as? JsonPrimitive)?.doubleOrNull

/** Builds an [Approval] from a stream-json `control_request` message, or null if it isn't a permission prompt. */
fun approvalFrom(sid: String, sessionTitle: String, message: JsonObject): Approval? {
    val request = message.obj("request") ?: return null
    if (request.str("subtype") != "can_use_tool") return null
    val requestId = message.str("request_id") ?: return null
    val tool = request.str("tool_name") ?: "Tool"
    val input = request.obj("input") ?: JsonObject(emptyMap())
    val canAlways = request.arr("permission_suggestions")
        ?.any { (it as? JsonObject)?.str("type") == "addRules" } == true
    return Approval(
        sid = sid,
        sessionTitle = sessionTitle,
        requestId = requestId,
        toolName = request.str("display_name") ?: tool,
        summary = ToolText.summary(tool, input),
        detail = ToolText.detail(tool, input),
        canAlways = canAlways,
        questions = if (tool == "AskUserQuestion" || tool == "ask_question") questionsIn(input) else emptyList(),
    )
}

private fun questionsIn(input: JsonObject): List<Question> = input.arr("questions").orEmpty().mapNotNull { q ->
    (q as? JsonObject)?.let {
        Question(
            question = it.str("question") ?: return@let null,
            header = it.str("header").orEmpty(),
            multiSelect = it.bool("multiSelect") == true || it.bool("is_multi_select") == true,
            options = it.arr("options").orEmpty().mapNotNull { o ->
                when (o) {
                    is JsonPrimitive -> o.takeIf { p -> p.isString }?.content?.let { label -> QuestionOption(label, "") }
                    is JsonObject -> o.str("label")?.let { label -> QuestionOption(label, o.str("description").orEmpty()) }
                    else -> null
                }
            },
        )
    }
}

/** Short, human-readable descriptions of tool calls. */
object ToolText {
    fun summary(name: String, input: JsonObject): String {
        val raw = when (name) {
            "Bash", "run_command" -> input.str("CommandLine") ?: input.str("command") ?: input.str("toolSummary")
            "Read", "Write", "Edit", "MultiEdit", "NotebookEdit",
            "read_file", "write_file", "edit_file",
            "view_file", "write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file" ->
                (input.str("Path") ?: input.str("TargetFile") ?: input.str("AbsolutePath") ?: input.str("file_path") ?: input.str("notebook_path"))?.let(::shortPath)
            "Grep", "Glob", "grep_search", "find_by_name" ->
                (input.str("Query") ?: input.str("Pattern") ?: input.str("pattern"))?.let { "\"$it\"" }
            "LS", "list_dir" -> (input.str("DirectoryPath") ?: input.str("path"))?.let(::shortPath)
            "WebFetch", "read_url_content", "open_browser_url", "read_browser_page" -> input.str("Url") ?: input.str("url")
            "WebSearch", "search_web" -> input.str("query")
            "Task", "Agent", "invoke_subagent", "browser_subagent", "define_subagent", "manage_subagents" ->
                input.arr("Subagents")?.firstOrNull()?.let { (it as? JsonObject)?.let { s -> s.str("Role") ?: s.str("TypeName") ?: s.str("role") ?: s.str("type_name") } }
                    ?: input.str("Role") ?: input.str("TaskName") ?: input.str("Name") ?: input.str("toolSummary") ?: input.str("description") ?: input.str("Action")
            "manage_task" -> listOfNotNull(input.str("Action"), input.str("TaskId")).joinToString(" ").ifBlank { null }
            "schedule" -> input.str("Prompt") ?: input.str("CronExpression")
            "swarm" -> listOfNotNull(input.str("action"), input.str("name") ?: input.str("title")).joinToString(" ").ifBlank { null }
            "send_message" -> input.str("Recipient")
            "ask_question", "AskUserQuestion" ->
                input.arr("questions")?.firstOrNull()?.let { (it as? JsonObject)?.str("question") } ?: input.str("toolSummary")
            "ExitPlanMode" -> "Plan ready for review"
            else -> input.str("toolSummary") ?: input.str("toolAction")
                ?: input.values.firstNotNullOfOrNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
        }
        return raw?.lineSequence()?.firstOrNull()?.take(200).orEmpty()
    }

    fun detail(name: String, input: JsonObject): String = when (name) {
        "Bash", "run_command" -> (input.str("CommandLine") ?: input.str("command")).orEmpty()
        "ExitPlanMode" -> input.str("plan").orEmpty()
        "Edit", "edit_file", "replace_file_content" -> buildString {
            append((input.str("Path") ?: input.str("TargetFile") ?: input.str("file_path")).orEmpty())
            (input.str("Target") ?: input.str("TargetContent") ?: input.str("old_string"))?.lines()?.forEach { append("\n− ").append(it) }
            (input.str("Replacement") ?: input.str("ReplacementContent") ?: input.str("new_string"))?.lines()?.forEach { append("\n+ ").append(it) }
        }
        "multi_replace_file_content" -> buildString {
            append(input.str("TargetFile").orEmpty())
            input.arr("ReplacementChunks").orEmpty().forEach { chunk ->
                val c = chunk as? JsonObject ?: return@forEach
                c.str("TargetContent")?.lines()?.forEach { append("\n− ").append(it) }
                c.str("ReplacementContent")?.lines()?.forEach { append("\n+ ").append(it) }
            }
        }
        "Write", "write_file", "write_to_file" -> (input.str("Path") ?: input.str("TargetFile") ?: input.str("file_path")).orEmpty() + "\n" +
            (input.str("Content") ?: input.str("CodeContent") ?: input.str("content")).orEmpty().take(4000)
        else -> prettyJson.encodeToString(JsonObject.serializer(), input)
    }

    /** Lines added and removed by an Edit or Write call, for the "+18 −4" badge. */
    fun lineDelta(name: String, input: JsonObject): Pair<Int, Int>? = when (name) {
        "Edit", "edit_file", "replace_file_content" ->
            lineCount(input.str("Replacement") ?: input.str("ReplacementContent") ?: input.str("new_string")) to
                lineCount(input.str("Target") ?: input.str("TargetContent") ?: input.str("old_string"))
        "multi_replace_file_content" -> {
            val chunks = input.arr("ReplacementChunks").orEmpty().mapNotNull { it as? JsonObject }
            if (chunks.isEmpty()) null
            else chunks.sumOf { lineCount(it.str("ReplacementContent")) } to chunks.sumOf { lineCount(it.str("TargetContent")) }
        }
        "Write", "write_file", "write_to_file" -> lineCount(input.str("Content") ?: input.str("CodeContent") ?: input.str("content")) to 0
        else -> null
    }

    fun shortPath(path: String): String = path.trimEnd('/').split('/').takeLast(2).joinToString("/")

    private fun lineCount(s: String?): Int = if (s.isNullOrEmpty()) 0 else s.trimEnd('\n').count { it == '\n' } + 1
}

/** Text of a tool_result's content, which is either a string or a list of content blocks. */
fun contentText(content: JsonElement?): String = when (content) {
    is JsonPrimitive -> content.content
    is JsonArray -> content.mapNotNull { (it as? JsonObject)?.str("text") }.joinToString("\n")
    else -> ""
}
