package app.ccmobile.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import app.ccmobile.data.Question
import androidx.compose.runtime.mutableStateMapOf
import kotlinx.coroutines.launch
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.ccmobile.R
import app.ccmobile.data.Approval
import app.ccmobile.data.AssistantItem
import app.ccmobile.data.Item
import app.ccmobile.data.NoteItem
import app.ccmobile.data.PendingAttachment
import app.ccmobile.data.PermissionItem
import app.ccmobile.data.Repository
import app.ccmobile.data.SessionSummary
import app.ccmobile.data.ToolItem
import app.ccmobile.data.ToolState
import app.ccmobile.data.TurnEndItem
import app.ccmobile.data.UsageText
import app.ccmobile.data.UserItem
import app.ccmobile.data.VoiceInput

@Composable
fun SessionScreen(repository: Repository, sid: String, onBack: () -> Unit, onDiff: () -> Unit) {
    DisposableEffect(sid) {
        repository.open(sid)
        onDispose { repository.close(sid) }
    }
    val sessions by repository.sessions.collectAsStateWithLifecycle()
    val allItems by repository.items.collectAsStateWithLifecycle()
    val approvals by repository.approvals.collectAsStateWithLifecycle()
    val limits by repository.limits.collectAsStateWithLifecycle()
    val session = sessions.firstOrNull { it.id == sid }
    val items = allItems[sid]
    val approval = approvals.firstOrNull { it.sid == sid }
    val working = session?.status == "working"
    val loadImage: ImageLoader = remember(sid) { { ref -> repository.image(sid, ref) } }
    var viewing by remember { mutableStateOf<Pair<ToolItem, Int>?>(null) }

    val listState = rememberLazyListState()
    val atBottom by remember { derivedStateOf { !listState.canScrollForward } }
    val lastSize = (items?.lastOrNull() as? AssistantItem)?.text?.length ?: 0
    LaunchedEffect(items?.size, lastSize) {
        if (!items.isNullOrEmpty() && (atBottom || listState.firstVisibleItemIndex == 0)) listState.scrollToItem(items.size - 1, Int.MAX_VALUE / 2)
    }

    Column(Modifier.fillMaxSize().background(C.Bg).safeDrawingPadding().imePadding()) {
        Row(Modifier.padding(start = 4.dp, end = 4.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconBtn(R.drawable.ic_back, "Back to tasks", onBack)
            Column(Modifier.weight(1f)) {
                Text(session?.title ?: "Task", color = C.Text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                val activeModelBadge = when {
                    session?.billing == "api" && !session.effectiveModel.isNullOrBlank() -> "${modelLabel(session.effectiveModel)} (API)"
                    session?.billing == "api" -> "Gemini API"
                    else -> session?.model?.takeIf { it.isNotBlank() }?.let(::modelLabel)
                }
                Text(
                    listOfNotNull(
                        session?.let { statusStyle(it.status).label },
                        session?.repoName,
                        activeModelBadge,
                        session?.effort?.let { "${effortLabel(it)} effort" },
                    ).joinToString(" · "),
                    color = C.Muted, fontSize = 12.sp, fontFamily = Mono, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                val modelWindow = remember(session?.model, limits) {
                    limits?.windows?.let { UsageText.windowForModel(session?.model, it) }
                }
                val usageLine = remember(session?.outputTokens, session?.readTokens, session?.costUsd, session?.billing, modelWindow) {
                    buildList {
                        if ((session?.costUsd ?: 0.0) > 0) add("${UsageText.formatUsd(session!!.costUsd)} API")
                        if ((session?.outputTokens ?: 0L) > 0 || (session?.readTokens ?: 0L) > 0) {
                            add("${UsageText.compact(session?.outputTokens ?: 0L)} out")
                            if ((session?.readTokens ?: 0L) > 0) add("${UsageText.compact(session!!.readTokens)} in")
                        }
                        if (modelWindow != null && session?.billing != "api") {
                            add("${UsageText.percent(modelWindow.utilization)} quota")
                        }
                    }.joinToString(" · ")
                }
                if (usageLine.isNotEmpty()) {
                    val quotaTone = when {
                        session?.billing == "api" -> C.Muted
                        modelWindow != null && (modelWindow.utilization >= 1.0 || modelWindow.disabled) -> C.Red
                        modelWindow != null && modelWindow.utilization >= 0.8 -> C.Amber
                        else -> C.Muted
                    }
                    Text(usageLine, color = quotaTone, fontSize = 11.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                val modeText = when (session?.mode) {
                    YOLO -> "YOLO · runs without asking"
                    "fast", "acceptEdits" -> "Fast mode"
                    "plan" -> "Planning mode"
                    "default" -> "Ask first"
                    else -> null
                }
                if (modeText != null) {
                    Text(modeText, color = if (session?.mode == YOLO) C.Red else C.Muted, fontSize = 12.sp, fontFamily = Mono, maxLines = 1)
                }
                session?.background?.takeIf { it.isNotEmpty() }?.let { jobs ->
                    Text(
                        "In the background: ${jobs.joinToString(", ")}", color = C.TextSoft, fontSize = 12.sp, fontFamily = Mono,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            if (working) IconBtn(R.drawable.ic_stop, "Interrupt AGY", { repository.interrupt(sid) })
            var menu by remember { mutableStateOf(false) }
            var modeMenu by remember { mutableStateOf(false) }
            var modelMenu by remember { mutableStateOf(false) }
            var effortMenu by remember { mutableStateOf(false) }
            var moving by remember { mutableStateOf(false) }
            if (moving && session != null) MoveFolderDialog(repository, session) { moving = false }
            Box {
                IconBtn(R.drawable.ic_more, "More options", { menu = true })
                DropdownMenu(expanded = modeMenu, onDismissRequest = { modeMenu = false }) {
                    MenuHeading("Agent mode, from the next reply")
                    modeLabels.forEach { (value, label) ->
                        DropdownMenuItem(
                            text = {
                                Column(Modifier.padding(vertical = 4.dp)) {
                                    Text(label, fontWeight = FontWeight.Medium)
                                    Text(modeDescription(value), fontSize = 12.sp, lineHeight = 16.sp, color = C.Muted)
                                }
                            },
                            onClick = { modeMenu = false; repository.setMode(sid, value) },
                            trailingIcon = { if (value == session?.mode || (value == "fast" && session?.mode == "acceptEdits")) CcIcon(R.drawable.ic_check, C.ClayText, 16.dp) },
                        )
                    }
                }
                DropdownMenu(expanded = modelMenu, onDismissRequest = { modelMenu = false }) {
                    MenuHeading("Model, from the next reply")
                    ModelItems(session?.model.orEmpty()) { modelMenu = false; repository.setModel(sid, it) }
                }
                DropdownMenu(expanded = effortMenu, onDismissRequest = { effortMenu = false }) {
                    MenuHeading("Reasoning effort, from the next reply")
                    EffortItems(session?.effort.orEmpty()) { effortMenu = false; repository.setEffort(sid, it) }
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(
                        text = { Text("Mode: ${modeLabel(session?.mode.orEmpty())}") },
                        onClick = { menu = false; modeMenu = true },
                    )
                    DropdownMenuItem(
                        text = { Text("Model: ${modelLabel(session?.model)}") },
                        onClick = { menu = false; modelMenu = true },
                    )
                    DropdownMenuItem(
                        text = { Text("Reasoning effort: ${effortLabel(session?.effort)}") },
                        onClick = { menu = false; effortMenu = true },
                    )
                    DropdownMenuItem(
                        text = { Text(if (session?.autoContinue == true) "Don't continue after usage limits" else "Continue after usage limits reset") },
                        onClick = { menu = false; repository.setAutoContinue(sid, session?.autoContinue != true) },
                    )
                    DropdownMenuItem(text = { Text("Change folder…") }, onClick = { menu = false; repository.refreshRepos(); moving = true })
                    DropdownMenuItem(text = { Text("Stop session") }, onClick = { menu = false; repository.stop(sid) })
                    DropdownMenuItem(text = { Text("Archive") }, onClick = { menu = false; repository.archive(sid); onBack() })
                }
            }
        }
        Row(
            Modifier.padding(horizontal = 16.dp, vertical = 4.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(C.Surface).padding(4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Box(Modifier.weight(1f).height(36.dp).clip(RoundedCornerShape(9.dp)).background(C.Surface3), contentAlignment = Alignment.Center) {
                Text("Chat", color = C.Text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            }
            Box(
                Modifier.weight(1f).height(36.dp).clip(RoundedCornerShape(9.dp)).clickable(role = Role.Tab, onClick = onDiff),
                contentAlignment = Alignment.Center,
            ) { Text("Changes", color = C.Muted, fontSize = 13.sp) }
        }

        if (items == null) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = C.Clay) }
        } else {
            LazyColumn(
                Modifier.weight(1f),
                state = listState,
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(items, key = { it.key }) { TranscriptItem(it, onDiff, loadImage) { tool, i -> viewing = tool to i } }
                if (working && approval == null) item(key = "thinking") { ThinkingRow(session.lastActivity) }
            }
        }

        viewing?.let { (tool, index) ->
            ImageViewer(tool.images, index, tool.summary, loadImage) { viewing = null }
        }
        if (session?.status == "limited" && approval == null) {
            LimitBanner(session) { repository.setAutoContinue(sid, it) }
        }
        if (approval != null && approval.questions.isNotEmpty()) {
            QuestionCard(
                approval,
                onSend = { repository.answerQuestions(approval, it) },
                onSkip = { repository.answerQuestions(approval, null) },
            )
        } else if (approval != null) {
            PermissionCard(
                approval,
                onDeny = { repository.answer(approval, allow = false) },
                onAllow = { repository.answer(approval, allow = true) },
                onAlways = { repository.answer(approval, allow = true, always = true) },
            )
        }
        if (approval == null) {
            var draft by remember(sid) { mutableStateOf(repository.settings.draft(sid)) }
            ReplyBar(
                voice = repository.voice, sid = sid,
                text = draft, onText = { draft = it; repository.settings.setDraft(sid, it) },
                attachments = repository.draftAttachments(sid),
                mode = session?.mode.orEmpty(), onMode = { repository.setMode(sid, it) },
                model = session?.model.orEmpty(), onModel = { repository.setModel(sid, it) },
                effort = session?.effort.orEmpty(), onEffort = { repository.setEffort(sid, it) },
                onSend = { text, files -> repository.sendMessage(sid, text, files) }, onError = repository::reportError,
            )
        }
    }
}

@Composable
private fun TranscriptItem(item: Item, onDiff: () -> Unit, loadImage: ImageLoader, onImage: (ToolItem, Int) -> Unit) {
    when (item) {
        is UserItem -> Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (item.text.isNotBlank()) {
                Box(
                    modifier = Modifier
                        .widthIn(max = 320.dp)
                        .clip(RoundedCornerShape(18.dp, 18.dp, 6.dp, 18.dp))
                        .background(C.Surface2)
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                ) {
                    RichText(item.text, color = C.Text)
                }
            }
            if (item.attachments.isNotEmpty()) SentAttachments(item.attachments)
        }
        is AssistantItem -> RichText(item.text)
        is ToolItem -> ToolRow(item, onDiff, loadImage) { onImage(item, it) }
        is PermissionItem -> {
            val asking = item.approval.questions.isNotEmpty()
            val (text, color) = when {
                asking && item.decision == null -> "AGY is asking: ${item.approval.questions.first().question}" to C.ClayPill
                asking && item.decision == "allow" -> "You replied to AGY\u2019s question" to C.Muted
                asking -> "AGY\u2019s question was withdrawn" to C.Faint
                else -> when (item.decision) {
                null -> "Waiting for your approval: ${item.approval.toolName}" to C.ClayPill
                "allow" -> "You allowed ${item.approval.toolName}" to C.Muted
                "deny" -> "You denied ${item.approval.toolName}" to C.Red
                else -> "Approval request withdrawn" to C.Faint
                }
            }
            Text(text, color = color, fontSize = 12.sp, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center)
        }
        is NoteItem -> Text(
            item.text, color = if (item.error) C.Red else C.Faint, fontSize = 12.sp,
            modifier = Modifier.fillMaxWidth(), textAlign = if (item.error) TextAlign.Start else TextAlign.Center,
        )
        is TurnEndItem -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(Modifier.weight(1f).height(1.dp).background(C.Border))
            Text(item.text, color = if (item.error) C.Red else C.Faint, fontSize = 12.sp)
            Box(Modifier.weight(1f).height(1.dp).background(C.Border))
        }
    }
}

@Composable
private fun ToolRow(item: ToolItem, onDiff: () -> Unit, loadImage: ImageLoader, onImage: (Int) -> Unit) {
    var expanded by rememberSaveable(item.key) { mutableStateOf(false) }
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(C.Card)
            .border(1.dp, C.Border, RoundedCornerShape(14.dp))
            .animateContentSize(),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 44.dp)
                .clickable(role = Role.Button) { if (item.delta != null && item.output == null) onDiff() else expanded = !expanded }
                .padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            when (item.state) {
                ToolState.Running -> CircularProgressIndicator(Modifier.size(14.dp), color = C.Clay, strokeWidth = 2.dp)
                ToolState.Done -> CcIcon(R.drawable.ic_check, C.Green, 16.dp, "Done")
                ToolState.Failed -> CcIcon(R.drawable.ic_x, C.Red, 16.dp, "Failed")
            }
            Text(item.name, color = C.TextSoft, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            Text(item.summary, color = C.Muted, fontSize = 13.sp, fontFamily = Mono, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            item.delta?.let { (a, r) -> DeltaText(a, r) }
        }
        if (item.images.isNotEmpty()) {
            ToolImages(item.images, loadImage, onImage, Modifier.padding(start = 12.dp, end = 12.dp, bottom = 12.dp))
        }
        if (expanded && !item.output.isNullOrBlank()) {
            SelectionContainer {
                CodeBlock(
                    item.output.take(2000),
                    modifier = Modifier.heightIn(max = 260.dp).verticalScroll(rememberScrollState()),
                    color = if (item.state == ToolState.Failed) C.DelText else C.Muted,
                    padding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
                )
            }
        }
    }
}

@Composable
private fun ThinkingRow(activity: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        CircularProgressIndicator(Modifier.size(14.dp), color = C.Clay, strokeWidth = 2.dp)
        Text(activity.ifBlank { "Working" }, color = C.Muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun PermissionCard(approval: Approval, onDeny: () -> Unit, onAllow: () -> Unit, onAlways: () -> Unit) {
    val plan = approval.toolName == "ExitPlanMode"
    Column(
        Modifier
            .padding(8.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(22.dp))
            .background(C.PermBg)
            .border(1.dp, C.PermBorder, RoundedCornerShape(22.dp))
            .padding(16.dp)
            .semantics(mergeDescendants = false) { contentDescription = "Permission request" },
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            CcIcon(R.drawable.ic_shield, C.Clay, 18.dp)
            Text(
                if (plan) "AGY has a plan and wants to start" else "AGY wants to use ${approval.toolName}",
                color = C.Text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            )
        }
        Box(Modifier.heightIn(max = if (plan) 320.dp else 180.dp).verticalScroll(rememberScrollState())) {
            if (plan) RichText(approval.detail) else CodeBlock(approval.detail.ifBlank { approval.summary }, color = C.Text)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SecondaryButton(if (plan) "Keep planning" else "Deny", onDeny, Modifier.weight(1f))
            PrimaryButton(if (plan) "Start" else "Allow once", onAllow, Modifier.weight(1f))
        }
        if (approval.canAlways && !plan) {
            TextButton(onClick = onAlways, modifier = Modifier.fillMaxWidth().height(44.dp)) {
                Text("Always allow this in this project", color = C.ClayText, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            }
        }
    }
}

@Composable
private fun ReplyBar(
    voice: VoiceInput, sid: String,
    text: String, onText: (String) -> Unit, attachments: SnapshotStateList<PendingAttachment>,
    mode: String, onMode: (String) -> Unit,
    model: String, onModel: (String) -> Unit,
    effort: String, onEffort: (String) -> Unit,
    onSend: (String, List<PendingAttachment>) -> Unit, onError: (String) -> Unit,
) {
    // Mode, model and effort apply from the next reply, so they sit with the message box as well as in the menu.
    var modeMenu by remember { mutableStateOf(false) }
    var modelMenu by remember { mutableStateOf(false) }
    var effortMenu by remember { mutableStateOf(false) }
    Row(
        Modifier.padding(start = 12.dp, top = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box {
            Chip(
                modeLabel(mode),
                onClick = { modeMenu = true }, on = mode.isNotEmpty(),
                warn = mode == YOLO,
            )
            DropdownMenu(expanded = modeMenu, onDismissRequest = { modeMenu = false }) {
                MenuHeading("Agent mode, from the next reply")
                modeLabels.forEach { (value, label) ->
                    DropdownMenuItem(
                        text = {
                            Column(Modifier.padding(vertical = 4.dp)) {
                                Text(label, fontWeight = FontWeight.Medium)
                                Text(modeDescription(value), fontSize = 12.sp, lineHeight = 16.sp, color = C.Muted)
                            }
                        },
                        onClick = { modeMenu = false; onMode(value) },
                        trailingIcon = { if (value == mode || (value == "fast" && mode == "acceptEdits")) CcIcon(R.drawable.ic_check, C.ClayText, 16.dp) },
                    )
                }
            }
        }
        Box {
            Chip(
                if (model.isEmpty()) "Default model" else modelLabel(model),
                onClick = { modelMenu = true }, on = model.isNotEmpty(),
            )
            DropdownMenu(expanded = modelMenu, onDismissRequest = { modelMenu = false }) {
                MenuHeading("Model, from the next reply")
                ModelItems(model) { modelMenu = false; onModel(it) }
            }
        }
        Box {
            Chip(
                if (effort.isEmpty()) "Default effort" else "${effortLabel(effort)} effort",
                onClick = { effortMenu = true }, on = effort.isNotEmpty(),
            )
            DropdownMenu(expanded = effortMenu, onDismissRequest = { effortMenu = false }) {
                MenuHeading("Reasoning effort, from the next reply")
                EffortItems(effort) { effortMenu = false; onEffort(it) }
            }
        }
    }
    AttachmentChips(attachments, Modifier.padding(start = 12.dp, end = 12.dp, top = 8.dp))
    Row(Modifier.padding(start = 4.dp, end = 12.dp, top = 8.dp, bottom = 12.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Box(Modifier.height(52.dp), contentAlignment = Alignment.Center) { AttachButton(attachments, onError) }
        TextField(
            value = text, onValueChange = onText,
            placeholder = { Text("Steer AGY, or /command…", color = C.Faint) },
            trailingIcon = { MicButton(voice, owner = sid, sid = sid, text = text, onText = onText, onError = onError, size = 40.dp) },
            maxLines = 6,
            textStyle = TextStyle(fontSize = 15.sp, color = C.Text),
            modifier = Modifier.weight(1f).border(1.dp, C.Surface3, RoundedCornerShape(16.dp)).semantics { contentDescription = "Message AGY" },
            shape = RoundedCornerShape(16.dp),
            colors = TextFieldDefaults.colors(
                focusedContainerColor = C.Surface, unfocusedContainerColor = C.Surface,
                focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, cursorColor = C.Clay,
            ),
        )
        val canSend = text.isNotBlank() || attachments.isNotEmpty()
        Box(
            Modifier
                .size(52.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(if (canSend) C.Clay else C.Surface)
                .clickable(enabled = canSend, role = Role.Button) {
                    onSend(text.trim(), attachments.toList())
                    onText("")
                    attachments.clear()
                }
                .semantics { contentDescription = "Send" },
            contentAlignment = Alignment.Center,
        ) { CcIcon(R.drawable.ic_send, if (canSend) C.OnClay else C.Faint) }
    }
}

/** Shown while a usage limit pauses the task: when it resets, and whether AGY continues then. */
@Composable
private fun LimitBanner(session: SessionSummary, onAutoContinue: (Boolean) -> Unit) {
    val at = session.resumeAt?.let { resetTime(it) }
    Row(
        Modifier
            .padding(horizontal = 16.dp, vertical = 6.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(C.Card)
            .border(1.dp, C.Border, RoundedCornerShape(14.dp))
            .padding(start = 14.dp, end = 10.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        CcIcon(R.drawable.ic_alert, C.Amber, 18.dp)
        Column(Modifier.weight(1f)) {
            Text(session.lastActivity.ifBlank { "Usage limit reached" }, color = C.Text, fontSize = 14.sp, fontWeight = FontWeight.Medium)
            Text(
                when {
                    session.autoContinue && at != null -> "AGY continues by itself at $at."
                    at != null -> "Resets around $at. Send a message then, or continue automatically."
                    else -> "Send a message to try again."
                },
                color = C.Muted, fontSize = 12.sp, lineHeight = 16.sp,
            )
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Switch(
                checked = session.autoContinue, onCheckedChange = onAutoContinue,
                colors = SwitchDefaults.colors(checkedTrackColor = C.Clay, checkedThumbColor = C.OnClay),
            )
            Text("Auto", color = C.Muted, fontSize = 11.sp)
        }
    }
}

/** Picks a new working folder for the task: one of the bridge's projects, or any path. */
@Composable
private fun MoveFolderDialog(repository: Repository, session: SessionSummary, onDone: () -> Unit) {
    val repos by repository.repos.collectAsStateWithLifecycle()
    var path by remember { mutableStateOf(session.cwd) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = onDone,
        title = { Text("Change folder") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    "AGY carries on in the new folder from your next message, in the same conversation. Its project memory is the new folder\u2019s.",
                    color = C.Muted, fontSize = 13.sp, lineHeight = 18.sp,
                )
                OutlinedTextField(
                    value = path, onValueChange = { path = it; error = null }, singleLine = true,
                    label = { Text("Folder") }, textStyle = TextStyle(fontFamily = Mono, fontSize = 13.sp),
                    modifier = Modifier.fillMaxWidth(),
                )
                error?.let { Text(it, color = C.Red, fontSize = 13.sp) }
                Column(Modifier.heightIn(max = 240.dp).verticalScroll(rememberScrollState())) {
                    repos.forEach { r ->
                        Text(
                            r.path.replace(Regex("^/data/data/com\\.termux/files/home"), "~"),
                            color = if (r.path == path) C.ClayText else C.TextSoft, fontSize = 13.sp, fontFamily = Mono,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
                                .clickable(role = Role.Button) { path = r.path; error = null }.padding(vertical = 9.dp, horizontal = 4.dp),
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !busy && path.isNotBlank() && path.trim() != session.cwd,
                onClick = {
                    busy = true
                    scope.launch {
                        repository.moveTask(session.id, path.trim())
                            .onSuccess { onDone() }
                            .onFailure { error = it.message }
                        busy = false
                    }
                },
            ) { Text(if (busy) "Moving…" else "Move") }
        },
        dismissButton = { TextButton(onClick = onDone) { Text("Cancel") } },
    )
}

/** AGY's questions (ask_question / AskUserQuestion): pick an option, several where allowed, or write your own answer. */
@Composable
private fun QuestionCard(approval: Approval, onSend: (Map<String, String>) -> Unit, onSkip: () -> Unit) {
    val picks = remember(approval.requestId) { mutableStateMapOf<Int, Set<String>>() }
    val other = remember(approval.requestId) { mutableStateMapOf<Int, String>() }
    fun answerFor(i: Int, q: Question): String? {
        val own = other[i]?.trim().orEmpty()
        val chosen = q.options.map { it.label }.filter { it in (picks[i] ?: emptySet()) }
        val parts = if (q.multiSelect) chosen + listOfNotNull(own.ifEmpty { null }) else listOf(own.ifEmpty { chosen.firstOrNull() ?: "" })
        return parts.filter { it.isNotEmpty() }.joinToString(", ").ifEmpty { null }
    }
    val answers = approval.questions.mapIndexedNotNull { i, q -> answerFor(i, q)?.let { q.question to it } }.toMap()
    Column(
        Modifier
            .padding(8.dp)
            .fillMaxWidth()
            .heightIn(max = 520.dp)
            .clip(RoundedCornerShape(22.dp))
            .background(C.PermBg)
            .border(1.dp, C.PermBorder, RoundedCornerShape(22.dp))
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(if (approval.questions.size == 1) "AGY has a question" else "AGY has ${approval.questions.size} questions",
            color = C.ClayText, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        approval.questions.forEachIndexed { i, q ->
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (q.header.isNotBlank()) Text(q.header.uppercase(), color = C.Muted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.8.sp)
                Text(q.question, color = C.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium, lineHeight = 21.sp)
                q.options.forEach { opt ->
                    val on = opt.label in (picks[i] ?: emptySet())
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(if (on) C.ClayBg else C.Card)
                            .border(1.dp, if (on) C.Clay else C.Border, RoundedCornerShape(12.dp))
                            .clickable(role = if (q.multiSelect) Role.Checkbox else Role.RadioButton) {
                                val now = picks[i] ?: emptySet()
                                picks[i] = if (q.multiSelect) (if (on) now - opt.label else now + opt.label) else setOf(opt.label)
                                if (!q.multiSelect) other.remove(i)
                            }
                            .padding(horizontal = 12.dp, vertical = 10.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Box(
                            Modifier.padding(top = 2.dp).size(18.dp)
                                .clip(if (q.multiSelect) RoundedCornerShape(4.dp) else RoundedCornerShape(9.dp))
                                .border(2.dp, if (on) C.Clay else C.BorderStrong, if (q.multiSelect) RoundedCornerShape(4.dp) else RoundedCornerShape(9.dp))
                                .background(if (on) C.Clay else Color.Transparent),
                        )
                        Column(Modifier.weight(1f)) {
                            Text(opt.label, color = C.Text, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                            if (opt.description.isNotBlank()) Text(opt.description, color = C.Muted, fontSize = 12.sp, lineHeight = 17.sp)
                        }
                    }
                }
                OutlinedTextField(
                    value = other[i].orEmpty(),
                    onValueChange = { other[i] = it; if (!q.multiSelect && it.isNotBlank()) picks.remove(i) },
                    placeholder = { Text("Other answer…", color = C.Faint) },
                    textStyle = TextStyle(fontSize = 14.sp, color = C.Text),
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(12.dp),
                )
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SecondaryButton("Skip", onSkip, Modifier.weight(1f))
            PrimaryButton(
                "Send", { onSend(answers) }, Modifier.weight(1f),
                enabled = approval.questions.isNotEmpty() && answers.size == approval.questions.size,
            )
        }
    }
}
