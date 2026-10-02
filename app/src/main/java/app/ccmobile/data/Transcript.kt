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

    fun snapshot(): List<Item> = items.toList()

    fun applyAll(messages: List<JsonObject>) = messages.forEach(::apply)

    fun apply(msg: JsonObject) {
        // Sub-agent traffic would bury the main conversation; the Task tool row stands in for it.
        val parent = msg["parent_tool_use_id"]
        if (parent != null && parent !is JsonNull) return

        when (msg.str("type")) {
            "stream_event" -> onStreamEvent(msg.obj("event") ?: return)
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
                val error = msg.bool("is_error") == true
                val seconds = (msg.num("duration_ms") ?: 0.0) / 1000
                val cost = msg.num("total_cost_usd")
                val text = if (error) {
                    "Stopped: " + (msg.str("result") ?: msg.str("subtype") ?: "error")
                } else {
                    listOfNotNull(
                        "Done",
                        if (seconds > 0) "%.0fs".format(seconds) else null,
                        cost?.takeIf { it > 0 }?.let { "$%.2f".format(it) },
                    ).joinToString(" · ")
                }
                add(TurnEndItem(nextKey(), text, error))
            }
        }
    }

    private fun onStreamEvent(event: JsonObject) {
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
        val content = msg.obj("message")?.arr("content") ?: return
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
        when (val content = msg.obj("message")?.get("content")) {
            is JsonPrimitive -> add(UserItem(nextKey(), content.content, attachmentNames(msg)))
            is kotlinx.serialization.json.JsonArray -> for (block in content) {
                block as? JsonObject ?: continue
                when (block.str("type")) {
                    "text" -> add(UserItem(nextKey(), block.str("text").orEmpty()))
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
    }
}
