package app.ccmobile.ui

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.ccmobile.R
import app.ccmobile.data.AuthStatus
import app.ccmobile.data.BridgeKind
import app.ccmobile.data.BridgeLauncher
import app.ccmobile.data.ConnState
import app.ccmobile.data.Repository
import app.ccmobile.notify.BridgeService
import app.ccmobile.notify.Notifier


@Composable
fun SettingsScreen(repository: Repository, onBack: (() -> Unit)?, onLogin: () -> Unit) {
    val settings = repository.settings
    val context = LocalContext.current
    val conn by repository.client.state.collectAsStateWithLifecycle()

    var host by remember { mutableStateOf(settings.host) }
    var port by remember { mutableStateOf(settings.port.toString()) }
    var token by remember { mutableStateOf(settings.token) }
    var mode by remember { mutableStateOf(settings.mode) }
    var model by remember { mutableStateOf(settings.model) }
    var effort by remember { mutableStateOf(settings.effort) }
    var autoContinue by remember { mutableStateOf(settings.autoContinue) }
    var reviveBridge by remember { mutableStateOf(settings.reviveBridge) }
    var keepAwake by remember { mutableStateOf(settings.keepAwake) }
    var theme by remember { mutableStateOf(settings.theme) }
    var starting by remember { mutableStateOf<BridgeKind?>(null) }
    var waitingFor by remember { mutableStateOf<BridgeKind?>(null) }
    fun launch(kind: BridgeKind) {
        starting = kind
        runCatching { BridgeLauncher.start(context, kind) }.onFailure {
            starting = null
            repository.reportError("Couldn't reach Termux: ${it.message}")
        }
    }
    val termuxPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val kind = waitingFor ?: return@rememberLauncherForActivityResult
        waitingFor = null
        if (granted) launch(kind)
        else repository.reportError("CC Mobile needs permission to run commands in Termux (App info › Permissions).")
    }
    fun start(kind: BridgeKind) {
        when {
            !BridgeLauncher.termuxInstalled(context) -> repository.reportError("Termux isn't installed.")
            BridgeLauncher.permitted(context) -> launch(kind)
            else -> { waitingFor = kind; termuxPermission.launch(BridgeLauncher.PERMISSION) }
        }
    }
    // Starting ends once the app connects (the bridge's pairing link does that) or after a while.
    LaunchedEffect(starting, conn) {
        if (starting != null && conn is ConnState.Connected && settings.port == starting?.port) starting = null
        else if (starting != null) { kotlinx.coroutines.delay(45_000); starting = null }
    }
    var notify by remember { mutableStateOf(settings.notify && Notifier.canPost(context)) }
    // Who Claude Code on the connected bridge is signed in as; checked again after logging in.
    var auth by remember { mutableStateOf<Result<AuthStatus>?>(null) }
    LaunchedEffect(conn) { auth = if (conn is ConnState.Connected) repository.authStatus() else null }

    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        notify = granted
        settings.notify = granted
        if (granted) BridgeService.start(context)
    }

    Column(
        Modifier.fillMaxSize().background(C.Bg).safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()),
    ) {
        if (onBack != null) Row(Modifier.padding(start = 4.dp, top = 8.dp)) { IconBtn(R.drawable.ic_back, "Back", onBack) }
        Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Where Claude runs", fontFamily = Serif, fontSize = 30.sp, lineHeight = 35.sp, color = C.Text)
                Text(
                    "This app is a front end. Claude Code runs in a small bridge on the machine that has your code: this phone (in Termux) or a computer you can reach.",
                    color = C.Muted, fontSize = 14.sp, lineHeight = 20.sp,
                )
            }

            Section("Start a bridge on this phone") {
                Text("Tap Start, or run the command in Termux. Either way the bridge pairs with this app.", color = C.TextSoft, fontSize = 14.sp)
                BridgeKind.entries.forEach { kind ->
                    val active = conn is ConnState.Connected && settings.port == kind.port && settings.host in setOf("127.0.0.1", "localhost")
                    BridgeCard(kind, active, starting = starting == kind, onCopy = { copy(context, kind.command) }, onStart = { start(kind) })
                }
            }

            SwitchRow(
                "Restart the bridge if it stops",
                "Android sometimes kills background processes. When this phone's bridge stops answering, start it again through Termux.",
                reviveBridge,
            ) { reviveBridge = it; settings.reviveBridge = it }

            Section("Connect") {
                ConnectionLine(conn)
                Field("Host", host, { host = it })
                Field("Port", port, { port = it.filter(Char::isDigit).take(5) }, keyboard = KeyboardType.Number)
                Field("Token", token, { token = it.trim() }, secret = true)
                PrimaryButton(
                    "Connect",
                    enabled = host.isNotBlank() && port.isNotBlank() && token.isNotBlank(),
                    onClick = {
                        repository.pair(host.trim(), port.toInt(), token)
                        if (settings.notify) {
                            if (Notifier.canPost(context)) BridgeService.start(context)
                            else if (Build.VERSION.SDK_INT >= 33) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    "Using a computer instead? Run the bridge there with --host set to a private address (for example your Tailscale IP) and enter it here. The connection is not encrypted, so keep it on a private network.",
                    color = C.Faint, fontSize = 12.sp, lineHeight = 17.sp,
                )
            }

            Section("Claude account") {
                val status = auth?.getOrNull()
                Text(
                    when {
                        conn !is ConnState.Connected -> "Connect to a bridge to see which account Claude uses."
                        auth == null -> "Checking…"
                        status == null -> auth?.exceptionOrNull()?.message ?: "Couldn't check the login."
                        !status.loggedIn -> "Not signed in. Tasks fail until Claude Code on the bridge is logged in."
                        else -> "Signed in" + (status.email?.let { " as $it" } ?: "") +
                            (status.subscriptionType?.let { " · Claude ${it.replaceFirstChar(Char::uppercase)}" }
                                ?: if (status.authMethod == "claude.ai") "" else " · ${status.authMethod}")
                    },
                    color = if (status?.loggedIn == false) C.Red else C.TextSoft, fontSize = 14.sp,
                )
                if (status?.loggedIn == true) SecondaryButton("Log in with another account", onLogin, modifier = Modifier.fillMaxWidth())
                else PrimaryButton("Log in to Claude", onLogin, modifier = Modifier.fillMaxWidth(), enabled = conn is ConnState.Connected)
                Text(
                    "Runs claude auth login on the bridge and opens the sign-in page in your browser.",
                    color = C.Faint, fontSize = 12.sp, lineHeight = 17.sp,
                )
            }

            Section("Default permissions for new tasks") {
                Segmented(modeLabels, mode, { mode = it; settings.mode = it })
                Text(modeDescription(mode), color = if (mode == YOLO) C.Red else C.Muted, fontSize = 13.sp)
            }

            Section("Appearance") {
                val config = LocalConfiguration.current
                Segmented(themeLabels, theme, { theme = it; settings.theme = it; applyTheme(it, config) })
            }

                        Section("Default model") {
                Segmented(modelLabels, model, { model = it; settings.model = it })
            }

            Section("Default reasoning effort") {
                Segmented(effortShortLabels, effort, { effort = it; settings.effort = it })
                Text(effortDescription(effort), color = C.Muted, fontSize = 13.sp)
            }

            Section("Keep phone awake while Claude works") {
                Segmented(
                    listOf("never" to "Never", "charging" to "Charging", "always" to "Always"), keepAwake,
                    { keepAwake = it; settings.keepAwake = it },
                )
                Text(
                    when (keepAwake) {
                        "always" -> "Tasks keep running with the screen off, even on battery. Long renders or encodes can use a lot of battery."
                        "never" -> "When the screen is off, Android pauses tasks until the phone wakes."
                        else -> "Tasks keep running with the screen off while the phone charges. On battery, Android pauses them until the phone wakes."
                    },
                    color = C.Muted, fontSize = 13.sp,
                )
            }

            SwitchRow(
                "Continue after usage limits reset",
                "When a task hits your plan's limit, Claude picks it up again once the limit resets. You can change this per task.",
                autoContinue,
            ) { autoContinue = it; settings.autoContinue = it }

            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 56.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .background(C.Card)
                    .border(1.dp, C.Border, RoundedCornerShape(14.dp))
                    .clickable(role = Role.Switch) {
                        val on = !notify
                        if (on && Build.VERSION.SDK_INT >= 33) {
                            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                        } else {
                            notify = on
                            settings.notify = on
                            if (on) BridgeService.start(context) else BridgeService.stop(context)
                        }
                    }
                    .padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("Notify when Claude needs me", color = C.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                    Text("Keeps a connection open in the background. Approve or deny from the notification.", color = C.Muted, fontSize = 12.sp)
                }
                Switch(
                    checked = notify, onCheckedChange = null,
                    colors = SwitchDefaults.colors(checkedTrackColor = C.Clay, checkedThumbColor = C.OnClay),
                )
            }
        }
    }
}

