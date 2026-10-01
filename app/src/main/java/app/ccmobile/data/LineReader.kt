package app.ccmobile.data

import java.io.Reader

/**
 * Reads newline-terminated lines like BufferedReader.readLine(), but a line longer than
 * [maxChars] is skipped instead of buffered. One oversized message from the bridge (a 61 MB
 * session history) used to crash the app with OutOfMemoryError.
 */
class LineReader(private val reader: Reader, private val maxChars: Int) {
    sealed interface Line {
        data class Text(val text: String) : Line
        data class TooLong(val chars: Long) : Line
    }

    private val buf = CharArray(64 * 1024)
    private var pos = 0
    private var len = 0

    /** The next line, or null at end of stream (a final line without a newline is dropped). */
    fun next(): Line? {
        val sb = StringBuilder()
        var skipped = -1L // the line's length so far, once it's over the limit
        while (true) {
            if (pos == len) {
                len = reader.read(buf).coerceAtLeast(0)
                pos = 0
                if (len == 0) return null
            }
            var end = pos
            while (end < len && buf[end] != '\n') end++
            val n = end - pos
            if (skipped < 0 && sb.length + n <= maxChars) {
                sb.appendRange(buf, pos, end)
            } else {
                if (skipped < 0) {
                    skipped = sb.length.toLong()
                    sb.setLength(0)
                    sb.trimToSize()
                }
                skipped += n
            }
            pos = end
            if (end < len) {
                pos++ // the newline
                return if (skipped >= 0) Line.TooLong(skipped) else Line.Text(sb.toString())
            }
        }
    }
}
