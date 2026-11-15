package app.ccmobile.data

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

sealed interface Item {
    val key: String
}

data class UserItem(override val key: String, val text: String, val attachments: List<String> = emptyList()) : Item
data class AssistantItem(override val key: String, val text: String, val streaming: Boolean = false) : Item
enum class ToolState { Running, Done, Failed }

/** An image a tool returned; [ref] fetches it from the bridge, null if the bridge didn't keep it. */
data class ImageRef(val ref: String?, val mime: String)

data class ToolItem(
    override val key: String,
    val name: String,
    val summary: String,
    val delta: Pair<Int, Int>?,
    val state: ToolState = ToolState.Running,
    val output: String? = null,
    val images: List<ImageRef> = emptyList(),
) : Item

/** [decision] is null while waiting, else "allow", "deny" or "cancelled". */
data class PermissionItem(override val key: String, val approval: Approval, val decision: String? = null) : Item
data class NoteItem(override val key: String, val text: String, val error: Boolean = false) : Item
data class TurnEndItem(override val key: String, val text: String, val error: Boolean) : Item

/**
 * Folds Claude Code stream-json messages (plus the bridge's own `type: "bridge"` messages)
 * into a list of UI items. Not thread-safe: call from one thread.
 */
class Transcript(private val sid: String, private val title: String) {
    private val items = mutableListOf<Item>()
    private val live = StringBuilder()
    private var counter = 0
    private var lastCost = 0.0 // the session's running total at the previous result
    private var turnInput = 0L
    private var turnOutput = 0L

    fun snapshot(): List<Item> = items.toList()

    fun applyAll(messages: List<JsonObject>) = messages.forEach(::apply)

    fun apply(msg: JsonObject) {
        // Sub-agent traffic would bury the main conversation; the Task tool row stands in for it.
        val parent = msg["parent_tool_use_id"]
        if (parent != null && parent !is JsonNull) return

        when (msg.str("type")) {
            "stream_event" -> onStreamEvent(msg)
            "assistant" -> onAssistant(msg)
            "user" -> onUser(msg)
            "control_request" -> approvalFrom(sid, title, msg)?.let { add(PermissionItem(it.requestId, it)) }
            "control_cancel_request" -> msg.str("request_id")?.let { decide(it, "cancelled") }
            "bridge" -> when (msg.str("subtype")) {
                "permission_answer" -> msg.str("request_id")?.let { decide(it, msg.str("decision") ?: "allow") }
                "error" -> add(NoteItem(nextKey(), msg.str("message") ?: "Error", error = true))
                "note" -> msg.str("message")?.let { add(NoteItem(nextKey(), it)) }
            }
            "system" -> when (msg.str("subtype")) {
                "init" -> if (items.none { it is NoteItem && it.key.startsWith("init") }) {
                    add(NoteItem("init-${counter++}", listOfNotNull("Session started", msg.str("model")).joinToString(" · ")))
                }
                "compact_boundary" -> add(NoteItem(nextKey(), "Conversation compacted"))
            }
            "result" -> {
                dropLive()
                val raw = (msg.str("result") ?: msg.str("subtype") ?: "error").trim()
                val hasRunningTool = items.any { it is ToolItem && it.state == ToolState.Running }
                val endedWithAssistant = items.lastOrNull() is AssistantItem && !hasRunningTool
                val recoveredTransientError = endedWithAssistant && isTransientTurnError(raw)
                val error = (msg.bool("is_error") == true) && !recoveredTransientError
                for (i in items.indices) {
                    val item = items[i]
                    if (item is ToolItem && item.state == ToolState.Running) {
                        items[i] = item.copy(state = if (error) ToolState.Failed else ToolState.Done)
                    }
                }
                val seconds = (msg.num("duration_ms") ?: 0.0) / 1000
                // total_cost_usd is the session's running total; show what this turn added.
                val total = msg.num("total_cost_usd") ?: 0.0
                val cost = if (total >= lastCost) total - lastCost else total
                if (total > 0) lastCost = total
                val resUsage = msg.obj("usage")
                val resOut = resUsage?.let { ((it.num("output_tokens") ?: 0.0) + (it.num("thinking_tokens") ?: 0.0)).toLong() } ?: 0L
                val resIn = resUsage?.let { ((it.num("input_tokens") ?: 0.0) + (it.num("cache_read_input_tokens") ?: it.num("cache_read_tokens") ?: 0.0)).toLong() } ?: 0L
                val outTokens = turnOutput.takeIf { it > 0 } ?: resOut
                val inTokens = turnInput.takeIf { it > 0 } ?: resIn
                turnOutput = 0L
                turnInput = 0L
                val tokenSummary = listOfNotNull(
                    outTokens.takeIf { it > 0 }?.let { "${UsageText.compact(it)} out" },
                    inTokens.takeIf { it > 0 }?.let { "${UsageText.compact(it)} in" },
                ).joinToString(" · ").takeIf { it.isNotEmpty() }
                val text = if (error) {
                    formatTurnError(raw)
                } else {
                    listOfNotNull(
                        "Done",
                        if (seconds > 0 && seconds < 3600) "%.0fs".format(seconds) else null,
                        cost.takeIf { it >= 0.005 }?.let { "$%.2f".format(it) } ?: tokenSummary,
                    ).joinToString(" · ")
                }
                add(TurnEndItem(nextKey(), text, error))
            }
        }
    }

