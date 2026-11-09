package app.ccmobile.data

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TranscriptTest {
    private fun msg(s: String): JsonObject = json.parseToJsonElement(s).jsonObject

    // Shapes captured from `claude -p --output-format stream-json --permission-prompt-tool stdio`.
    private val flow = listOf(
        """{"type":"user","message":{"role":"user","content":"Create probe.txt"},"local":true}""",
        """{"type":"system","subtype":"init","model":"claude-haiku-4-5","cwd":"/r","permissionMode":"default","session_id":"s"}""",
        """{"type":"stream_event","event":{"type":"message_start"},"parent_tool_use_id":null}""",
        """{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I'll "}},"parent_tool_use_id":null}""",
        """{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"create it."}},"parent_tool_use_id":null}""",
        """{"type":"assistant","message":{"content":[{"type":"thinking","thinking":""}]},"parent_tool_use_id":null}""",
        """{"type":"assistant","message":{"content":[{"type":"text","text":"I'll create it."}]},"parent_tool_use_id":null}""",
        """{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"touch probe.txt","description":"Create"}}]},"parent_tool_use_id":null}""",
        """{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash","input":{"command":"touch probe.txt"},"permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"touch probe.txt"}],"behavior":"allow","destination":"localSettings"}]}}""",
    )

    @Test
    fun streamsTextThenReplacesItWithTheFinalMessage() {
        val t = Transcript("s", "Task")
        flow.take(5).forEach { t.apply(msg(it)) }
        val live = t.snapshot().last() as AssistantItem
        assertEquals("I'll create it.", live.text)
        assertTrue(live.streaming)

        flow.drop(5).take(2).forEach { t.apply(msg(it)) }
        val items = t.snapshot()
        assertEquals(listOf(UserItem::class, NoteItem::class, AssistantItem::class), items.map { it::class })
        assertEquals(false, (items.last() as AssistantItem).streaming)
    }

    @Test
    fun permissionAndToolLifecycle() {
        val t = Transcript("s", "Task")
        flow.forEach { t.apply(msg(it)) }
        val tool = t.snapshot().filterIsInstance<ToolItem>().single()
        assertEquals("touch probe.txt", tool.summary)
        assertEquals(ToolState.Running, tool.state)

        val perm = t.snapshot().filterIsInstance<PermissionItem>().single()
        assertNull(perm.decision)
        assertTrue(perm.approval.canAlways)
        assertEquals("touch probe.txt", perm.approval.detail)

        t.apply(msg("""{"type":"bridge","subtype":"permission_answer","request_id":"req-1","decision":"allow","always":false}"""))
        t.apply(msg("""{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"(Bash completed with no output)","is_error":false}]},"parent_tool_use_id":null}"""))
        t.apply(msg("""{"type":"result","subtype":"success","is_error":false,"duration_ms":3597,"total_cost_usd":0.0200487,"result":"Done."}"""))

        val items = t.snapshot()
        assertEquals("allow", items.filterIsInstance<PermissionItem>().single().decision)
        assertEquals(ToolState.Done, items.filterIsInstance<ToolItem>().single().state)
        assertEquals("Done · 4s · $0.02", (items.last() as TurnEndItem).text)
    }

    @Test
    fun subagentMessagesAreSkipped() {
        val t = Transcript("s", "Task")
        t.apply(msg("""{"type":"assistant","message":{"content":[{"type":"text","text":"inner"}]},"parent_tool_use_id":"toolu_9"}"""))
        assertTrue(t.snapshot().isEmpty())
    }

    @Test
    fun editShowsLineDelta() {
        val t = Transcript("s", "Task")
        t.apply(msg("""{"type":"assistant","message":{"content":[{"type":"tool_use","id":"e1","name":"Edit","input":{"file_path":"/r/app/src/Main.kt","old_string":"a\nb","new_string":"a\nb\nc"}}]}}"""))
        val tool = t.snapshot().single() as ToolItem
        assertEquals("src/Main.kt", tool.summary)
        assertEquals(3 to 2, tool.delta)
    }

    @Test
    fun importedClaudeCodeHistory() {
        // What the bridge replays for a session resumed from ~/.claude/projects (see cliRecordToEvent).
        val t = Transcript("s", "Task")
        listOf(
            """{"type":"user","message":{"role":"user","content":"add a README"},"uuid":"u1","parent_tool_use_id":null}""",
            """{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"/r/README.md","content":"x"}}]},"uuid":"a1","parent_tool_use_id":null}""",
            """{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]},"uuid":"u2","parent_tool_use_id":null}""",
            """{"type":"bridge","subtype":"note","message":"Resumed from Claude Code. New messages continue this session."}""",
        ).forEach { t.apply(msg(it)) }
        val items = t.snapshot()
        assertEquals(listOf(UserItem::class, ToolItem::class, NoteItem::class), items.map { it::class })
        assertEquals(ToolState.Done, (items[1] as ToolItem).state)
        assertEquals("Resumed from Claude Code. New messages continue this session.", (items[2] as NoteItem).text)
    }

    @Test
    fun showsAttachmentNamesTheBridgeSavedWithAMessage() {
        val t = Transcript("s", "Task")
        t.apply(msg("""{"type":"user","message":{"role":"user","content":""},"local":true,"attachments":[{"name":"shot.jpg","mime":"image/jpeg","size":9,"path":"/a/shot.jpg"},{"name":"log.txt","mime":"text/plain","size":2,"path":"/a/log.txt"}]}"""))
        assertEquals(UserItem("i0", "", listOf("shot.jpg", "log.txt")), t.snapshot().single())
    }

    @Test
    fun toolResultsKeepTheImagesTheyReturned() {
        val t = Transcript("s", "Task")
        t.apply(msg("""{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_9","name":"Read","input":{"file_path":"/r/frame.png"}}]}}"""))
        t.apply(msg("""{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_9","content":[{"type":"image","source":{"type":"base64","media_type":"image/png"},"omittedBytes":5,"ref":"0123456789abcdef0123456789abcdef.png"},{"type":"image","source":{"type":"base64","media_type":"image/jpeg"},"omittedBytes":5,"missing":true}]}]}}"""))
        val tool = t.snapshot().single() as ToolItem
        assertEquals(ToolState.Done, tool.state)
        assertEquals(listOf(ImageRef("0123456789abcdef0123456789abcdef.png", "image/png"), ImageRef(null, "image/jpeg")), tool.images)
    }

    @Test
    fun turnEndShowsWhatTheTurnCostNotTheRunningTotal() {
        val t = Transcript("s", "Task")
        t.apply(msg("""{"type":"result","subtype":"success","is_error":false,"duration_ms":2000,"total_cost_usd":11.40}"""))
        t.apply(msg("""{"type":"result","subtype":"success","is_error":false,"duration_ms":4000,"total_cost_usd":11.87}"""))
        val ends = t.snapshot().filterIsInstance<TurnEndItem>().map { it.text }
        assertEquals(listOf("Done · 2s · \$11.40", "Done · 4s · \$0.47"), ends)
    }

    @Test
    fun syntheticUserMessagesAreNotShownAsTheUsers() {
        val t = Transcript("s", "Task")
        t.apply(msg("""{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Image: original 1264x2780, displayed at 909x2000.]"}]},"isSynthetic":true}"""))
        t.apply(msg("""{"type":"user","message":{"role":"user","content":"Sorry for the typo."},"local":true}"""))
        assertEquals(listOf("Sorry for the typo."), t.snapshot().filterIsInstance<UserItem>().map { it.text })
    }

    @Test
    fun askUserQuestionRequestsCarryTheirQuestions() {
        val req = msg("""{"type":"control_request","request_id":"q-1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","display_name":"AskUserQuestion","input":{"questions":[{"question":"Which color?","header":"Color","multiSelect":false,"options":[{"label":"Red","description":"Warm"},{"label":"Blue","description":"Cool"}]}]}}}""")
        val a = approvalFrom("s", "Task", req)!!
        assertEquals(1, a.questions.size)
        assertEquals("Which color?", a.questions[0].question)
        assertEquals(listOf("Red" to "Warm", "Blue" to "Cool"), a.questions[0].options.map { it.label to it.description })
        assertEquals(false, a.questions[0].multiSelect)
    }

    @Test
    fun agyStreamEventsToolsAndQuestions() {
        val t = Transcript("s", "Task")
        t.apply(msg("""{"type":"stream_event","step_index":1,"text_delta":"Checking "}"""))
        t.apply(msg("""{"type":"stream_event","step_index":1,"text_delta":"files..."}"""))
        val live = t.snapshot().single() as AssistantItem
        assertEquals("Checking files...", live.text)
        assertTrue(live.streaming)

        t.apply(msg("""{"type":"assistant","message":{"content":[{"type":"text","text":"Checking files..."}]}}"""))
        t.apply(msg("""{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-2","name":"replace_file_content","input":{"TargetFile":"/r/app/Main.kt","TargetContent":"old","ReplacementContent":"new1\nnew2"}}]}}"""))
        val tool = t.snapshot().filterIsInstance<ToolItem>().single()
        assertEquals("app/Main.kt", tool.summary)
        assertEquals(2 to 1, tool.delta)

        val qReq = msg("""{"type":"control_request","request_id":"q-2","request":{"subtype":"can_use_tool","tool_name":"ask_question","input":{"questions":[{"question":"Pick targets","is_multi_select":true,"options":["Android","Chroot"]}]}}}""")
        val qa = approvalFrom("s", "Task", qReq)!!
        assertEquals(true, qa.questions[0].multiSelect)
        assertEquals(listOf("Android" to "", "Chroot" to ""), qa.questions[0].options.map { it.label to it.description })

        t.apply(msg("""{"type":"assistant","message":{"content":[],"usage":{"input_tokens":2000,"output_tokens":900,"thinking_tokens":300,"cache_read_input_tokens":10000}}}"""))
        t.apply(msg("""{"type":"result","subtype":"success","is_error":false,"duration_ms":3000,"total_cost_usd":0}"""))
        val end = t.snapshot().last() as TurnEndItem
        assertEquals("Done · 3s · 1.2k out · 12k in", end.text)
    }

    @Test
    fun streamInterruptedErrorFormatting() {
        val t = Transcript("s", "Task")
        t.apply(msg("""{"type":"result","subtype":"error","is_error":true,"result":"The stream was interrupted. Please continue the task you were working on."}"""))
        val end = t.snapshot().last() as TurnEndItem
        assertEquals("Stream interrupted", end.text)
        assertTrue(end.error)
    }
}
