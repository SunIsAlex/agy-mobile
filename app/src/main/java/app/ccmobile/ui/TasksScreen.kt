package app.ccmobile.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.ccmobile.R
import app.ccmobile.data.ClaudeSession
import app.ccmobile.data.ConnState
import app.ccmobile.data.PendingAttachment
import app.ccmobile.data.Repo
import app.ccmobile.data.Repository
import app.ccmobile.data.SessionSummary
import kotlinx.coroutines.launch

@Composable
fun TasksScreen(repository: Repository, onOpen: (String) -> Unit, onSettings: () -> Unit, onUsage: () -> Unit) {
    val sessions by repository.sessions.collectAsStateWithLifecycle()
    val repos by repository.repos.collectAsStateWithLifecycle()
    val conn by repository.client.state.collectAsStateWithLifecycle()
    val claudeSessions by repository.claudeSessions.collectAsStateWithLifecycle()
    val roots by repository.roots.collectAsStateWithLifecycle()
    val phoneAvailable by repository.phoneAvailable.collectAsStateWithLifecycle()
    val limits by repository.limits.collectAsStateWithLifecycle()
    val settings = repository.settings

    var repoPath by rememberSaveable { mutableStateOf(settings.lastRepo) }
    val repo = repos.firstOrNull { it.path == repoPath } ?: repos.firstOrNull()
    var prompt by rememberSaveable { mutableStateOf("") }
    var mode by rememberSaveable { mutableStateOf(settings.mode) }
    var model by rememberSaveable { mutableStateOf(settings.model) }
    var effort by rememberSaveable { mutableStateOf(settings.effort) }
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var starting by remember { mutableStateOf(false) }
    var resuming by remember { mutableStateOf<String?>(null) }
    var newFolder by rememberSaveable { mutableStateOf(false) }
    var phone by rememberSaveable { mutableStateOf(settings.phone) }
    val phoneOn = phone && phoneAvailable
    val attachments = remember { mutableStateListOf<PendingAttachment>() }
    val scope = rememberCoroutineScope()

    val active = sessions.filter { it.isActive }
    val done = sessions.filterNot { it.isActive }
    val shown = if (tab == 0) active else done

    LaunchedEffect(tab, conn is ConnState.Connected) {
        if (tab == 2 && conn is ConnState.Connected) repository.refreshClaudeSessions()
    }
    // Phone tasks don't need a repo; they run in the bridge's first root.
    val cwd = repo?.path ?: roots.firstOrNull()?.takeIf { phoneOn }
    val canStart = (prompt.isNotBlank() || attachments.isNotEmpty()) && cwd != null && conn is ConnState.Connected && !starting

    fun start() {
        val target = cwd ?: return
        starting = true
        scope.launch {
            val sid = repository.start(target, prompt.trim(), mode, model.ifBlank { null }, effort.ifBlank { null }, phoneOn, attachments.toList())
            starting = false
            if (sid != null) {
                prompt = ""
                attachments.clear()
                onOpen(sid)
            }
        }
    }

    fun resume(id: String) {
        if (resuming != null) return
        resuming = id
        scope.launch {
            val sid = repository.resume(id)
            resuming = null
            if (sid != null) onOpen(sid)
        }
    }

    Column(Modifier.fillMaxSize().background(C.Bg).safeDrawingPadding().imePadding()) {
        Row(Modifier.padding(start = 16.dp, end = 8.dp, top = 12.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            RepoPicker(
                repos, repo, onPick = { repoPath = it.path }, onRefresh = repository::refreshRepos,
                onNewFolder = { newFolder = true }.takeIf { conn is ConnState.Connected && roots.isNotEmpty() },
                modifier = Modifier.weight(1f),
            )
            // Tinted when a plan limit is nearly used, so it shows before a task stalls on it.
            val now = System.currentTimeMillis()
            val peak = limits?.windows?.filter { it.resetsAt > now }?.maxOfOrNull { it.utilization } ?: 0.0
            IconBtn(
                R.drawable.ic_gauge, if (peak >= 0.8) "Usage, ${Math.round(peak * 100)}% of a limit used" else "Usage", onUsage,
                tint = if (peak >= 1.0) C.Red else if (peak >= 0.8) C.Amber else C.Text,
            )
            IconBtn(R.drawable.ic_settings, "Settings", onSettings)
        }
        ConnectionBanner(conn, onSettings)

        LazyColumn(Modifier.weight(1f)) {
            item {
                Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 16.dp)) {
                    Text(
                        "What should we build?", fontFamily = Serif, fontSize = 30.sp, lineHeight = 35.sp,
                        color = C.Text, modifier = Modifier.padding(bottom = 12.dp),
                    )
                    Composer(
                        prompt = prompt, onPrompt = { prompt = it },
                        mode = mode, onMode = { mode = it },
                        model = model, onModel = { model = it },
                        effort = effort, onEffort = { effort = it },
                        canStart = canStart, starting = starting, onStart = ::start,
                        attachments = attachments, onError = repository::reportError,
                        phone = phoneOn.takeIf { phoneAvailable }, onPhone = { phone = it; settings.phone = it },
                    )
                }
            }
            item {
                Row(Modifier.padding(horizontal = 16.dp)) {
                    TabLabel("Active · ${active.size}", tab == 0) { tab = 0 }
                    TabLabel("Finished · ${done.size}", tab == 1) { tab = 1 }
                    TabLabel("Resume", tab == 2) { tab = 2 }
                }
                HorizontalDivider(color = C.Surface2)
            }
            if (tab == 2) {
                val list = claudeSessions
                if (list.isNullOrEmpty()) {
                    item {
                        Text(
                            if (list == null) "Loading Claude Code sessions…"
                            else "No other Claude Code sessions on the bridge's machine. Sessions you start with claude in a terminal show up here.",
                            color = C.Faint, fontSize = 14.sp, modifier = Modifier.padding(24.dp),
                        )
                    }
                }
                items(list.orEmpty(), key = { it.id }) { s ->
                    ClaudeSessionRow(s, resuming = resuming == s.id, onClick = { resume(s.id) })
                }
                return@LazyColumn
            }
            if (shown.isEmpty()) {
                item {
                    Text(
                        if (tab == 0) "No tasks running. Describe one above." else "Finished tasks show up here.",
                        color = C.Faint, fontSize = 14.sp, modifier = Modifier.padding(24.dp),
                    )
                }
            }
            items(shown, key = { it.id }) { s ->
                TaskRow(s, onClick = { onOpen(s.id) }, onArchive = { repository.archive(s.id) })
            }
        }
    }
    if (newFolder) {
        NewFolderDialog(
            roots = roots,
            onCreate = repository::createFolder,
            onCreated = { repoPath = it; newFolder = false },
            onDismiss = { newFolder = false },
        )
    }
}

