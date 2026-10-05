package app.ccmobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.ccmobile.R
import app.ccmobile.data.DiffLine
import app.ccmobile.data.FileDiff
import app.ccmobile.data.LineKind
import app.ccmobile.data.Repository

private data class LineComment(val path: String, val line: Int, val text: String)

@Composable
fun DiffScreen(repository: Repository, sid: String, onBack: () -> Unit) {
    LaunchedEffect(sid) { repository.loadDiff(sid) }
    val diffs by repository.diffs.collectAsStateWithLifecycle()
    val sessions by repository.sessions.collectAsStateWithLifecycle()
    val state = diffs[sid]
    val files = state?.files.orEmpty()
    val busy = sessions.firstOrNull { it.id == sid }?.isActive == true

    val expanded = remember { mutableStateListOf<String>() }
    LaunchedEffect(files.firstOrNull()?.path) { if (expanded.isEmpty()) files.firstOrNull()?.let { expanded.add(it.path) } }
    val comments = remember { mutableStateListOf<LineComment>() }
    var commenting by remember { mutableStateOf<Pair<String, Int>?>(null) }

    fun sendToClaude(text: String) {
        repository.sendMessage(sid, text)
        onBack()
    }

    Column(Modifier.fillMaxSize().background(C.Bg).safeDrawingPadding().imePadding()) {
        Row(Modifier.padding(start = 4.dp, end = 4.dp, top = 8.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconBtn(R.drawable.ic_back, "Back to session", onBack)
            Column(Modifier.weight(1f)) {
                Text("Changes", fontFamily = Serif, fontSize = 22.sp, color = C.Text)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("${files.size} files", color = C.Muted, fontSize = 12.sp, fontFamily = Mono)
                    DeltaText(files.sumOf { it.added }, files.sumOf { it.removed })
                    state?.branch?.let { Text("· $it", color = C.Muted, fontSize = 12.sp, fontFamily = Mono, maxLines = 1) }
                }
            }
            IconBtn(R.drawable.ic_refresh, "Reload changes", { repository.loadDiff(sid) })
        }

        Box(Modifier.weight(1f)) {
            when {
                state == null || (state.loading && files.isEmpty()) ->
                    CircularProgressIndicator(Modifier.align(Alignment.Center), color = C.Clay)
                files.isEmpty() -> Text(
                    "No uncommitted changes in this repository.", color = C.Faint, fontSize = 14.sp,
                    modifier = Modifier.align(Alignment.Center).padding(24.dp),
                )
                else -> LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (state.truncated) item { Text("Diff is large; showing the first 1 MB.", color = C.ClayPill, fontSize = 12.sp) }
                    items(files, key = { it.path }) { file ->
                        FileCard(
                            file,
                            expanded = file.path in expanded,
                            onToggle = { if (file.path in expanded) expanded.remove(file.path) else expanded.add(file.path) },
                            comments = comments.filter { it.path == file.path },
                            onLineClick = { line -> commenting = file.path to line },
                        )
                    }
                }
            }
        }

        HorizontalDivider(color = C.Surface2)
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (busy) Text("Claude is still working; changes may keep moving.", color = C.Muted, fontSize = 12.sp)
            if (comments.isNotEmpty()) {
                PrimaryButton(
                    "Send ${comments.size} comment${if (comments.size == 1) "" else "s"} to Claude",
                    onClick = {
                        sendToClaude(
                            "Review comments on your changes:\n" +
                                comments.joinToString("\n") { "- ${it.path}:${it.line}: ${it.text}" },
                        )
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SecondaryButton(
                        "Commit", enabled = files.isNotEmpty(), modifier = Modifier.weight(1f),
                        onClick = { sendToClaude("Commit these changes with a clear commit message. Don't push.") },
                    )
                    PrimaryButton(
                        "Open pull request", enabled = files.isNotEmpty(), modifier = Modifier.weight(1f),
                        onClick = { sendToClaude("Commit these changes on a new branch if we're on the default branch, push, and open a pull request with gh. Reply with the PR link.") },
                    )
                }
            }
        }
    }

    commenting?.let { (path, line) ->
        var text by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { commenting = null },
            title = { Text("Comment on ${path.substringAfterLast('/')}:$line") },
            text = { OutlinedTextField(text, { text = it }, placeholder = { Text("What should change here?") }, minLines = 2) },
            confirmButton = {
                TextButton(enabled = text.isNotBlank(), onClick = { comments.add(LineComment(path, line, text.trim())); commenting = null }) { Text("Add") }
            },
            dismissButton = { TextButton(onClick = { commenting = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun FileCard(file: FileDiff, expanded: Boolean, onToggle: () -> Unit, comments: List<LineComment>, onLineClick: (Int) -> Unit) {
    Column(Modifier.fillMaxWidth().background(C.Card, RoundedCornerShape(14.dp)).border(1.dp, C.Border, RoundedCornerShape(14.dp))) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .clickable(role = Role.Button, onClickLabel = if (expanded) "Collapse" else "Expand", onClick = onToggle)
                .padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            CcIcon(if (expanded) R.drawable.ic_chevron_down else R.drawable.ic_chevron_right, C.Muted, 16.dp)
            Text(file.path, color = C.Text, fontFamily = Mono, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            when (file.status) {
                "added" -> Text("new", color = C.Green, fontFamily = Mono, fontSize = 12.sp)
                "deleted" -> Text("deleted", color = C.Red, fontFamily = Mono, fontSize = 12.sp)
                "binary" -> Text("binary", color = C.Muted, fontFamily = Mono, fontSize = 12.sp)
                else -> {}
            }
            DeltaText(file.added, file.removed)
        }
        if (expanded && file.lines.isNotEmpty()) {
            HorizontalDivider(color = C.Border)
            // One horizontal scroller per file so long lines keep their columns aligned.
            Column(Modifier.horizontalScroll(rememberScrollState()).padding(bottom = 6.dp)) {
                file.lines.forEach { line ->
                    DiffRow(line, onLineClick)
                    val lineNo = line.newNo ?: line.oldNo
                    comments.filter { it.line == lineNo }.forEach { c ->
                        Text(
                            c.text, color = C.Text, fontSize = 13.sp,
                            modifier = Modifier
                                .padding(horizontal = 12.dp, vertical = 6.dp)
                                .width(300.dp)
                                .background(C.Surface2, RoundedCornerShape(10.dp))
                                .border(1.dp, C.BorderStrong, RoundedCornerShape(10.dp))
                                .padding(10.dp),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun DiffRow(line: DiffLine, onLineClick: (Int) -> Unit) {
    val (bg, fg, numColor, sign) = when (line.kind) {
        LineKind.Add -> Quad(C.AddBg, C.AddText, C.AddMark, "+")
        LineKind.Remove -> Quad(C.DelBg, C.DelText, C.DelMark, "−")
        LineKind.Hunk -> Quad(C.HunkBg, C.Faint, C.Faint, "")
        LineKind.Meta -> Quad(Color.Transparent, C.Faint, C.Faint, "")
        LineKind.Context -> Quad(Color.Transparent, C.TextSoft, C.ContextMark, " ")
    }
    val lineNo = line.newNo ?: line.oldNo
    Row(
        Modifier
            .background(bg)
            .then(if (lineNo != null) Modifier.clickable(onClickLabel = "Comment on line $lineNo") { onLineClick(lineNo) } else Modifier)
            .padding(horizontal = 12.dp, vertical = 1.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (line.kind == LineKind.Hunk || line.kind == LineKind.Meta) {
            Text(line.text, color = fg, fontFamily = Mono, fontSize = 11.5.sp, lineHeight = 20.sp, softWrap = false)
        } else {
            Text((lineNo ?: "").toString(), color = numColor, fontFamily = Mono, fontSize = 11.5.sp, lineHeight = 20.sp, modifier = Modifier.width(34.dp), fontWeight = FontWeight.Normal)
            Text("$sign ${line.text}", color = fg, fontFamily = Mono, fontSize = 11.5.sp, lineHeight = 20.sp, softWrap = false)
        }
    }
}

private data class Quad(val bg: Color, val fg: Color, val num: Color, val sign: String)
