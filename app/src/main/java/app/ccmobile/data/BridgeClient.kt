package app.ccmobile.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import java.io.BufferedWriter
import java.io.IOException
import java.net.ConnectException
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.UnknownHostException

data class BridgeConfig(val host: String, val port: Int, val token: String)

sealed interface ConnState {
    data object Idle : ConnState
    data object Connecting : ConnState
    data class Connected(val host: String) : ConnState
    /** [refused]: nothing listens on the port, so the bridge isn't running (see BridgeService). */
    data class Failed(val message: String, val retrying: Boolean, val refused: Boolean = false) : ConnState
}

/** Longest bridge message the app reads; the bridge keeps history well under this. */
private const val MAX_LINE_CHARS = 16_000_000

/** One NDJSON connection to ccm-bridge, reconnecting with backoff until [disconnect]. */
class BridgeClient(private val scope: CoroutineScope) {
    private val _state = MutableStateFlow<ConnState>(ConnState.Idle)
    val state: StateFlow<ConnState> = _state.asStateFlow()

    private val _events = MutableSharedFlow<JsonObject>(extraBufferCapacity = 512)
    val events: SharedFlow<JsonObject> = _events.asSharedFlow()

    private var job: Job? = null
    @Volatile private var socket: Socket? = null
    @Volatile private var writer: BufferedWriter? = null
    private val writeLock = Mutex()

    fun connect(config: BridgeConfig) {
        disconnect()
        job = scope.launch(Dispatchers.IO) { runLoop(config) }
    }

    fun disconnect() {
        job?.cancel()
        job = null
        runCatching { socket?.close() } // unblocks reader.next()
        _state.value = ConnState.Idle
    }

    suspend fun send(message: JsonObject): Boolean = withContext(Dispatchers.IO) {
        writeLock.withLock {
            val w = writer ?: return@withLock false
            try {
                w.write(message.toString())
                w.write("\n")
                w.flush()
                true
            } catch (e: IOException) {
                false
            }
        }
    }

    private suspend fun runLoop(config: BridgeConfig) {
        var backoff = 1_000L
        while (currentCoroutineContext().isActive) {
            _state.value = ConnState.Connecting
            val s = Socket()
            socket = s
            try {
                s.connect(InetSocketAddress(config.host, config.port), 5_000)
                s.keepAlive = true
                val reader = LineReader(s.getInputStream().reader(), MAX_LINE_CHARS)
                writer = s.getOutputStream().bufferedWriter()
                send(JsonObject(mapOf("op" to JsonPrimitive("hello"), "token" to JsonPrimitive(config.token))))
                while (true) {
                    val line = when (val l = reader.next() ?: break) {
                        is LineReader.Line.Text -> l.text
                        is LineReader.Line.TooLong -> {
                            val mb = "%.0f".format(l.chars / 1e6)
                            _events.emit(JsonObject(mapOf("ev" to JsonPrimitive("error"), "message" to JsonPrimitive("Skipped a $mb MB message from the bridge: too large for this phone."))))
                            continue
                        }
                    }
                    val obj = runCatching { json.parseToJsonElement(line).jsonObject }.getOrNull() ?: continue
                    when (obj.str("ev")) {
                        "hello" -> {
                            _state.value = ConnState.Connected(obj.str("host") ?: config.host)
                            backoff = 1_000L
                        }
                        "error" -> if (obj.str("message") == "Unauthorized") {
                            _state.value = ConnState.Failed("The bridge rejected the token. Pair again.", retrying = false)
                            return
                        }
                    }
                    _events.emit(obj)
                }
                _state.value = ConnState.Failed("The bridge closed the connection.", retrying = true)
            } catch (e: IOException) {
                if (!currentCoroutineContext().isActive) return
                _state.value = ConnState.Failed(describe(e, config), retrying = true, refused = e is ConnectException)
            } finally {
                writer = null
                runCatching { s.close() }
            }
            delay(backoff)
            backoff = (backoff * 2).coerceAtMost(15_000L)
        }
    }

    private fun describe(e: IOException, config: BridgeConfig): String = when (e) {
        is ConnectException -> "Nothing is listening on ${config.host}:${config.port}. Is the bridge running?"
        is SocketTimeoutException -> "Timed out reaching ${config.host}:${config.port}."
        is UnknownHostException -> "Unknown host ${config.host}."
        else -> e.message ?: "Connection failed."
    }
}