    private fun onStreamEvent(msg: JsonObject) {
        val directDelta = msg.str("text_delta")
        if (directDelta != null) {
            live.append(directDelta)
            upsert(AssistantItem(LIVE_KEY, live.toString(), streaming = true))
            return
        }
        val event = msg.obj("event") ?: return
        when (event.str("type")) {
            "message_start" -> live.clear()
            "content_block_delta" -> {
                val delta = event.obj("delta") ?: return
                if (delta.str("type") == "text_delta") {
                    live.append(delta.str("text").orEmpty())
                    upsert(AssistantItem(LIVE_KEY, live.toString(), streaming = true))
                }
            }
        }
    }

    private fun onAssistant(msg: JsonObject) {
        val message = msg.obj("message") ?: return
        message.obj("usage")?.let { u ->
            val inp = (u.num("input_tokens") ?: 0.0).toLong()
            val cache = (u.num("cache_read_input_tokens") ?: u.num("cache_read_tokens") ?: 0.0).toLong()
            val out = (u.num("output_tokens") ?: 0.0).toLong() + (u.num("thinking_tokens") ?: 0.0).toLong()
            turnInput += inp + cache
            turnOutput += out
        }
        val content = message.arr("content") ?: return
        for (block in content) {
            block as? JsonObject ?: continue
            when (block.str("type")) {
                "text" -> {
                    dropLive()
                    val text = block.str("text").orEmpty()
                    if (text.isNotBlank()) add(AssistantItem(nextKey(), text))
                }
                "tool_use" -> {
                    dropLive()
                    val name = block.str("name") ?: "Tool"
                    val input = block.obj("input") ?: JsonObject(emptyMap())
                    add(ToolItem(block.str("id") ?: nextKey(), name, ToolText.summary(name, input), ToolText.lineDelta(name, input)))
                }
            }
        }
    }