@Composable
private fun NewFolderDialog(
    roots: List<String>,
    onCreate: suspend (root: String, name: String) -> Result<String>,
    onCreated: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var root by rememberSaveable { mutableStateOf(roots.first()) }
    var name by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var creating by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    fun create() {
        if (name.isBlank() || creating) return
        creating = true
        error = null
        scope.launch {
            onCreate(root, name.trim()).onSuccess(onCreated).onFailure { error = it.message }
            creating = false
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New folder") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (roots.size > 1) {
                    var menu by remember { mutableStateOf(false) }
                    Box {
                        Chip(shortPath(root), onClick = { menu = true }, icon = R.drawable.ic_folder)
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            roots.forEach { r ->
                                DropdownMenuItem(text = { Text(shortPath(r), fontFamily = Mono) }, onClick = { root = r; menu = false })
                            }
                        }
                    }
                }
                OutlinedTextField(
                    value = name, onValueChange = { name = it; error = null },
                    label = { Text("Name") }, placeholder = { Text("my-app") },
                    prefix = { Text(shortPath(root).trimEnd('/') + "/", color = C.Muted, fontFamily = Mono) },
                    singleLine = true, isError = error != null,
                    supportingText = { Text(error ?: "Created as an empty git repository.") },
                    keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { create() }),
                )
            }
        },
        confirmButton = {
            TextButton(enabled = name.isNotBlank() && !creating, onClick = ::create) { Text(if (creating) "Creating…" else "Create") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

private fun shortPath(path: String) = path.replace(Regex("^/data/data/com.termux/files/home"), "~")

@Composable
private fun Composer(
    prompt: String, onPrompt: (String) -> Unit,
    mode: String, onMode: (String) -> Unit,
    model: String, onModel: (String) -> Unit,
    effort: String, onEffort: (String) -> Unit,
    canStart: Boolean, starting: Boolean, onStart: () -> Unit,
    attachments: SnapshotStateList<PendingAttachment>, onError: (String) -> Unit,
    /** Phone use toggle state, or null when the bridge can't offer it. */
    phone: Boolean?, onPhone: (Boolean) -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(C.Surface)
            .border(1.dp, C.BorderStrong, RoundedCornerShape(20.dp))
            .padding(start = 4.dp, end = 10.dp, top = 4.dp, bottom = 10.dp),
    ) {
        TextField(
            value = prompt, onValueChange = onPrompt,
            placeholder = { Text("Describe a task, paste an error…", color = C.Faint) },
            minLines = 3, maxLines = 10,
            modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Describe a task" },
            textStyle = androidx.compose.ui.text.TextStyle(fontSize = 16.sp, lineHeight = 23.sp, color = C.Text),
            colors = TextFieldDefaults.colors(
                focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
                focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent,
                cursorColor = C.Clay,
            ),
        )
        AttachmentChips(attachments, Modifier.padding(start = 10.dp, bottom = 8.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            AttachButton(attachments, onError)
            var modeMenu by remember { mutableStateOf(false) }
            Box {
                Chip(modeLabel(mode), onClick = { modeMenu = true }, icon = R.drawable.ic_shield, warn = mode == YOLO)
                DropdownMenu(expanded = modeMenu, onDismissRequest = { modeMenu = false }) {
                    modeLabels.forEach { (value, label) ->
                        DropdownMenuItem(
                            text = {
                                Column(Modifier.padding(vertical = 4.dp)) {
                                    Text(label, fontWeight = FontWeight.Medium, color = if (value == YOLO) C.Red else Color.Unspecified)
                                    Text(modeDescription(value), fontSize = 12.sp, lineHeight = 16.sp, color = C.Muted)
                                }
                            },
                            onClick = { onMode(value); modeMenu = false },
                        )
                    }
                }
            }
            var menu by remember { mutableStateOf(false) }
            Box {
                // One chip for model and effort keeps the composer row short: "Opus · High".
                val modelText = modelLabels.firstOrNull { it.first == model }?.second ?: model
                Chip(if (effort.isEmpty()) modelText else "$modelText · ${effortLabel(effort)}", onClick = { menu = true })
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    MenuHeading("Model")
                    modelLabels.forEach { (value, label) ->
                        DropdownMenuItem(
                            text = { Text(if (value.isEmpty()) "Default model" else label) },
                            onClick = { onModel(value); menu = false },
                            trailingIcon = { if (value == model) CcIcon(R.drawable.ic_check, C.ClayText, 16.dp) },
                        )
                    }
                    HorizontalDivider(color = C.Border)
                    MenuHeading("Reasoning effort")
                    EffortItems(effort) { onEffort(it); menu = false }
                }
            }
            if (phone != null) Chip("Phone", onClick = { onPhone(!phone) }, icon = R.drawable.ic_phone, on = phone)
            Spacer(Modifier.weight(1f))
            Box(
                Modifier
                    .size(44.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .background(if (canStart) C.Clay else C.Surface2)
                    .clickable(enabled = canStart, role = Role.Button, onClick = onStart)
                    .semantics { contentDescription = "Start task" },
                contentAlignment = Alignment.Center,
            ) {
                if (starting) CircularProgressIndicator(Modifier.size(18.dp), color = C.Bg, strokeWidth = 2.dp)
                else CcIcon(R.drawable.ic_send, if (canStart) C.Bg else C.Faint)
            }
        }
    }
}

@Composable
private fun RepoPicker(
    repos: List<Repo>, selected: Repo?, onPick: (Repo) -> Unit, onRefresh: () -> Unit,
    onNewFolder: (() -> Unit)?, modifier: Modifier = Modifier,
) {
    var open by remember { mutableStateOf(false) }
    Box(modifier) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(52.dp)
                .clip(RoundedCornerShape(14.dp))
                .background(C.Surface)
                .border(BorderStroke(1.dp, C.Surface3), RoundedCornerShape(14.dp))
                .clickable(role = Role.Button) { onRefresh(); open = true }
                .padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            CcIcon(R.drawable.ic_folder, C.Clay)
            Column(Modifier.weight(1f)) {
                Text(selected?.name ?: "Choose a repository", color = C.Text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                Text(
                    selected?.let { listOfNotNull(it.branch, shortPath(it.path)).joinToString(" · ") }
                        ?: "Repos are found under the bridge's --roots",
                    color = C.Muted, fontSize = 12.sp, fontFamily = Mono, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            CcIcon(R.drawable.ic_chevron_down, C.Muted, 18.dp)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            if (repos.isEmpty()) DropdownMenuItem(text = { Text("No git repositories found") }, onClick = { open = false })
            repos.forEach { r ->
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(r.name, fontWeight = FontWeight.Medium)
                            r.branch?.let { Text(it, fontFamily = Mono, fontSize = 12.sp, color = C.Muted) }
                        }
                    },
                    onClick = { onPick(r); open = false },
                )
            }
            if (onNewFolder != null) {
                HorizontalDivider(color = C.Surface2)
                DropdownMenuItem(
                    text = { Text("New folder…", color = C.Clay, fontWeight = FontWeight.Medium) },
                    leadingIcon = { CcIcon(R.drawable.ic_folder, C.Clay, 18.dp) },
                    onClick = { open = false; onNewFolder() },
                )
            }
        }
    }
}

