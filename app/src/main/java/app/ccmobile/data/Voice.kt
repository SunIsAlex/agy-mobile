package app.ccmobile.data

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.Locale
import java.util.UUID
import kotlin.math.sqrt

/**
 * Dictation through Claude's own speech-to-text, the one Claude Code's /voice uses: the phone
 * records 16 kHz mono PCM and the bridge streams it to Claude's speech service with the CLI's
 * claude.ai login (see bridge/voice.mjs). One recording at a time, app-wide.
 */
class VoiceInput(
    private val scope: CoroutineScope,
    private val send: suspend (op: String, fields: Array<out Pair<String, Any?>>) -> Boolean,
    /** Asks the bridge to start a recording; returns its error, or null once it has. */
    private val open: suspend (fields: Array<out Pair<String, Any?>>) -> String?,
) {
    enum class Phase { Connecting, Listening, Finishing }

    /**
     * A recording: who started it ([owner], e.g. a task id), the words so far, the input level
     * (0..1) and when the words last changed (for ending on a pause).
     */
    data class State(val id: String, val owner: String, val phase: Phase, val text: String = "", val level: Float = 0f, val changedAt: Long = 0)

    private val _state = MutableStateFlow<State?>(null)
    val state: StateFlow<State?> = _state.asStateFlow()

    private var recorder: Job? = null
    private var onDone: ((text: String, error: String?) -> Unit)? = null
    private var error: String? = null

    /**
     * Starts listening for [owner]. [onDone] gets the whole transcript when the recording ends
     * (after [stop], or an error), unless it was cancelled. Needs the RECORD_AUDIO permission.
     */
    @SuppressLint("MissingPermission")
    fun start(owner: String, sid: String?, keyterms: List<String> = emptyList(), onDone: (text: String, error: String?) -> Unit) {
        cancel()
        val id = UUID.randomUUID().toString()
        this.onDone = onDone
        error = null
        _state.value = State(id, owner, Phase.Connecting, changedAt = System.currentTimeMillis())
        recorder = scope.launch {
            // Recording starts at once, so the first words aren't lost while the bridge connects.
            launch {
                val failed = open(arrayOf(
                    "id" to id, "sid" to sid, "language" to Locale.getDefault().language,
                    "keyterms" to JsonArray(keyterms.map(::JsonPrimitive)),
                ))
                if (failed != null) finish(id, "", failed)
            }
            val failed = withContext(Dispatchers.IO) { record(id) }
            if (failed != null) {
                send("voice_cancel", arrayOf("id" to id))
                finish(id, "", failed)
            }
        }
    }

    /** Streams the microphone to the bridge until the recording [id] stops; returns an error, or null. */
    @SuppressLint("MissingPermission")
    private suspend fun record(id: String): String? {
        val minBuf = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = try {
            AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minBuf, CHUNK_BYTES * 4))
        } catch (e: Exception) { null }
        if (rec == null || rec.state != AudioRecord.STATE_INITIALIZED) {
            rec?.release()
            return "Couldn't open the microphone."
        }
        val buf = ByteArray(CHUNK_BYTES)
        try {
            rec.startRecording()
            while (currentCoroutineContext().isActive && _state.value?.let { it.id == id && it.phase != Phase.Finishing } == true) {
                var n = 0
                while (n < buf.size) {
                    val r = rec.read(buf, n, buf.size - n)
                    if (r <= 0) break
                    n += r
                }
                if (n <= 0) return "The microphone stopped."
                send("voice_audio", arrayOf("id" to id, "data" to Base64.encodeToString(buf, 0, n, Base64.NO_WRAP)))
                val level = level(buf, n)
                _state.update { if (it?.id == id && it.phase != Phase.Finishing) it.copy(level = level) else it }
            }
        } finally {
            runCatching { rec.stop() }
            rec.release()
        }
        return null
    }

    /** Stops recording; the last words still come back, then onDone. */
    fun stop() {
        val s = _state.value ?: return
        if (s.phase == Phase.Finishing) return
        _state.update { if (it?.id == s.id) it.copy(phase = Phase.Finishing, level = 0f) else it }
        scope.launch {
            if (!send("voice_stop", arrayOf("id" to s.id))) finish(s.id, s.text, null)
            // The bridge gives up after 5 s; don't wait forever if its answer is lost.
            delay(8_000)
            finish(s.id, _state.value?.text ?: s.text, null)
        }
    }

    /** Stops without a result. */
    fun cancel() {
        val s = _state.value ?: return
        _state.value = null
        onDone = null
        recorder?.cancel()
        scope.launch { send("voice_cancel", arrayOf("id" to s.id)) }
    }

    /** A 'voice' event from the bridge. */
    fun onEvent(ev: JsonObject) {
        val s = _state.value ?: return
        if (ev.str("id") != s.id) return
        when (ev.str("type")) {
            "ready" -> _state.update { if (it?.id == s.id && it.phase == Phase.Connecting) it.copy(phase = Phase.Listening) else it }
            "transcript" -> {
                val text = ev.str("text").orEmpty()
                _state.update { if (it?.id == s.id && it.text != text) it.copy(text = text, changedAt = System.currentTimeMillis()) else it }
            }
            "error" -> error = ev.str("message")
            "closed" -> finish(s.id, ev.str("text") ?: s.text, error)
        }
    }

    private fun finish(id: String, text: String, error: String?) {
        if (_state.value?.id != id) return
        _state.value = null
        recorder?.cancel()
        val done = onDone
        onDone = null
        done?.invoke(text, error)
    }

    private fun level(buf: ByteArray, n: Int): Float {
        var sum = 0.0
        var i = 0
        while (i + 1 < n) {
            val v = (buf[i].toInt() and 0xff) or (buf[i + 1].toInt() shl 8)
            sum += v.toDouble() * v
            i += 2
        }
        val rms = sqrt(sum / (n / 2).coerceAtLeast(1)) / 32768.0
        return (rms * 8).coerceIn(0.0, 1.0).toFloat()
    }

    companion object {
        const val RATE = 16_000
        /** 100 ms of audio. */
        const val CHUNK_BYTES = RATE * 2 / 10
    }
}
