package app.ccmobile.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.ccmobile.R
import app.ccmobile.data.ConnState
import app.ccmobile.data.DayUsage
import app.ccmobile.data.LimitWindow
import app.ccmobile.data.Limits
import app.ccmobile.data.Repository
import app.ccmobile.data.SessionSummary
import app.ccmobile.data.Usage
import app.ccmobile.data.UsageShare
import app.ccmobile.data.UsageText
import androidx.compose.foundation.shape.CircleShape
import kotlinx.coroutines.delay
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.log10
import kotlin.math.pow

@Composable
fun UsageScreen(repository: Repository, onBack: () -> Unit) {
    val limits by repository.limits.collectAsStateWithLifecycle()
    val sessions by repository.sessions.collectAsStateWithLifecycle()
    val usageTick by repository.usageTick.collectAsStateWithLifecycle()
    val conn by repository.client.state.collectAsStateWithLifecycle()
    val connected = conn is ConnState.Connected
    var range by rememberSaveable { mutableIntStateOf(7) }
    var usage by remember { mutableStateOf<Usage?>(null) }
    var loading by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var lastUpdatedAt by remember { mutableLongStateOf(0L) }

    LaunchedEffect(range, connected, reload) {
        if (!connected) return@LaunchedEffect
        loading = true
        repository.loadUsage(range)?.let {
            usage = it
            lastUpdatedAt = System.currentTimeMillis()
            now = lastUpdatedAt
        }
        loading = false
    }
    LaunchedEffect(usageTick, connected) {
        if (!connected || usageTick <= 0L) return@LaunchedEffect
        delay(300)
        repository.loadUsage(range, quiet = true)?.let {
            usage = it
            lastUpdatedAt = System.currentTimeMillis()
            now = lastUpdatedAt
        }
    }
    val anyActive = sessions.any { it.isActive }
    LaunchedEffect(connected, range, anyActive) {
        if (!connected) return@LaunchedEffect
        val intervalMs = if (anyActive) 5_000L else 15_000L
        while (true) {
            delay(intervalMs)
            repository.loadUsage(range, quiet = true)?.let {
                usage = it
                lastUpdatedAt = System.currentTimeMillis()
                now = lastUpdatedAt
            }
        }
    }
    LaunchedEffect(Unit) {
        while (true) { delay(1_000); now = System.currentTimeMillis() }
    }

    val liveSessions = remember(sessions) {
        sessions.filter { it.isOpen || it.outputTokens > 0 || it.readTokens > 0 }.take(5)
    }

    Column(Modifier.fillMaxSize().background(C.Bg).safeDrawingPadding()) {
        Row(Modifier.padding(start = 4.dp, end = 4.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconBtn(R.drawable.ic_back, "Back", onBack)
            Box(Modifier.weight(1f))
            if (connected) {
                val stamp = maxOf(lastUpdatedAt, limits?.updatedAt ?: 0L)
                Row(
                    Modifier
                        .clip(RoundedCornerShape(999.dp))
                        .background(C.Surface)
                        .border(1.dp, C.Border, RoundedCornerShape(999.dp))
                        .padding(horizontal = 10.dp, vertical = 5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Box(
                        Modifier
                            .size(7.dp)
                            .clip(CircleShape)
                            .background(if (anyActive) C.Clay else C.Green),
                    )
                    Text(
                        if (stamp > 0L) "Live · ${UsageText.ago(now - stamp)}" else "Live",
                        color = C.Muted,
                        fontSize = 12.sp,
                    )
                }
            }
            if (loading) CircularProgressIndicator(Modifier.padding(12.dp).size(20.dp), color = C.Muted, strokeWidth = 2.dp)
            else IconBtn(R.drawable.ic_refresh, "Refresh", { reload++ }, enabled = connected)
        }
        ConnectionBanner(conn, onBack)
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Usage", fontFamily = Serif, fontSize = 30.sp, lineHeight = 35.sp, color = C.Text)
                Text(
                    "Real-time plan quota limits and token usage across your AGY tasks.",
                    color = C.Muted, fontSize = 14.sp, lineHeight = 20.sp,
                )
            }

            UsageSection("Plan limits") { LimitsCard(limits, now) }

            if (liveSessions.isNotEmpty()) {
                UsageSection(if (anyActive) "Live task usage" else "Recent task usage") {
                    LiveSessionsCard(liveSessions, limits)
                }
            }

            UsageSection("Activity") {
                Segmented(listOf(7 to "7 days", 30 to "30 days"), range, { range = it })
                val u = usage
                if (u == null) {
                    Text(if (connected) "Loading…" else "Connect to the bridge to see activity.", color = C.Muted, fontSize = 13.sp)
                } else {
                    Totals(u)
                    DailyChart(u.days)
                }
            }

            usage?.takeIf { it.projects.isNotEmpty() }?.let { u ->
                UsageSection("By project") { ShareList(u.projects) { projectName(it) } }
                UsageSection("By model") { ShareList(u.models) { UsageText.modelName(it) } }
            }
        }
    }
}

