package app.ccmobile.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
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
import androidx.compose.ui.draw.scale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.ccmobile.R
import app.ccmobile.data.Approval
import app.ccmobile.data.AssistantItem
import app.ccmobile.data.Repository
import app.ccmobile.data.SpeechText
import app.ccmobile.data.TurnEndItem
import app.ccmobile.data.VoiceInput
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull

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

// ---------- voice mode ----------

private enum class Phase(val label: String) {
    Starting("Starting voice mode…"),
    Listening("Listening"),
    Sending("Sending"),
    Working("Claude is working"),
    Speaking("Claude"),
    Asking("Claude is asking"),
    WaitingTap("Answer on screen"),
    Paused("Paused"),
}

/** Talk with Claude hands-free: listens, sends when you pause, reads the reply, and listens again. */
private class VoiceConversation(private val repo: Repository, private val sid: String, private val speaker: Speaker) {
    var phase by mutableStateOf(Phase.Starting)
    /** What the user is saying, or said last. */
    var heard by mutableStateOf("")
    /** What Claude is saying (the reply or a question). */
    var spoken by mutableStateOf("")
    var error by mutableStateOf<String?>(null)
    private var talk = false
    private var finishNow = false
    private val voice = repo.voice
    private val owner = "voice:$sid"

    fun talkNow() { talk = true }
    fun sendNow() { finishNow = true }
    fun skip() { speaker.stop() }

    private fun session() = repo.sessions.value.firstOrNull { it.id == sid }
    private fun working() = session()?.status == "working"
    private fun approval(): Approval? = repo.approvals.value.firstOrNull { it.sid == sid }
    private suspend fun waitUntil(timeoutMs: Long = Long.MAX_VALUE, done: () -> Boolean) {
        withTimeoutOrNull(timeoutMs) { while (!done()) delay(200) }
    }

    /** The newest finished turn after [after]: its key and what to say, or null. */
    private fun reply(after: String?): Pair<String, String>? {
        val items = repo.items.value[sid] ?: return null
        val end = items.indexOfLast { it is TurnEndItem }
        if (end < 0 || items[end].key == after) return null
        val from = items.indexOfFirst { it.key == after } + 1
        if (from > end) return null
        val text = items.subList(from, end).filterIsInstance<AssistantItem>().lastOrNull()?.text
        val turnEnd = items[end] as TurnEndItem
        return turnEnd.key to when {
            turnEnd.error -> listOfNotNull(text, turnEnd.text).joinToString("\n\n")
            text != null -> text
            else -> "Done."
        }
    }

    /** One utterance, ended by a pause (or [sendNow]); "" if nothing was said, null if [abort]ed. */
    private suspend fun listen(abort: () -> Boolean = { false }): String? {
        heard = ""
        finishNow = false
        val result = CompletableDeferred<Pair<String, String?>>()
        voice.start(owner, sid) { said, err -> result.complete(said to err) }
        try {
            while (!result.isCompleted) {
                val st = voice.state.value
                if (st?.owner == owner) {
                    heard = st.text
                    val quiet = System.currentTimeMillis() - st.changedAt
                    val pause = if (st.text.isNotBlank()) quiet > PAUSE_MS else quiet > SILENCE_MS
                    if (st.phase == VoiceInput.Phase.Listening && (pause || finishNow)) voice.stop()
                }
                if (abort()) { voice.cancel(); return null }
                delay(100)
            }
            val (said, err) = result.await()
            heard = said
            if (err != null && said.isBlank()) error = err
            return said
        } finally {
            if (!result.isCompleted) voice.cancel()
        }
    }

    private suspend fun say(text: String) {
        spoken = text
        if (!speaker.speak(SpeechText.speakable(text))) error = "This phone has no text-to-speech voice. Install one in Android's settings."
    }

