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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.ccmobile.R
import app.ccmobile.data.ConnState
import app.ccmobile.data.Repository
import app.ccmobile.notify.BridgeService
import app.ccmobile.notify.Notifier

const val SETUP_COMMAND = "node ~/claude-code-mobile/bridge/ccm-bridge.mjs --pair"

@Composable
fun SettingsScreen(repository: Repository, onBack: (() -> Unit)?) {
    val settings = repository.settings
    val context = LocalContext.current
    val conn by repository.client.state.collectAsStateWithLifecycle()

    var host by remember { mutableStateOf(settings.host) }
    var port by remember { mutableStateOf(settings.port.toString()) }
    var token by remember { mutableStateOf(settings.token) }
    var mode by remember { mutableStateOf(settings.mode) }
    var model by remember { mutableStateOf(settings.model) }
    var notify by remember { mutableStateOf(settings.notify && Notifier.canPost(context)) }

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

            Section("Connect") {
                Text("Run this in Termux. It opens this app and pairs it:", color = C.TextSoft, fontSize = 14.sp)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CodeBlock(SETUP_COMMAND, modifier = Modifier.weight(1f))
                    IconBtn(R.drawable.ic_copy, "Copy command", { copy(context, SETUP_COMMAND) })
                }
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

            Section("Default permissions for new tasks") {
                Segmented(modeLabels, mode, { mode = it; settings.mode = it })
                Text(modeDescription(mode), color = if (mode == YOLO) C.Red else C.Muted, fontSize = 13.sp)
            }

            Section("Default model") {
                Segmented(modelLabels, model, { model = it; settings.model = it })
            }

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
                    colors = SwitchDefaults.colors(checkedTrackColor = C.Clay, checkedThumbColor = C.Bg),
                )
            }
        }
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

private fun copy(context: Context, text: String) {
    context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("command", text))
}