@Composable
private fun LiveSessionsCard(sessions: List<SessionSummary>, limits: Limits?) {
    UsageCard {
        sessions.forEachIndexed { i, s ->
            if (i > 0) HorizontalDivider(color = C.Border)
            val modelLabel = s.model?.let(UsageText::modelName) ?: "Default model"
            val win = limits?.windows?.let { UsageText.windowForModel(s.model, it) }
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(
                        Modifier
                            .size(8.dp)
                            .clip(CircleShape)
                            .background(if (s.isActive) C.Clay else if (s.status == "limited") C.Amber else C.Faint),
                    )
                    Text(
                        s.title,
                        color = C.Text,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        "${UsageText.compact(s.outputTokens)} out",
                        color = C.Text,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    val details = buildList {
                        add(modelLabel)
                        if (s.readTokens > 0) add("${UsageText.compact(s.readTokens)} in")
                        if (s.thinkingTokens > 0) add("${UsageText.compact(s.thinkingTokens)} think")
                        if (s.requests > 0) add("${s.requests} req")
                        if (win != null) add("${UsageText.percent(win.utilization)} quota")
                    }.joinToString(" · ")
                    Text(
                        details,
                        color = C.Muted,
                        fontSize = 12.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

@Composable
private fun UsageSection(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(title.uppercase(), color = C.Muted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.8.sp)
        content()
    }
}

@Composable
private fun UsageCard(content: @Composable () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(C.Card)
            .border(1.dp, C.Border, RoundedCornerShape(14.dp))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) { content() }
}

// ---- plan limits ----

private enum class Level { Normal, Warning, Critical }

private fun levelOf(utilization: Double) = when {
    utilization >= 1.0 -> Level.Critical
    utilization >= 0.8 -> Level.Warning
    else -> Level.Normal
}

@Composable
private fun LimitsCard(limits: Limits?, now: Long) {
    UsageCard {
        if (limits == null || limits.windows.isEmpty()) {
            Text("Limits show up after AGY's next reply, or tap Refresh above.", color = C.Muted, fontSize = 13.sp, lineHeight = 18.sp)
            return@UsageCard
        }
        limits.windows.forEachIndexed { i, w ->
            if (i > 0) HorizontalDivider(color = C.Border)
            LimitRow(w, now)
        }
        Text(
            "Updated ${UsageText.ago(now - limits.updatedAt)} · Counts all your Antigravity quota usage.",
            color = C.Faint, fontSize = 12.sp, lineHeight = 17.sp,
        )
    }
}

@Composable
private fun LimitRow(w: LimitWindow, now: Long) {
    val (name, sub) = UsageText.windowLabel(w.id)
    // Once a window has reset, the last reading no longer applies; it starts again from 0.
    val reset = w.resetsAt in 1..now
    val utilization = if (reset) 0.0 else w.utilization.coerceIn(0.0, 1.0)
    val level = levelOf(utilization)
    val fill = when {
        w.disabled && utilization < 1.0 -> C.Amber
        level == Level.Normal -> C.Clay
        level == Level.Warning -> C.Amber
        else -> C.Red
    }
    val pct = UsageText.percent(utilization)
    val leftPct = UsageText.percent((1.0 - utilization).coerceIn(0.0, 1.0))

    Column(
        Modifier.semantics(mergeDescendants = true) {},
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.Bottom) {
            Column(Modifier.weight(1f)) {
                Text(name, color = C.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                if (sub.isNotEmpty()) Text(sub, color = C.Muted, fontSize = 12.sp)
            }
            Text(pct, color = C.Text, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
            Text(" used · $leftPct left", color = C.Muted, fontSize = 12.sp, modifier = Modifier.padding(bottom = 3.dp))
        }
        Meter(utilization, fill)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            when {
                w.disabled && utilization < 1.0 -> LevelTag("Paused by weekly limit", C.Amber, C.AmberBg)
                level == Level.Warning -> LevelTag("Nearly used", C.Amber, C.AmberBg)
                level == Level.Critical -> LevelTag("Limit reached", C.Red, C.DelBg)
            }
            val at = resetTime(w.resetsAt, now)
            Text(
                when {
                    w.resetsAt <= 0 -> if (w.disabled) "Unavailable until weekly quota resets" else ""
                    reset -> "Reset $at"
                    else -> "Resets $at · ${UsageText.until(w.resetsAt - now)}"
                },
                color = C.Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun Meter(fraction: Double, color: Color) {
    Box(Modifier.fillMaxWidth().height(8.dp).clip(RoundedCornerShape(4.dp)).background(C.Surface2)) {
        if (fraction > 0) {
            Box(
                Modifier
                    .fillMaxWidth(fraction.coerceIn(0.02, 1.0).toFloat())
                    .height(8.dp)
                    .clip(RoundedCornerShape(4.dp))
                    .background(color),
            )
        }
    }
}

@Composable
private fun LevelTag(text: String, fg: Color, bg: Color) {
    Row(
        Modifier.height(22.dp).clip(RoundedCornerShape(6.dp)).background(bg).padding(horizontal = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        CcIcon(R.drawable.ic_alert, fg, 13.dp)
        Text(text, color = C.Text, fontSize = 12.sp, fontWeight = FontWeight.Medium)
    }
}

/** "3:30 PM" today, "Fri 9:00 AM" within a week, else "Oct 12". */
fun resetTime(epochMs: Long, now: Long = System.currentTimeMillis()): String {
    val zone = ZoneId.systemDefault()
    val at = Instant.ofEpochMilli(epochMs).atZone(zone)
    val days = at.toLocalDate().toEpochDay() - Instant.ofEpochMilli(now).atZone(zone).toLocalDate().toEpochDay()
    val pattern = when {
        days == 0L -> "h:mm a"
        days in -6..6 -> "EEE h:mm a"
        else -> "MMM d"
    }
    return at.format(DateTimeFormatter.ofPattern(pattern, Locale.getDefault()))
}

// ---- activity ----

@Composable
private fun Totals(u: Usage) {
    val totalOut = u.days.sumOf { it.output }
    val totalRead = u.days.sumOf { it.read }
    val totalReq = u.days.sumOf { it.requests }.toLong()
    val totalThinking = u.days.sumOf { it.thinking }
    val totalCacheRead = u.days.sumOf { it.cacheRead }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            StatTile("Tokens out", UsageText.compact(totalOut), Modifier.weight(1f))
            StatTile("Tokens in", UsageText.compact(totalRead), Modifier.weight(1f))
            StatTile("Requests", UsageText.compact(totalReq), Modifier.weight(1f))
        }
        val extra = buildList {
            if (totalThinking > 0) add("${UsageText.compact(totalThinking)} thinking")
            if (totalCacheRead > 0 && totalRead > 0) {
                val pct = Math.round(totalCacheRead.toDouble() / totalRead * 100)
                add("${UsageText.compact(totalCacheRead)} cached ($pct%)")
            }
            if (u.sessions > 0) add("${u.sessions} ${if (u.sessions == 1) "session" else "sessions"}")
        }.joinToString(" · ")
        if (extra.isNotEmpty()) {
            Text(extra, color = C.Muted, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 4.dp))
        }
    }
}

@Composable
private fun StatTile(label: String, value: String, modifier: Modifier) {
    Column(
        modifier
            .clip(RoundedCornerShape(12.dp))
            .background(C.Card)
            .border(1.dp, C.Border, RoundedCornerShape(12.dp))
            .padding(horizontal = 12.dp, vertical = 10.dp)
            .semantics(mergeDescendants = true) {},
    ) {
        Text(value, color = C.Text, fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
        Text(label, color = C.Muted, fontSize = 12.sp)
    }
}

/** Tokens out per day. Tap or drag to read a day; the readout above the bars shows it. */
@Composable
private fun DailyChart(days: List<DayUsage>) {
    if (days.isEmpty()) return
    var selected by remember(days.size) { mutableIntStateOf(days.lastIndex) }
    val day = days[selected.coerceIn(0, days.lastIndex)]
    val top = niceCeil(days.maxOf { it.output })
    val peak = days.maxBy { it.output }

    UsageCard {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(dayLabel(day.date, long = true), color = C.Muted, fontSize = 12.sp)
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(UsageText.compact(day.output), color = C.Text, fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
                val daySummary = buildList {
                    add("out")
                    if (day.thinking > 0) add("(${UsageText.compact(day.thinking)} think)")
                    add("· ${UsageText.compact(day.read)} in")
                    add("· ${day.requests} req")
                }.joinToString(" ")
                Text(daySummary, color = C.Muted, fontSize = 13.sp,
                    modifier = Modifier.padding(bottom = 2.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Column {
            Text(UsageText.compact(top), color = C.Faint, fontSize = 11.sp)
            Canvas(
                Modifier
                    .fillMaxWidth()
                    .height(120.dp)
                    .semantics {
                        contentDescription = "Tokens out per day. Busiest: ${dayLabel(peak.date, long = true)}, ${UsageText.compact(peak.output)}."
                    }
                    .pointerInput(days.size) {
                        detectTapGestures { selected = (it.x / (size.width.toFloat() / days.size)).toInt().coerceIn(0, days.lastIndex) }
                    }
                    .pointerInput(days.size) {
                        detectHorizontalDragGestures { change, _ ->
                            selected = (change.position.x / (size.width.toFloat() / days.size)).toInt().coerceIn(0, days.lastIndex)
                        }
                    },
            ) {
                val slot = size.width / days.size
                val gap = 2.dp.toPx()
                val barW = (slot - gap).coerceAtMost(28.dp.toPx())
                val radius = CornerRadius(4.dp.toPx().coerceAtMost(barW / 2))
                drawLine(C.Border, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(6f, 6f)))
                days.forEachIndexed { i, d ->
                    if (d.output <= 0) return@forEachIndexed
                    val h = (d.output.toFloat() / top * size.height).coerceAtLeast(2.dp.toPx())
                    val left = i * slot + (slot - barW) / 2
                    val path = Path().apply {
                        addRoundRect(
                            RoundRect(
                                left, size.height - h, left + barW, size.height,
                                topLeftCornerRadius = radius, topRightCornerRadius = radius,
                                bottomRightCornerRadius = CornerRadius.Zero, bottomLeftCornerRadius = CornerRadius.Zero,
                            ),
                        )
                    }
                    drawPath(path, if (i == selected) C.Clay else C.Clay.copy(alpha = 0.45f))
                }
                drawLine(C.BorderStrong, Offset(0f, size.height), Offset(size.width, size.height), 1.dp.toPx())
                // Marks the selected day even when it has no bar.
                val cx = selected * slot + slot / 2
                drawRect(C.TextSoft, Offset(cx - 1.dp.toPx(), size.height + 1.dp.toPx()), Size(2.dp.toPx(), 3.dp.toPx()))
            }
            Row(Modifier.fillMaxWidth().padding(top = 6.dp)) {
                if (days.size <= 7) {
                    days.forEach { d -> Text(dayLabel(d.date), color = C.Faint, fontSize = 11.sp, textAlign = TextAlign.Center, modifier = Modifier.weight(1f)) }
                } else {
                    Text(dayLabel(days.first().date, long = true), color = C.Faint, fontSize = 11.sp, modifier = Modifier.weight(1f))
                    Text("Today", color = C.Faint, fontSize = 11.sp)
                }
            }
        }
    }
}

/** "Mon", or "Mon, Sep 29" when [long]; today is "Today". */
private fun dayLabel(date: String, long: Boolean = false): String {
    val d = runCatching { LocalDate.parse(date) }.getOrNull() ?: return date
    if (d == LocalDate.now()) return "Today"
    val weekday = d.dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.getDefault())
    return if (long) "$weekday, ${d.format(DateTimeFormatter.ofPattern("MMM d", Locale.getDefault()))}" else weekday
}

/** Rounds up to 1, 2 or 5 × a power of ten, for the chart's top line. */
private fun niceCeil(n: Long): Long {
    if (n <= 0) return 1
    val p = 10.0.pow(ceil(log10(n.toDouble())) - 1)
    val step = listOf(1, 2, 5, 10).first { it * p >= n }
    return (step * p).toLong()
}

// ---- breakdowns ----

@Composable
private fun ShareList(shares: List<UsageShare>, label: (String) -> String) {
    val shown = shares.take(5)
    val max = shown.maxOf { it.output }.coerceAtLeast(1)
    UsageCard {
        shown.forEach { s ->
            Column(Modifier.semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(label(s.key), color = C.Text, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Text("${UsageText.compact(s.output)} out", color = C.TextSoft, fontSize = 13.sp)
                    val inText = if (s.input > 0) " · ${UsageText.compact(s.input)} in" else ""
                    Text("$inText · ${s.requests} req", color = C.Muted, fontSize = 13.sp)
                }
                Box(Modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp)).background(C.Surface2)) {
                    Box(
                        Modifier
                            .fillMaxWidth((s.output.toFloat() / max).coerceIn(0.01f, 1f))
                            .height(4.dp)
                            .clip(RoundedCornerShape(2.dp))
                            .background(C.Clay),
                    )
                }
            }
        }
        if (shares.size > shown.size) {
            val rest = shares.drop(shown.size)
            Text("${rest.size} more · ${UsageText.compact(rest.sumOf { it.output })} out", color = C.Faint, fontSize = 12.sp)
        }
    }
}

private fun projectName(cwd: String): String = when {
    cwd.isBlank() -> "Unknown folder"
    else -> cwd.trimEnd('/').substringAfterLast('/').ifEmpty { cwd }
}
