package app.ccmobile.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.ccmobile.R
import app.ccmobile.data.ConnState
import app.ccmobile.data.ProcInfo
import app.ccmobile.data.Repository
import app.ccmobile.data.SessionSummary
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** What a confirmation dialog will do, and how to describe it. */
private data class Pending(val proc: ProcInfo, val action: String, val title: String, val text: String)

@Composable
fun ProcessesScreen(repository: Repository, onBack: () -> Unit, onOpenTask: (String) -> Unit) {
    val conn by repository.client.state.collectAsStateWithLifecycle()
    val sessions by repository.sessions.collectAsStateWithLifecycle()
    val connected = conn is ConnState.Connected
    var procs by remember { mutableStateOf<List<ProcInfo>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var pending by remember { mutableStateOf<Pending?>(null) }
    var busy by remember { mutableStateOf<Int?>(null) }
    val scope = rememberCoroutineScope()

    // CPU use is measured between listings, so the list refreshes while the screen is open.
    LaunchedEffect(connected) {
        while (connected) {
            if (busy == null) repository.processes()?.let { procs = it }
            delay(3_000)
        }
    }

    fun run(proc: ProcInfo, action: String) {
        busy = proc.pid
        error = null
        scope.launch {
            val result = if (action == "restart") repository.restartProcess(proc.pid) else repository.signal(proc.pid, action)
            result.onSuccess { procs = it }.onFailure { error = it.message }
            busy = null
        }
    }

    Column(Modifier.fillMaxSize().background(C.Bg).safeDrawingPadding()) {
        Row(Modifier.padding(start = 4.dp, end = 4.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconBtn(R.drawable.ic_back, "Back", onBack)
        }
        ConnectionBanner(conn, onBack)
        val list = procs
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item {
                Column(Modifier.padding(bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Processes", fontFamily = Serif, fontSize = 30.sp, lineHeight = 35.sp, color = C.Text)
                    Text(
                        "Everything running in Termux on the bridge's machine, grouped by the task that started it.",
                        color = C.Muted, fontSize = 14.sp, lineHeight = 20.sp,
                    )
                    error?.let { Text(it, color = C.Red, fontSize = 13.sp) }
                }
            }
            if (list == null) {
                item { Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = C.Clay) } }
            } else {
                for ((title, sid, group) in groups(list, sessions)) {
                    item(key = "h-$title-$sid") {
                        Row(Modifier.fillMaxWidth().padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(title.uppercase(), color = C.Muted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.8.sp,
                                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                            if (sid != null) Text("Open task", color = C.ClayText, fontSize = 12.sp,
                                modifier = Modifier.clip(RoundedCornerShape(6.dp)).clickable(role = Role.Button) { onOpenTask(sid) }.padding(6.dp))
                        }
                    }
                    items(group, key = { it.pid }) { p ->
                        ProcessRow(p, busy = busy == p.pid) { action ->
                            pending = confirmation(p, action)
                            if (pending == null) run(p, action)
                        }
                    }
                }
            }
        }
    }

    pending?.let { p ->
        AlertDialog(
            onDismissRequest = { pending = null },
            title = { Text(p.title) },
            text = { Text(p.text) },
            confirmButton = { TextButton(onClick = { pending = null; run(p.proc, p.action) }) { Text(p.title.substringBefore(' ')) } },
            dismissButton = { TextButton(onClick = { pending = null }) { Text("Cancel") } },
        )
    }
}

/** Groups in display order: each task (its Claude and jobs), then CC Mobile's own processes, then the rest. */
private fun groups(list: List<ProcInfo>, sessions: List<SessionSummary>): List<Triple<String, String?, List<ProcInfo>>> {
    val order = listOf("claude", "job")
    val tasks = list.filter { it.sid != null && it.role in order }.groupBy { it.sid!! }.map { (sid, ps) ->
        Triple(sessions.firstOrNull { it.id == sid }?.title ?: "Task ${sid.take(8)}", sid as String?, ps.sortedBy { order.indexOf(it.role) })
    }
    val own = list.filter { it.role == "bridge" || it.role == "keeper" }
    val other = list.filter { it.role == "other" || (it.role in order && it.sid == null) }
    return tasks + listOfNotNull(
        other.takeIf { it.isNotEmpty() }?.let { Triple("Other", null, it) },
        own.takeIf { it.isNotEmpty() }?.let { Triple("AGY Mobile", null, it) },
    )
}

/** A dialog for actions that end or disrupt work; null for those that don't need one. */
private fun confirmation(p: ProcInfo, action: String): Pending? = when {
    action == "SIGSTOP" || action == "SIGCONT" -> null
    p.role == "claude" -> Pending(p, action, "Stop AGY?", "This ends the task's AGY process and anything it's running. The task's next message starts it again.")
    p.role == "keeper" -> Pending(p, action, "Stop keeper?", "The keeper runs this task's AGY. Stopping it ends AGY too.")
    action == "SIGKILL" -> Pending(p, action, "Kill ${p.name}?", "It ends at once, without a chance to save its work.")
    action == "restart" -> Pending(p, action, "Restart ${p.name}?", "It's stopped and run again with the same command and folder. Its output goes to the bridge's process-logs folder.")
    else -> null
}

@Composable
private fun ProcessRow(p: ProcInfo, busy: Boolean, onAction: (String) -> Unit) {
    var expanded by rememberSaveable(p.pid) { mutableStateOf(false) }
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(C.Card)
            .border(1.dp, C.Border, RoundedCornerShape(14.dp))
            .clickable(role = Role.Button) { expanded = !expanded }
            .padding(horizontal = 14.dp, vertical = 10.dp)
            .animateContentSize(),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(if (p.role == "claude") "AGY" else p.name, color = C.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            roleLabel(p)?.let { Tag(it) }
            if (p.paused) Tag("paused", warn = true)
            if (busy) CircularProgressIndicator(Modifier.size(14.dp), color = C.Muted, strokeWidth = 2.dp)
            else Text(p.cpu?.let { "%.0f%%".format(it) } ?: "–", color = if ((p.cpu ?: 0.0) >= 50) C.Amber else C.TextSoft, fontSize = 13.sp, fontFamily = Mono)
        }
        Text(
            listOfNotNull("pid ${p.pid}", memory(p.rssKb), "up ${elapsed(p.startedAt)}", p.cwd?.let(::shortCwd)).joinToString(" · "),
            color = C.Muted, fontSize = 12.sp, fontFamily = Mono, maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        if (!expanded) {
            Text(programArgs(p.args).joinToString(" "), color = C.Faint, fontSize = 12.sp, fontFamily = Mono, maxLines = 1, overflow = TextOverflow.Ellipsis)
        } else {
            SelectionContainer { CodeBlock(p.args.joinToString(" ") { if (it.isEmpty() || it.any(Char::isWhitespace)) "'$it'" else it }) }
            Text(
                listOfNotNull(p.cwd?.let { "Folder: $it" }, "Parent: ${p.ppid}", "CPU time: ${"%.0f".format(p.cpuSeconds)} s").joinToString("\n"),
                color = C.Muted, fontSize = 12.sp, lineHeight = 17.sp, fontFamily = Mono,
            )
            if (p.role != "bridge") {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(top = 4.dp)) {
                    Chip("Stop", { onAction("SIGTERM") }, icon = R.drawable.ic_stop)
                    Chip("Force kill", { onAction("SIGKILL") }, warn = true)
                    if (p.paused) Chip("Resume", { onAction("SIGCONT") }) else Chip("Pause", { onAction("SIGSTOP") })
                    if (p.restartable) Chip("Restart", { onAction("restart") }, icon = R.drawable.ic_refresh)
                }
            } else {
                Text("The bridge itself. Restart it from Termux.", color = C.Faint, fontSize = 12.sp)
            }
        }
    }
}

