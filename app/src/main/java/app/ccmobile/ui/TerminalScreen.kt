package app.ccmobile.ui

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.util.Base64
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.ccmobile.R
import app.ccmobile.data.AuthStatus
import app.ccmobile.data.ConnState
import app.ccmobile.data.Repository
import app.ccmobile.data.TermLink
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream

/** Keys a phone keyboard lacks, as in Termux: label to what they send. */
private val extraKeys = listOf(
    listOf("ESC" to "\u001b", "/" to "/", "-" to "-", "HOME" to "\u001b[H", "↑" to "\u001b[A", "END" to "\u001b[F", "PGUP" to "\u001b[5~"),
    listOf("TAB" to "\t", "CTRL" to "", "ALT" to "", "←" to "\u001b[D", "↓" to "\u001b[B", "→" to "\u001b[C", "PGDN" to "\u001b[6~"),
)

/** xterm.js colors for the app's palette; light mode needs darker ANSI colors to stay readable. */
private fun terminalTheme(p: Palette): String {
    fun hex(c: androidx.compose.ui.graphics.Color) = "#%06X".format(0xFFFFFF and c.toArgb())
    val ansi = if (p.dark) {
        listOf("#1F1E1D", "#EC9486", "#8FC78D", "#E5C07B", "#7AA2D6", "#C58FD0", "#7CC4C4", "#D6D3C9",
            "#6F6C64", "#F2A99D", "#A9D9A7", "#F0D08E", "#9DBCE6", "#D6A8DF", "#9AD6D6", "#F0EEE6")
    } else {
        listOf("#1F1E1D", "#B5402E", "#2F7A2E", "#8F5B08", "#2F5F9E", "#8A3F99", "#1F7A7A", "#5B5A55",
            "#75736B", "#C4513E", "#3B8A39", "#A86A0C", "#3C6FB5", "#9C4FAB", "#2A8C8C", "#3D3C38")
    }
    val names = listOf("black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
        "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite")
    val colors = names.zip(ansi).joinToString(",") { (n, c) -> "\"$n\":\"$c\"" }
    val selection = if (p.dark) "#5A3A2C" else "#E8C9BA"
    return "{\"background\":\"${hex(p.bg)}\",\"foreground\":\"${hex(p.text)}\",\"cursor\":\"${hex(p.clay)}\"," +
        "\"cursorAccent\":\"${hex(p.bg)}\",\"selectionBackground\":\"$selection\",$colors}"
}