@Composable
private fun BridgeCard(kind: BridgeKind, active: Boolean, starting: Boolean, onCopy: () -> Unit, onStart: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(C.Card)
            .border(1.dp, if (active) C.Clay else C.Border, RoundedCornerShape(14.dp))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(kind.label, color = C.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                Text("Port ${kind.port}", color = C.Faint, fontSize = 12.sp, fontFamily = Mono)
            }
            if (active) Text("Connected", color = C.GreenPill, fontSize = 12.sp, fontWeight = FontWeight.Medium)
        }
        Text(kind.detail, color = C.Muted, fontSize = 13.sp, lineHeight = 18.sp)
        Row(verticalAlignment = Alignment.CenterVertically) {
            CodeBlock(kind.command, modifier = Modifier.weight(1f))
            IconBtn(R.drawable.ic_copy, "Copy ${kind.label} command", onCopy)
        }
        if (active) SecondaryButton("Pair again", onStart, modifier = Modifier.fillMaxWidth())
        else PrimaryButton(if (starting) "Starting…" else "Start ${kind.label} bridge", onStart, modifier = Modifier.fillMaxWidth(), enabled = !starting)
    }
}

@Composable
private fun SwitchRow(title: String, detail: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(C.Card)
            .border(1.dp, C.Border, RoundedCornerShape(14.dp))
            .clickable(role = Role.Switch) { onChange(!checked) }
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, color = C.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
            Text(detail, color = C.Muted, fontSize = 12.sp)
        }
        Switch(checked = checked, onCheckedChange = null, colors = SwitchDefaults.colors(checkedTrackColor = C.Clay, checkedThumbColor = C.OnClay))
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(title.uppercase(), color = C.Muted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.8.sp)
        content()
    }
}

