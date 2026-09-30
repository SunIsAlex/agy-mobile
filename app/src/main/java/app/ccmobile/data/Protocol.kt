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
    val mode: String = "default",
    val status: String = "idle",
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    val lastActivity: String = "",
    val pending: Int = 0,
    val costUsd: Double = 0.0,
    val running: Boolean = false,
    /** Phone use: Claude can see and operate the phone the bridge runs on. */
    val phone: Boolean = false,
) {
    val isActive: Boolean get() = status == "working" || status == "needs_approval"
    val repoName: String get() = cwd.trimEnd('/').substringAfterLast('/')
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

@Serializable
data class Repo(val path: String, val name: String, val branch: String? = null)

/** A pending `can_use_tool` request from Claude Code, waiting for the user. */
data class Approval(
    val sid: String,
    val sessionTitle: String,
    val requestId: String,
    val toolName: String,
    val summary: String,
    val detail: String,
    val canAlways: Boolean,
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
    )
}

/** Short, human-readable descriptions of tool calls. */
object ToolText {
    fun summary(name: String, input: JsonObject): String {
        val raw = when (name) {
            "Bash" -> input.str("command")
            "Read", "Write", "Edit", "MultiEdit", "NotebookEdit" -> (input.str("file_path") ?: input.str("notebook_path"))?.let(::shortPath)
            "Grep", "Glob" -> input.str("pattern")?.let { "\"$it\"" }
            "WebFetch" -> input.str("url")
            "WebSearch" -> input.str("query")
            "Task", "Agent" -> input.str("description")
            "ExitPlanMode" -> "Plan ready for review"
            else -> input.values.firstNotNullOfOrNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
        }
        return raw?.lineSequence()?.firstOrNull()?.take(200).orEmpty()
    }

    fun detail(name: String, input: JsonObject): String = when (name) {
        "Bash" -> input.str("command").orEmpty()
        "ExitPlanMode" -> input.str("plan").orEmpty()
        "Edit" -> buildString {
            append(input.str("file_path").orEmpty())
            input.str("old_string")?.lines()?.forEach { append("\n− ").append(it) }
            input.str("new_string")?.lines()?.forEach { append("\n+ ").append(it) }
        }
        "Write" -> input.str("file_path").orEmpty() + "\n" + input.str("content").orEmpty().take(4000)
        else -> prettyJson.encodeToString(JsonObject.serializer(), input)
    }

    /** Lines added and removed by an Edit or Write call, for the "+18 −4" badge. */
    fun lineDelta(name: String, input: JsonObject): Pair<Int, Int>? = when (name) {
        "Edit" -> lineCount(input.str("new_string")) to lineCount(input.str("old_string"))
        "Write" -> lineCount(input.str("content")) to 0
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