@Composable
private fun TabLabel(text: String, selected: Boolean, onClick: () -> Unit) {
    Column(
        Modifier
            .height(46.dp)
            .width(IntrinsicSize.Max)
            .semantics { this.selected = selected }
            .clickable(role = Role.Tab, onClick = onClick)
            .padding(horizontal = 12.dp),
        verticalArrangement = Arrangement.Bottom,
    ) {
        Text(
            text, color = if (selected) C.Text else C.Muted, fontSize = 14.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
            modifier = Modifier.padding(bottom = 11.dp),
        )
        Box(Modifier.fillMaxWidth().height(2.dp).background(if (selected) C.Clay else Color.Transparent))
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TaskRow(s: SessionSummary, onClick: () -> Unit, onArchive: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    Box {
        Column(
            Modifier
                .fillMaxWidth()
                .combinedClickable(onClick = onClick, onLongClick = { menu = true }, onLongClickLabel = "Task options")
                .padding(horizontal = 16.dp, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusPill(s.status)
                Text(relativeTime(s.updatedAt), color = C.Faint, fontSize = 12.sp)
            }
            Text(s.title, color = C.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium, lineHeight = 20.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(
                listOf(s.repoName, s.lastActivity).filter { it.isNotBlank() }.joinToString(" · "),
                color = C.Muted, fontSize = 12.sp, fontFamily = Mono, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        HorizontalDivider(Modifier.align(Alignment.BottomCenter).padding(horizontal = 16.dp), color = Color(0xFF242320))
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(text = { Text("Open") }, onClick = { menu = false; onClick() })
            DropdownMenuItem(text = { Text("Archive (stops it and deletes the bridge's copy)") }, onClick = { menu = false; onArchive() })
        }
    }
}

@Composable
private fun ClaudeSessionRow(s: ClaudeSession, resuming: Boolean, onClick: () -> Unit) {
    Box {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(role = Role.Button, onClickLabel = "Resume", onClick = onClick)
                .padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    listOf(s.repoName, relativeTime(s.updatedAt)).joinToString(" · "),
                    color = C.Faint, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Text(s.title, color = C.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium, lineHeight = 20.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (s.lastPrompt.isNotBlank() && s.lastPrompt != s.title) {
                    Text(s.lastPrompt, color = C.Muted, fontSize = 12.sp, fontFamily = Mono, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (resuming) CircularProgressIndicator(Modifier.size(18.dp), color = C.Clay, strokeWidth = 2.dp)
            else CcIcon(R.drawable.ic_chevron_right, C.Muted, 18.dp)
        }
        HorizontalDivider(Modifier.align(Alignment.BottomCenter).padding(horizontal = 16.dp), color = Color(0xFF242320))
    }
}

@Composable
fun MenuHeading(text: String) {
    Text(
        text.uppercase(), color = C.Muted, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.8.sp,
        modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 4.dp),
    )
}

/** Effort levels as menu items, with what each one means; [selected] is ticked. */
@Composable
fun EffortItems(selected: String, onSelect: (String) -> Unit) {
    effortLabels.forEach { (value, label) ->
        DropdownMenuItem(
            text = {
                Column(Modifier.padding(vertical = 4.dp)) {
                    Text(label, fontWeight = FontWeight.Medium)
                    Text(effortDescription(value), fontSize = 12.sp, lineHeight = 16.sp, color = C.Muted)
                }
            },
            onClick = { onSelect(value) },
            trailingIcon = { if (value == selected) CcIcon(R.drawable.ic_check, C.ClayText, 16.dp) },
        )
    }
}
