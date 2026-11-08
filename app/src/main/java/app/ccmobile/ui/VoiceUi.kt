package app.ccmobile.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.ccmobile.R
import app.ccmobile.data.VoiceInput

fun hasMicPermission(context: Context) =
    ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

/** Runs [action] once the app may use the microphone, asking first if needed. */
@Composable
fun rememberWithMic(onDenied: () -> Unit, action: () -> Unit): () -> Unit {
    val context = LocalContext.current
    val currentAction by rememberUpdatedState(action)
    val currentDenied by rememberUpdatedState(onDenied)
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) currentAction() else currentDenied()
    }
    return { if (hasMicPermission(context)) currentAction() else launcher.launch(Manifest.permission.RECORD_AUDIO) }
}

private fun joinDictation(base: String, said: String) = if (base.isBlank()) said else base.trimEnd() + " " + said

/**
 * Dictate into a text box with Claude's speech-to-text: tap to talk, tap again to stop. The words
 * appear in the box as they're recognised, after whatever was typed already.
 */
@Composable
fun MicButton(
    voice: VoiceInput, owner: String, sid: String?, text: String, onText: (String) -> Unit, onError: (String) -> Unit,
    size: Dp = 44.dp, keyterms: List<String> = emptyList(),
) {
    val state by voice.state.collectAsStateWithLifecycle()
    val mine = state?.owner == owner
    var base by remember { mutableStateOf("") }
    val currentOnText by rememberUpdatedState(onText)
    val currentOnError by rememberUpdatedState(onError)
    LaunchedEffect(mine, state?.text) {
        val said = state?.text
        if (mine && !said.isNullOrEmpty()) currentOnText(joinDictation(base, said))
    }
    // Leaving the screen keeps what was said so far.
    DisposableEffect(owner) { onDispose { if (voice.state.value?.owner == owner) voice.stop() } }
    val start = rememberWithMic({ currentOnError("Dictation needs access to the microphone.") }) {
        base = text
        voice.start(owner, sid, keyterms) { said, error ->
            if (said.isNotBlank()) currentOnText(joinDictation(base, said))
            else if (error != null) currentOnError(error)
        }
    }
    val level by animateFloatAsState(if (mine) state?.level ?: 0f else 0f, tween(100), label = "level")
    val ring = C.ClayBg
    Box(
        Modifier
            .size(size)
            .drawBehind { if (level > 0.02f) drawCircle(ring, radius = this.size.minDimension / 2 * (0.9f + level * 0.5f)) }
            .clip(RoundedCornerShape(size / 3))
            .background(if (mine) C.Clay else C.Surface2)
            .clickable(role = Role.Button) { if (mine) voice.stop() else start() }
            .semantics { contentDescription = if (mine) "Stop dictating" else "Dictate with your voice" },
        contentAlignment = Alignment.Center,
    ) {
        if (mine && state?.phase != VoiceInput.Phase.Listening) {
            CircularProgressIndicator(Modifier.size(size * 0.4f), color = C.OnClay, strokeWidth = 2.dp)
        } else {
            CcIcon(R.drawable.ic_mic, if (mine) C.OnClay else C.TextSoft, size * 0.45f)
        }
    }
}