    suspend fun run(onExit: () -> Unit) {
        waitUntil { repo.items.value[sid] != null }
        // Replies from before voice mode aren't read out.
        var lastTurn = repo.items.value[sid]?.lastOrNull { it is TurnEndItem }?.key
        val asked = mutableSetOf<String>()
        var paused = false
        while (true) {
            val a = approval()
            if (a != null) {
                if (a.requestId !in asked) { asked += a.requestId; ask(a) } else {
                    phase = Phase.WaitingTap
                    waitUntil { approval()?.requestId != a.requestId }
                }
                continue
            }
            if (working()) {
                phase = Phase.Working
                talk = false
                waitUntil { !working() || approval() != null || talk }
                if (talk) {
                    // Steering while Claude works: the message waits for its next step.
                    talk = false
                    phase = Phase.Listening
                    val said = listen { approval() != null }
                    if (!said.isNullOrBlank()) {
                        if (SpeechText.isExit(said)) { onExit(); return }
                        repo.sendMessage(sid, said)
                    }
                }
                continue
            }
            val r = reply(lastTurn)
            if (r != null) {
                lastTurn = r.first
                phase = Phase.Speaking
                say(r.second)
                continue
            }
            if (paused) {
                phase = Phase.Paused
                talk = false
                waitUntil { talk || approval() != null || working() || reply(lastTurn) != null }
                if (talk) paused = false
                continue
            }
            phase = Phase.Listening
            error = null
            val said = listen { approval() != null } ?: continue
            if (said.isBlank()) { paused = true; continue }
            if (SpeechText.isExit(said)) { onExit(); return }
            phase = Phase.Sending
            repo.sendMessage(sid, said)
            waitUntil(15_000) { working() || approval() != null || reply(lastTurn) != null }
        }
    }

    /** Reads a permission request or Claude's questions aloud and takes a spoken answer. */
    private suspend fun ask(a: Approval) {
        phase = Phase.Asking
        val still = { approval()?.requestId == a.requestId }
        if (a.questions.isNotEmpty()) {
            val answers = mutableMapOf<String, String>()
            for (q in a.questions) {
                val options = q.options.mapIndexed { i, o -> "${i + 1}: ${o.label}." }.joinToString(" ")
                say("${q.question} $options")
                if (!still()) return
                val said = listen { !still() } ?: return
                if (said.isBlank()) return // left for the screen
                answers[q.question] = SpeechText.pick(said, q.options.map { it.label }) ?: said
            }
            if (still()) repo.answerQuestions(a, answers)
            return
        }
        val plan = a.toolName == "ExitPlanMode"
        say(
            if (plan) "Claude has a plan. ${a.detail.take(1500)}\n\nShould Claude start?"
            else "Claude wants to use ${a.toolName}: ${a.summary.take(200)}. Allow it?",
        )
        repeat(2) { attempt ->
            if (!still()) return
            val said = listen { !still() } ?: return
            when (SpeechText.decision(said)) {
                SpeechText.Decision.Allow -> { repo.answer(a, allow = true); return }
                SpeechText.Decision.Always -> { repo.answer(a, allow = true, always = a.canAlways); return }
                SpeechText.Decision.Deny -> { repo.answer(a, allow = false); return }
                null -> if (attempt == 0 && said.isNotBlank()) say(if (plan) "Say start, or keep planning." else "Say yes or no.")
            }
        }
    }

    companion object {
        /** Silence after speech that sends the message. */
        const val PAUSE_MS = 1_600L
        /** Nobody speaking for this long pauses voice mode. */
        const val SILENCE_MS = 30_000L
    }
}

