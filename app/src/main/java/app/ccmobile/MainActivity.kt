package app.ccmobile

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
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
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import app.ccmobile.data.ConnState
import app.ccmobile.data.Repository
import app.ccmobile.notify.BridgeService
import app.ccmobile.notify.Notifier
import app.ccmobile.ui.C
import app.ccmobile.ui.CcTheme
import app.ccmobile.ui.DiffScreen
import app.ccmobile.ui.SessionScreen
import app.ccmobile.ui.SettingsScreen
import app.ccmobile.ui.TasksScreen
import app.ccmobile.ui.UsageScreen
import app.ccmobile.ui.ProcessesScreen

sealed interface Screen {
    data object Tasks : Screen
    data class Session(val sid: String) : Screen
    data class Diff(val sid: String) : Screen
    data object Settings : Screen
    data object Usage : Screen
    data object Processes : Screen
}

class Nav : ViewModel() {
    val stack = mutableStateListOf<Screen>(Screen.Tasks)
    fun push(screen: Screen) { if (stack.lastOrNull() != screen) stack.add(screen) }
    fun pop() { if (stack.size > 1) stack.removeAt(stack.lastIndex) }
}

data class PairRequest(val host: String, val port: Int, val token: String)

class MainActivity : ComponentActivity() {
    private val nav: Nav by viewModels()
    private var pairRequest by mutableStateOf<PairRequest?>(null)
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        repository.settings.notify = granted
        if (granted) BridgeService.start(this)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val repository = this.repository
        if (savedInstanceState == null) {
            if (repository.settings.config() == null) nav.push(Screen.Settings)
            handleIntent(intent)
        }
        if (savedInstanceState == null) startNotifications()

        setContent {
            CcTheme {
                AppRoot(repository, nav)
                pairRequest?.let { req ->
                    AlertDialog(
                        onDismissRequest = { pairRequest = null },
                        title = { Text("Connect to this bridge?") },
                        text = { Text("${req.host}:${req.port}\n\nOnly accept if you just ran ccm-bridge --pair yourself.") },
                        confirmButton = {
                            TextButton(onClick = {
                                repository.pair(req.host, req.port, req.token)
                                pairRequest = null
                                startNotifications()
                                nav.stack.clear()
                                nav.stack.add(Screen.Tasks)
                            }) { Text("Connect") }
                        },
                        dismissButton = { TextButton(onClick = { pairRequest = null }) { Text("Cancel") } },
                    )
                }
            }
        }
    }

    /**
     * Notifications are on by default, but Android 13+ needs the permission first. Asks once;
     * a denial turns the setting off, so the app doesn't ask again on every launch.
     */
    private fun startNotifications() {
        val settings = repository.settings
        if (!settings.notify || settings.config() == null) return
        if (Notifier.canPost(this)) BridgeService.start(this)
        else if (Build.VERSION.SDK_INT >= 33) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        else settings.notify = false
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        repository.foreground.value = true
        if (repository.client.state.value is ConnState.Failed) repository.connect()
    }

    override fun onStop() {
        repository.foreground.value = false
        super.onStop()
    }

    private fun handleIntent(intent: Intent?) {
        intent?.getStringExtra(Notifier.EXTRA_SID)?.let { nav.push(Screen.Session(it)) }
        val uri: Uri = intent?.data ?: return
        if (uri.scheme == "ccmobile" && uri.host == "pair") {
            val host = uri.getQueryParameter("host")
            val port = uri.getQueryParameter("port")?.toIntOrNull()
            val token = uri.getQueryParameter("token")
            if (!host.isNullOrBlank() && port != null && !token.isNullOrBlank()) pairRequest = PairRequest(host, port, token)
        }
    }
}

@Composable
private fun AppRoot(repository: Repository, nav: Nav) {
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(Unit) { repository.errors.collect { snackbar.showSnackbar(it) } }
    BackHandler(enabled = nav.stack.size > 1) { nav.pop() }

    Box(Modifier.fillMaxSize()) {
        when (val screen = nav.stack.last()) {
            Screen.Tasks -> TasksScreen(
                repository, onOpen = { nav.push(Screen.Session(it)) },
                onSettings = { nav.push(Screen.Settings) }, onUsage = { nav.push(Screen.Usage) },
                onProcesses = { nav.push(Screen.Processes) },
            )
            is Screen.Session -> SessionScreen(repository, screen.sid, onBack = nav::pop, onDiff = { nav.push(Screen.Diff(screen.sid)) })
            is Screen.Diff -> DiffScreen(repository, screen.sid, onBack = nav::pop)
            Screen.Usage -> UsageScreen(repository, onBack = nav::pop)
            Screen.Processes -> ProcessesScreen(repository, onBack = nav::pop, onOpenTask = { nav.push(Screen.Session(it)) })
            Screen.Settings -> SettingsScreen(repository, onBack = if (nav.stack.size > 1) nav::pop else null)
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 80.dp)) {
            Snackbar(it, containerColor = C.Surface3, contentColor = C.Text)
        }
    }
}