@Composable
private fun ConnectionLine(state: ConnState) {
    val (text, color) = when (state) {
        is ConnState.Connected -> "Connected to ${state.host}" to C.GreenPill
        ConnState.Connecting -> "Connecting…" to C.Muted
        ConnState.Idle -> "Not connected" to C.Muted
        is ConnState.Failed -> state.message to C.Red
    }
    Text(text, color = color, fontSize = 13.sp)
}

@Composable
private fun Field(label: String, value: String, onChange: (String) -> Unit, keyboard: KeyboardType = KeyboardType.Text, secret: Boolean = false) {
    OutlinedTextField(
        value = value, onValueChange = onChange, label = { Text(label) }, singleLine = true,
        modifier = Modifier.fillMaxWidth(),
        keyboardOptions = KeyboardOptions(keyboardType = if (secret) KeyboardType.Password else keyboard, autoCorrectEnabled = false),
        visualTransformation = if (secret) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        shape = RoundedCornerShape(12.dp),
        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = C.Clay, unfocusedBorderColor = C.Surface3, cursorColor = C.Clay, focusedLabelColor = C.ClayText),
    )
}

/** Six options fit one row only with short names. */
private val effortShortLabels = effortLabels.map { (v, l) -> v to if (v == "xhigh") "XHigh" else if (v == "medium") "Med" else l }

private fun copy(context: Context, text: String) {
    context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("command", text))
}