private fun roleLabel(p: ProcInfo): String? = when (p.role) {
    "keeper" -> "keeper"
    "bridge" -> "bridge"
    "job" -> if (p.detached) "detached" else null
    else -> null
}

@Composable
private fun Tag(text: String, warn: Boolean = false) {
    Text(
        text, color = if (warn) C.Amber else C.TextSoft, fontSize = 11.sp, fontWeight = FontWeight.Medium,
        modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(if (warn) C.AmberBg else C.Surface2).padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

/** Arguments after the program, skipping the glibc loader Termux runs Claude through. */
private fun programArgs(args: List<String>): List<String> {
    if (!args.firstOrNull().orEmpty().substringAfterLast('/').startsWith("ld-linux")) return args.drop(1)
    val program = args.withIndex().indexOfFirst { (i, a) -> i > 0 && !a.startsWith("-") && args[i - 1] != "--library-path" }
    return if (program < 0) args.drop(1) else args.drop(program + 1)
}

private fun memory(kb: Long): String? = when {
    kb <= 0 -> null
    kb >= 1024 * 1024 -> "%.1f GB".format(kb / 1024.0 / 1024.0)
    else -> "${kb / 1024} MB"
}

/** "45s", "12m", "3h 5m", "2d 4h". */
private fun elapsed(since: Long, now: Long = System.currentTimeMillis()): String {
    val s = ((now - since) / 1000).coerceAtLeast(0)
    return when {
        s < 60 -> "${s}s"
        s < 3600 -> "${s / 60}m"
        s < 86400 -> "${s / 3600}h ${s % 3600 / 60}m"
        else -> "${s / 86400}d ${s % 86400 / 3600}h"
    }
}

private fun shortCwd(path: String): String = path.replace(Regex("^/data/data/com\\.termux/files/home"), "~")
