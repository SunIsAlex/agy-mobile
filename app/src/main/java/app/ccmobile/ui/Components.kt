package app.ccmobile.ui

import androidx.annotation.DrawableRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.ccmobile.data.ConnState

@Composable
fun CcIcon(@DrawableRes res: Int, tint: Color = C.Text, size: Dp = 20.dp, contentDescription: String? = null) {
    Icon(painterResource(res), contentDescription, tint = tint, modifier = Modifier.size(size))
}

@Composable
fun IconBtn(@DrawableRes res: Int, label: String, onClick: () -> Unit, tint: Color = C.Text, enabled: Boolean = true) {
    IconButton(onClick = onClick, enabled = enabled, modifier = Modifier.size(48.dp)) {
        CcIcon(res, if (enabled) tint else C.Faint, contentDescription = label)
    }
}

@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Button(
        onClick = onClick, enabled = enabled, modifier = modifier.height(50.dp),
        shape = RoundedCornerShape(16.dp),
        colors = ButtonDefaults.buttonColors(containerColor = C.Clay, contentColor = C.OnClay, disabledContainerColor = C.Surface2),
    ) { Text(text, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
}

@Composable
fun SecondaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    OutlinedButton(
        onClick = onClick, enabled = enabled, modifier = modifier.height(50.dp),
        shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, C.BorderStrong),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = C.Text),
    ) { Text(text, fontWeight = FontWeight.Medium, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
}

/** A small rounded chip button, as in the composer row. */
@Composable
fun Chip(text: String, onClick: () -> Unit, @DrawableRes icon: Int? = null, warn: Boolean = false, on: Boolean = false) {
    val fg = if (warn) C.Red else if (on) C.ClayText else C.TextSoft
    Row(
        Modifier
            .height(36.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(if (warn) C.DelBg else if (on) C.ClayBg else C.Surface2)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        icon?.let { CcIcon(it, fg, 14.dp) }
        Text(text, color = fg, fontSize = 13.sp, maxLines = 1)
    }
}

/** Segmented control: one row of mutually exclusive options. */
@Composable
fun <T> Segmented(options: List<Pair<T, String>>, selected: T, onSelect: (T) -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(C.Surface)
            .padding(4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        options.forEach { (value, label) ->
            val on = value == selected
            Box(
                Modifier
                    .weight(1f)
                    .height(40.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(if (on) C.Surface3 else Color.Transparent)
                    .semantics { this.selected = on }
                    .clickable(role = Role.Tab) { onSelect(value) },
                contentAlignment = Alignment.Center,
            ) {
                Text(label, color = if (on) C.Text else C.Muted, fontSize = 13.sp, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal)
            }
        }
    }
}

data class StatusStyle(val label: String, val fg: Color, val bg: Color, val dot: Color)

fun statusStyle(status: String): StatusStyle = when (status) {
    "needs_approval" -> StatusStyle("Needs approval", C.ClayPill, C.ClayBg, C.Clay)
    "working" -> StatusStyle("Working", C.TextSoft, C.Surface2, C.TextSoft)
    "idle" -> StatusStyle("Ready to review", C.GreenPill, C.GreenBg, C.Green)
    "error" -> StatusStyle("Error", C.Red, C.DelBg, C.Red)
    "limited" -> StatusStyle("Usage limit", C.Amber, C.AmberBg, C.Amber)
    else -> StatusStyle("Stopped", C.Muted, C.Surface2, C.Faint)
}

@Composable
fun StatusPill(status: String) {
    val s = statusStyle(status)
    Row(
        Modifier
            .height(22.dp)
            .clip(CircleShape)
            .background(s.bg)
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(Modifier.size(7.dp).clip(CircleShape).background(s.dot))
        Text(s.label, color = s.fg, fontSize = 12.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
fun DeltaText(added: Int, removed: Int) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("+$added", color = C.Green, fontFamily = Mono, fontSize = 12.sp)
        Text("−$removed", color = C.Red, fontFamily = Mono, fontSize = 12.sp)
    }
}

/** Shown under headers when the bridge isn't connected. */
@Composable
fun ConnectionBanner(state: ConnState, onFix: () -> Unit) {
    val text = when (state) {
        is ConnState.Connected -> return
        ConnState.Idle -> "Not paired with a bridge yet."
        ConnState.Connecting -> "Connecting to the bridge…"
        is ConnState.Failed -> state.message
    }
    Row(
        Modifier
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(C.ClayBg)
            .clickable(role = Role.Button, onClick = onFix)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, color = C.ClayPill, fontSize = 13.sp, modifier = Modifier.weight(1f))
        Text("Settings", color = C.ClayText, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
}

/** Horizontally scrollable monospace block. */
@Composable
fun CodeBlock(text: String, modifier: Modifier = Modifier, color: Color = C.TextSoft, padding: PaddingValues = PaddingValues(12.dp)) {
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(C.Code)
            .horizontalScroll(rememberScrollState())
            .padding(padding),
    ) {
        Text(text, color = color, fontFamily = Mono, fontSize = 12.5.sp, lineHeight = 18.sp, softWrap = false)
    }
}

fun relativeTime(epochMs: Long, now: Long = System.currentTimeMillis()): String {
    val minutes = (now - epochMs) / 60_000
    return when {
        minutes < 1 -> "now"
        minutes < 60 -> "${minutes}m ago"
        minutes < 24 * 60 -> "${minutes / 60}h ago"
        minutes < 48 * 60 -> "yesterday"
        else -> "${minutes / (24 * 60)}d ago"
    }
}

const val YOLO = "bypassPermissions"
val modeLabels = listOf("default" to "Ask first", "acceptEdits" to "Auto-edit", "plan" to "Plan only", YOLO to "YOLO")

fun modeLabel(mode: String): String = modeLabels.firstOrNull { it.first == mode }?.second ?: mode

fun modeDescription(mode: String): String = when (mode) {
    "acceptEdits" -> "AGY edits files without asking. Commands still need your OK."
    "plan" -> "AGY researches and proposes a plan. Nothing changes until you approve it."
    YOLO -> "AGY runs commands and edits files without asking (--dangerously-skip-permissions)."
    else -> "AGY asks before editing files or running commands."
}
val effortLabels = listOf("" to "Default", "low" to "Low", "medium" to "Medium", "high" to "High")

fun effortLabel(effort: String?): String = effortLabels.firstOrNull { it.first == effort.orEmpty() }?.second ?: effort.orEmpty()

fun effortDescription(effort: String): String = when (effort) {
    "low" -> "Quick answers with little thinking. Fastest, and lightest on your limits."
    "medium" -> "Balanced thinking. A good fit for routine tasks and edits."
    "high" -> "Deep thinking before acting, for complex bugs and architecture."
    else -> "Uses the model's own default."
}
val modelLabels = listOf(
    "" to "Default",
    "gemini-4-argon" to "Argon",
    "gemini-3.8-flash" to "Flash",
    "claude-opus-5-5" to "Opus",
    "claude-sonnet-5-5" to "Sonnet",
    "gpt-oss-120b" to "GPT-OSS",
)

fun modelLabel(model: String?): String = modelLabels.firstOrNull { it.first == model.orEmpty() }?.second ?: model.orEmpty()