/**
 * A shell in the Debian chroot, through the bridge (see Terminal in ccm-bridge.mjs). With [login] it runs
 * `claude auth login` where the bridge runs Claude instead, and opens its sign-in page in the browser.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun TerminalScreen(repository: Repository, onBack: () -> Unit, login: Boolean = false) {
    val context = LocalContext.current
    val conn by repository.client.state.collectAsStateWithLifecycle()
    val connected = conn is ConnState.Connected
    val scope = rememberCoroutineScope()
    var ready by remember { mutableStateOf(false) }
    var size by remember { mutableStateOf(80 to 24) }
    var termId by remember { mutableStateOf<String?>(null) }
    var ended by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var ctrl by remember { mutableStateOf(false) }
    var alt by remember { mutableStateOf(false) }
    var fontSize by remember { mutableIntStateOf(repository.settings.terminalFont) }
    var fresh by remember { mutableIntStateOf(0) } // bumped by "New session"
    // Login: the sign-in pages seen, those already opened (kept across activity restarts), and the outcome.
    var links by remember { mutableStateOf(emptyList<TermLink>()) }
    var opened by rememberSaveable { mutableStateOf(emptyList<String>()) }
    var signedIn by remember { mutableStateOf<AuthStatus?>(null) }

    val web = remember {
        WebView(context).apply {
            // Without explicit layout params a WebView in Compose can size its page to the content (one row here).
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = false
            setBackgroundColor(android.graphics.Color.TRANSPARENT)
            addJavascriptInterface(object {
                @JavascriptInterface fun ready(cols: Int, rows: Int) = post { size = cols to rows; ready = true }
                @JavascriptInterface fun resize(cols: Int, rows: Int) = post { size = cols to rows }
                @JavascriptInterface fun input(b64: String) = post { termId?.let { repository.termInput(it, b64) } }
                @JavascriptInterface fun modifiersUsed() = post { ctrl = false; alt = false }
            }, "Android")
            loadUrl("file:///android_asset/terminal/index.html")
        }
    }
    fun js(code: String) = web.evaluateJavascript(code, null)
    // A bridge on this phone finishes the sign-in by itself (a server on localhost); one elsewhere can't,
    // so open the page that shows a code to paste instead.
    val bridgeHere = repository.settings.host in setOf("127.0.0.1", "localhost")
    val signInPage = links.firstOrNull { it.local == bridgeHere }?.url
    fun openPage(url: String) {
        runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
            .onFailure { repository.reportError("Couldn't open a browser: ${it.message}") }
    }
    LaunchedEffect(signInPage) {
        if (signInPage != null && signInPage !in opened) { opened = opened + signInPage; openPage(signInPage) }
    }
    // Leaving gives up on a sign-in still waiting; the screen only detaches when Android recreates it.
    fun leave() {
        if (login && !ended) termId?.let(repository::termClose)
        onBack()
    }
    BackHandler(enabled = login) { leave() }

    fun send(text: String) {
        val id = termId ?: return
        repository.termInput(id, Base64.encodeToString(text.toByteArray(), Base64.NO_WRAP))
    }

    // Open, or reattach after a reconnect; the bridge replays recent output, so start from a clean screen.
    LaunchedEffect(ready, connected, fresh) {
        if (!ready || !connected) return@LaunchedEffect
        val (cols, rows) = size
        repository.termOpen(cols, rows, if (fresh > 0) null else termId, fresh = fresh > 0, login = login)
            .onSuccess { t ->
                termId = t.id
                ended = false
                error = null
                links = t.links
                signedIn = null
                js("ccm.reset();" + if (t.replay.isNotEmpty()) "ccm.write('${t.replay}');" else "")
            }
            .onFailure { error = it.message }
    }
    // Output, a frame's worth at a time: one call into the page instead of one per chunk.
    LaunchedEffect(termId) {
        val id = termId ?: return@LaunchedEffect
        val pending = ByteArrayOutputStream()
        var flush: Job? = null
        repository.terminal.collect { ev ->
            if (ev["id"]?.toString()?.trim('"') != id) return@collect
            when (ev["ev"]?.toString()?.trim('"')) {
                "term_output" -> {
                    pending.write(Base64.decode(ev["data"]?.toString()?.trim('"') ?: "", Base64.DEFAULT))
                    if (flush?.isActive != true) flush = scope.launch {
                        delay(16)
                        val bytes = pending.toByteArray().also { pending.reset() }
                        js("ccm.write('${Base64.encodeToString(bytes, Base64.NO_WRAP)}')")
                    }
                }
                "term_exit" -> {
                    ended = true
                    if (login) signedIn = repository.authStatus().getOrDefault(AuthStatus())
                }
                "term_link" -> {
                    val url = ev["url"]?.toString()?.trim('"') ?: return@collect
                    links = links + TermLink(url, ev["local"]?.toString() == "true")
                }
            }
        }
    }
    LaunchedEffect(size, termId) { termId?.let { repository.termResize(it, size.first, size.second) } }
    LaunchedEffect(ready, C.palette) { if (ready) js("ccm.theme(${terminalTheme(C.palette)})") }
    LaunchedEffect(ready, fontSize) { if (ready) js("ccm.font($fontSize)") }
    LaunchedEffect(ready, ctrl, alt) { if (ready) js("ccm.modifiers($ctrl,$alt)") }
    DisposableEffect(Unit) {
        onDispose {
            termId?.let(repository::termDetach) // the shell keeps running; opening the screen again reattaches
            web.destroy()
        }
    }

    fun showKeyboard() {
        js("ccm.focus()")
        web.requestFocus()
        context.getSystemService(InputMethodManager::class.java).showSoftInput(web, 0)
    }
    fun paste() {
        val text = context.getSystemService(ClipboardManager::class.java).primaryClip?.getItemAt(0)?.coerceToText(context)?.toString()
        if (!text.isNullOrEmpty()) js("ccm.paste(${org.json.JSONObject.quote(text)})")
    }
    fun copy() {
        web.evaluateJavascript("ccm.selection()") { quoted ->
            val text = runCatching { org.json.JSONArray("[$quoted]").getString(0) }.getOrDefault("")
            if (text.isNotEmpty()) context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("terminal", text))
            else repository.reportError("Select text first: long-press it in the terminal.")
        }
    }
    fun setFont(size: Int) { fontSize = size.coerceIn(8, 28); repository.settings.terminalFont = fontSize }

    Column(Modifier.fillMaxSize().background(C.Bg).safeDrawingPadding().imePadding()) {
        Row(Modifier.padding(start = 4.dp, end = 4.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconBtn(R.drawable.ic_back, "Back", ::leave)
            Column(Modifier.weight(1f)) {
                Text(if (login) "Log in to Claude" else "Debian", color = C.Text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                Text(if (connected) "${size.first}×${size.second}" else "Not connected", color = C.Muted, fontSize = 12.sp, fontFamily = Mono)
            }
            ToolText("A−", "Smaller text") { setFont(fontSize - 1) }
            ToolText("A+", "Larger text") { setFont(fontSize + 1) }
            ToolText("Copy", "Copy selection") { copy() }
            ToolText("Paste", "Paste") { paste() }
            IconBtn(R.drawable.ic_terminal, "Show keyboard", { showKeyboard() })
        }
        ConnectionBanner(conn, ::leave)
        if (login && !ended) {
            Row(Modifier.padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    if (bridgeHere) "Sign in in your browser, then come back here."
                    else "Sign in in your browser, then copy the code it shows and tap Paste.",
                    color = C.Muted, fontSize = 13.sp, modifier = Modifier.weight(1f),
                )
                signInPage?.let { url -> ToolText("Open page", "Open the sign-in page again") { openPage(url) } }
            }
        }
        error?.let {
            Text(it, color = C.Red, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp))
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            // The page measures itself; tell it when the view changes size (a frame later, once laid out).
            AndroidView({ web }, Modifier.fillMaxSize().onSizeChanged { if (ready) web.postDelayed({ js("ccm.refit()") }, 50) })
            if (ended) {
                Row(
                    Modifier.align(Alignment.BottomCenter).padding(12.dp).clip(RoundedCornerShape(12.dp)).background(C.Surface2)
                        .padding(horizontal = 14.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    val done = login && signedIn?.loggedIn == true
                    Text(
                        when {
                            !login -> "Session ended"
                            signedIn == null -> "Checking…"
                            done -> "Signed in" + (signedIn?.email?.let { " as $it" } ?: "")
                            else -> "Not signed in"
                        },
                        color = C.TextSoft, fontSize = 13.sp,
                    )
                    Text(if (done) "Done" else if (login) "Try again" else "Start again", color = C.ClayText, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.clickable(role = Role.Button) { if (done) onBack() else fresh++ })
                }
            }
        }
        Column(Modifier.background(C.Surface).padding(vertical = 2.dp)) {
            extraKeys.forEach { row ->
                Row(Modifier.fillMaxWidth()) {
                    row.forEach { (label, seq) ->
                        val on = (label == "CTRL" && ctrl) || (label == "ALT" && alt)
                        Box(
                            Modifier.weight(1f).height(40.dp).background(if (on) C.ClayBg else C.Surface)
                                .clickable(role = Role.Button) {
                                    when (label) {
                                        "CTRL" -> ctrl = !ctrl
                                        "ALT" -> alt = !alt
                                        else -> {
                                            // A modifier applies to the next key here too: Ctrl-← etc.
                                            val text = if (alt) "\u001b$seq" else seq
                                            ctrl = false; alt = false
                                            send(text)
                                        }
                                    }
                                }
                                .semantics { contentDescription = label },
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(label, color = if (on) C.ClayText else C.TextSoft, fontSize = 13.sp, fontFamily = Mono, fontWeight = FontWeight.Medium)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ToolText(text: String, label: String, onClick: () -> Unit) {
    Text(
        text, color = C.TextSoft, fontSize = 13.sp, fontWeight = FontWeight.Medium,
        modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable(role = Role.Button, onClickLabel = label, onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 10.dp),
    )
}
