package app.ccmobile.ui

import android.content.Context
import android.media.AudioAttributes
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/** Reads text aloud with the phone's text-to-speech; [speak] returns once it has been said (or stopped). */
class Speaker(context: Context) {
    private val ready = CompletableDeferred<Boolean>()
    private val pending = ConcurrentHashMap<String, CompletableDeferred<Unit>>()
    private var counter = 0
    private val tts: TextToSpeech = TextToSpeech(context.applicationContext) { status -> ready.complete(status == TextToSpeech.SUCCESS) }

    init {
        tts.setAudioAttributes(
            AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build(),
        )
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(id: String) {}
            override fun onDone(id: String) { pending.remove(id)?.complete(Unit) }
            @Deprecated("Deprecated in Java")
            override fun onError(id: String) { pending.remove(id)?.complete(Unit) }
            override fun onError(id: String, errorCode: Int) { pending.remove(id)?.complete(Unit) }
            override fun onStop(id: String, interrupted: Boolean) { pending.remove(id)?.complete(Unit) }
        })
    }

    /** Says [text]; false if the phone has no working text-to-speech. */
    suspend fun speak(text: String): Boolean {
        if (withTimeoutOrNull(5_000) { ready.await() } != true) return false
        val chunks = chunks(text)
        if (chunks.isEmpty()) return true
        tts.language = localeFor(text)
        var last: CompletableDeferred<Unit>? = null
        for (chunk in chunks) {
            val id = "u${counter++}"
            val done = CompletableDeferred<Unit>()
            pending[id] = done
            if (tts.speak(chunk, TextToSpeech.QUEUE_ADD, null, id) != TextToSpeech.SUCCESS) {
                pending.remove(id)
                return false
            }
            last = done
        }
        last?.await()
        return true
    }

    /** Stops speaking; a [speak] in progress returns. */
    fun stop() {
        tts.stop()
        pending.values.forEach { it.complete(Unit) }
        pending.clear()
    }

    fun shutdown() {
        stop()
        tts.shutdown()
    }

    private fun chunks(text: String): List<String> {
        val max = TextToSpeech.getMaxSpeechInputLength() - 100
        val out = mutableListOf<String>()
        var rest = text.trim()
        while (rest.length > max) {
            val cut = rest.lastIndexOfAny(charArrayOf('.', '!', '?', '。', ' '), max).takeIf { it > max / 2 } ?: max
            out += rest.substring(0, cut + 1).trim()
            rest = rest.substring(cut + 1).trim()
        }
        if (rest.isNotEmpty()) out += rest
        return out
    }

    /** Chinese text in a Chinese voice; otherwise the phone's language, or English if that isn't a Latin script. */
    private fun localeFor(text: String): Locale {
        val han = text.count { Character.UnicodeScript.of(it.code) == Character.UnicodeScript.HAN }
        if (han > text.length / 10) return Locale.SIMPLIFIED_CHINESE
        val phone = Locale.getDefault()
        return if (phone.language in listOf("zh", "ja", "ko", "ru", "ar", "hi", "th", "he", "el", "uk")) Locale.US else phone
    }
}
