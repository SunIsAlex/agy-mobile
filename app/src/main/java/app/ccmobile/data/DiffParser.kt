package app.ccmobile.data

enum class LineKind { Context, Add, Remove, Hunk, Meta }

data class DiffLine(val kind: LineKind, val oldNo: Int?, val newNo: Int?, val text: String)

data class FileDiff(
    val path: String,
    val status: String, // modified | added | deleted | renamed | binary
    val added: Int,
    val removed: Int,
    val lines: List<DiffLine>,
)

/** Parses `git diff` unified output into per-file line lists with line numbers. */
object DiffParser {
    private val hunkHeader = Regex("""^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@""")

    fun parse(text: String): List<FileDiff> {
        val files = mutableListOf<FileDiff>()
        var path: String? = null
        var status = "modified"
        var lines = mutableListOf<DiffLine>()
        var added = 0
        var removed = 0
        var oldNo = 0
        var newNo = 0
        var inHunk = false

        fun flush() {
            path?.let { files.add(FileDiff(it, status, added, removed, lines)) }
            path = null; status = "modified"; lines = mutableListOf(); added = 0; removed = 0; inHunk = false
        }

        for (line in text.lineSequence()) {
            when {
                line.startsWith("diff --git ") -> {
                    flush()
                    path = line.substringAfter(" b/", line.removePrefix("diff --git "))
                }
                path == null -> continue
                !inHunk && line.startsWith("new file mode") -> status = "added"
                !inHunk && line.startsWith("deleted file mode") -> status = "deleted"
                !inHunk && line.startsWith("rename to ") -> { status = "renamed"; path = line.removePrefix("rename to ") }
                !inHunk && line.startsWith("Binary files") -> status = "binary"
                !inHunk && line.startsWith("--- ") -> {
                    val old = line.removePrefix("--- ")
                    if (old != "/dev/null") path = old.removePrefix("a/")
                }
                !inHunk && line.startsWith("+++ ") -> {
                    val next = line.removePrefix("+++ ")
                    if (next != "/dev/null") path = next.removePrefix("b/")
                }
                line.startsWith("@@") -> {
                    val m = hunkHeader.find(line)
                    oldNo = m?.groupValues?.get(1)?.toInt() ?: 0
                    newNo = m?.groupValues?.get(2)?.toInt() ?: 0
                    inHunk = true
                    lines.add(DiffLine(LineKind.Hunk, null, null, line))
                }
                !inHunk -> continue
                line.startsWith("+") -> { lines.add(DiffLine(LineKind.Add, null, newNo++, line.substring(1))); added++ }
                line.startsWith("-") -> { lines.add(DiffLine(LineKind.Remove, oldNo++, null, line.substring(1))); removed++ }
                line.startsWith(" ") -> lines.add(DiffLine(LineKind.Context, oldNo++, newNo++, line.substring(1)))
                line.startsWith("\\") -> lines.add(DiffLine(LineKind.Meta, null, null, line))
            }
        }
        flush()
        return files
    }
}