/** Voice mode in place of the reply box: a hands-free conversation with the task. */
@Composable
fun VoiceModePanel(repository: Repository, sid: String, onExit: () -> Unit) {
    val context = LocalContext.current
    val speaker = remember { Speaker(context) }
    val conversation = remember(sid) { VoiceConversation(repository, sid, speaker) }
    val currentExit by rememberUpdatedState(onExit)
    val view = LocalView.current
    DisposableEffect(Unit) {
        view.keepScreenOn = true
        onDispose {
            view.keepScreenOn = false
            if (repository.voice.state.value?.owner == "voice:$sid") repository.voice.cancel()
            speaker.shutdown()
        }
    }
    LaunchedEffect(sid) { conversation.run { currentExit() } }

    val voiceState by repository.voice.state.collectAsStateWithLifecycle()
    val sessions by repository.sessions.collectAsStateWithLifecycle()
    val level by animateFloatAsState(
        if (voiceState?.owner == "voice:$sid") voiceState?.level ?: 0f else 0f, tween(100), label = "level",
    )
    val phase = conversation.phase
    val pulse by rememberInfiniteTransition(label = "pulse").animateFloat(
        0.92f, 1.08f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "pulse",
    )
    Column(
        Modifier
            .padding(8.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(22.dp))
            .background(C.Surface)
            .border(1.dp, C.BorderStrong, RoundedCornerShape(22.dp))
            .padding(14.dp)
            .semantics(mergeDescendants = false) { contentDescription = "Voice mode" },
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            val ring = C.ClayBg
            Box(
                Modifier
                    .size(52.dp)
                    .drawBehind { if (phase == Phase.Listening) drawCircle(ring, radius = size.minDimension / 2 * (1f + level * 0.6f)) }
                    .scale(if (phase == Phase.Speaking) pulse else 1f)
                    .clip(CircleShape)
                    .background(if (phase == Phase.Paused || phase == Phase.WaitingTap) C.Surface3 else C.Clay),
                contentAlignment = Alignment.Center,
            ) {
                when (phase) {
                    Phase.Working, Phase.Sending, Phase.Starting -> CircularProgressIndicator(Modifier.size(22.dp), color = C.OnClay, strokeWidth = 2.dp)
                    Phase.Speaking -> CcIcon(R.drawable.ic_voice, C.OnClay, 24.dp)
                    else -> CcIcon(R.drawable.ic_mic, if (phase == Phase.Paused || phase == Phase.WaitingTap) C.TextSoft else C.OnClay, 24.dp)
                }
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    when (phase) {
                        Phase.Listening -> if (conversation.heard.isEmpty()) "Listening… say something" else "Listening"
                        Phase.Paused -> "Paused. Tap Talk to go on."
                        Phase.WaitingTap -> "Answer on screen"
                        else -> phase.label
                    },
                    color = C.Text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold,
                )
                val detail = when (phase) {
                    Phase.Speaking, Phase.Asking -> if (voiceState?.owner == "voice:$sid") conversation.heard.ifEmpty { conversation.spoken } else conversation.spoken
                    Phase.Working -> sessions.firstOrNull { it.id == sid }?.lastActivity.orEmpty()
                        .ifEmpty { "Tap Talk to tell Claude something while it works." }
                    else -> conversation.heard
                }
                if (detail.isNotEmpty()) {
                    Box(Modifier.heightIn(max = 110.dp).verticalScroll(rememberScrollState(), reverseScrolling = true)) {
                        Text(detail, color = C.TextSoft, fontSize = 14.sp, lineHeight = 20.sp)
                    }
                }
                conversation.error?.let { Text(it, color = C.Red, fontSize = 13.sp, lineHeight = 18.sp) }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SecondaryButton("End voice", onExit, Modifier.weight(1f))
            when (phase) {
                Phase.Listening -> PrimaryButton("Send now", conversation::sendNow, Modifier.weight(1f), enabled = conversation.heard.isNotBlank())
                Phase.Speaking -> PrimaryButton("Skip", conversation::skip, Modifier.weight(1f))
                Phase.Asking -> PrimaryButton("Skip", conversation::skip, Modifier.weight(1f), enabled = voiceState?.owner != "voice:$sid")
                Phase.Working, Phase.Paused -> PrimaryButton("Talk", conversation::talkNow, Modifier.weight(1f))
                else -> {}
            }
        }
        Text(
            "Speech is transcribed by Claude, through your Claude login on the bridge. Say “end voice mode” to stop.",
            color = C.Faint, fontSize = 11.sp, lineHeight = 15.sp,
        )
    }
}