    private fun onUser(msg: JsonObject) {
        // Notes Claude Code adds for the model (an image's size, say), not the user's words.
        if (msg.bool("isSynthetic") == true) return
        when (val content = msg.obj("message")?.get("content")) {
            is JsonPrimitive -> {
                turnInput = 0L; turnOutput = 0L
                add(UserItem(nextKey(), content.content, attachmentNames(msg)))
            }
            is kotlinx.serialization.json.JsonArray -> for (block in content) {
                block as? JsonObject ?: continue
                when (block.str("type")) {
                    "text" -> {
                        turnInput = 0L; turnOutput = 0L
                        add(UserItem(nextKey(), block.str("text").orEmpty()))
                    }
                    "tool_result" -> {
                        val id = block.str("tool_use_id") ?: continue
                        val index = items.indexOfFirst { it.key == id }
                        val tool = items.getOrNull(index) as? ToolItem ?: continue
                        items[index] = tool.copy(
                            state = if (block.bool("is_error") == true) ToolState.Failed else ToolState.Done,
                            output = contentText(block["content"]).take(MAX_OUTPUT),
                            images = imagesIn(block["content"]),
                        )
                    }
                }
            }
            else -> {}
        }
    }

    /** Image placeholders in a tool_result's content (the bridge replaces the data with a ref). */
    private fun imagesIn(content: kotlinx.serialization.json.JsonElement?): List<ImageRef> =
        (content as? kotlinx.serialization.json.JsonArray).orEmpty().mapNotNull { block ->
            (block as? JsonObject)?.takeIf { it.str("type") == "image" }?.let {
                ImageRef(it.str("ref"), it.obj("source")?.str("media_type") ?: "image/png")
            }
        }

    /** Names of files the bridge saved with this message (its `attachments` field). */
    private fun attachmentNames(msg: JsonObject) = msg.arr("attachments").orEmpty().mapNotNull { (it as? JsonObject)?.str("name") }

    private fun decide(requestId: String, decision: String) {
        val index = items.indexOfFirst { it.key == requestId }
        val item = items.getOrNull(index) as? PermissionItem ?: return
        if (item.decision == null) items[index] = item.copy(decision = decision)
    }

    private fun add(item: Item) {
        if (items.any { it.key == item.key }) upsert(item) else items.add(item)
    }

    private fun upsert(item: Item) {
        val index = items.indexOfFirst { it.key == item.key }
        if (index >= 0) items[index] = item else items.add(item)
    }

    private fun dropLive() {
        live.clear()
        items.removeAll { it.key == LIVE_KEY }
    }

    private fun nextKey() = "i${counter++}"

    companion object {
        const val LIVE_KEY = "live"
        private const val MAX_OUTPUT = 4000
        private val GO_HTTP_PREFIX = Regex(
            """^(?:API error \(attempt \d+\):\s*)?doRequest:\s*error sending request:\s*[A-Za-z]+\s+"[^"]+":\s*""",
            RegexOption.IGNORE_CASE,
        )
        private val ATTEMPT_PREFIX = Regex("""^API error \(attempt \d+\):\s*""", RegexOption.IGNORE_CASE)

        internal fun isTransientTurnError(raw: String): Boolean =
            ATTEMPT_PREFIX.containsMatchIn(raw) ||
                raw.contains("stream was interrupted", ignoreCase = true) ||
                raw.contains("Individual quota reached", ignoreCase = true)

        internal fun formatTurnError(raw: String): String {
            if (raw.contains("stream was interrupted", ignoreCase = true) ||
                raw.equals("interrupted", ignoreCase = true)
            ) {
                return "Stream interrupted"
            }
            if (raw.contains("timeout awaiting response headers", ignoreCase = true) ||
                raw.contains("context deadline exceeded", ignoreCase = true) ||
                raw.contains("Client.Timeout", ignoreCase = true) ||
                raw.contains("header timeout", ignoreCase = true)
            ) {
                return "Stopped: Timed out waiting for model response"
            }
            if (GO_HTTP_PREFIX.containsMatchIn(raw)) {
                val detail = raw.replace(GO_HTTP_PREFIX, "").trim()
                return if (detail.isNotEmpty()) {
                    "Stopped: Network error reaching model API ($detail)"
                } else {
                    "Stopped: Network error reaching model API"
                }
            }
            val cleaned = raw.replace(ATTEMPT_PREFIX, "").trim().ifEmpty { "error" }
            return "Stopped: $cleaned"
        }
    }
}
