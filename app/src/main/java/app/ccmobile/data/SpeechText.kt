package app.ccmobile.data

/** Turning Claude's Markdown into something to read aloud, and understanding spoken answers. */
object SpeechText {
    /** [markdown] as plain sentences: code blocks and tables summarised, links and formatting dropped. */
    fun speakable(markdown: String): String {
        var s = markdown.replace("\r", "")
        s = Regex("```[^\n]*\n.*?(```|$)", RegexOption.DOT_MATCHES_ALL).replace(s) { "\n(code)\n" }
        val lines = s.lines().map { it.trim() }
        val out = StringBuilder()
        var inTable = false
        for (raw in lines) {
            var line = raw
            if (line.startsWith("|")) {
                if (!inTable) out.append("(table)\n")
                inTable = true
                continue
            }
            inTable = false
            if (Regex("^(-{3,}|\\*{3,}|_{3,})$").matches(line)) continue
            line = line.replace(Regex("^#{1,6}\\s+"), "")
                .replace(Regex("^>\\s?"), "")
                .replace(Regex("^([-*+]|\\d+[.)])\\s+(\\[[ xX]]\\s+)?"), "")
            out.append(line).append('\n')
        }
        s = out.toString()
        s = Regex("!\\[([^]]*)]\\([^)]*\\)").replace(s) { it.groupValues[1] }
        s = Regex("\\[([^]]+)]\\([^)]*\\)").replace(s) { it.groupValues[1] }
        s = Regex("https?://\\S+").replace(s, "a link")
        s = Regex("`([^`\n]*)`").replace(s) { it.groupValues[1] }
        s = Regex("(\\*\\*|__)(.+?)\\1").replace(s) { it.groupValues[2] }
        s = Regex("(?<![\\w*])[*_]([^*_\n]+)[*_](?![\\w*])").replace(s) { it.groupValues[1] }
        s = s.replace("~~", "").replace("→", " to ").replace("—", ", ").replace("–", " to ")
        // Lines become sentences, so items of a list don't run together.
        return s.lines().map { it.trim() }.filter { it.isNotEmpty() }
            .joinToString(" ") { if (it.last() in ".!?:;,。！？：；，)") it else "$it." }
            .replace(Regex("\\s+"), " ").trim()
    }

    enum class Decision { Allow, Always, Deny }

    private val alwaysWords = Regex("\\b(always|every time)\\b|总是|一直允许|始终")
    private val denyWords = Regex("\\b(no|nope|deny|don'?t|do not|stop|cancel|reject|decline|never|keep planning)\\b|不要|不行|拒绝|别|不")
    private val allowWords = Regex("\\b(yes|yeah|yep|yup|sure|ok|okay|allow|go ahead|go for it|do it|approve|fine|please do|start|proceed|run it|affirmative)\\b|好|可以|允许|行|是|同意|开始")

    /** What a spoken answer to "Allow?" means, or null if it isn't clear. */
    fun decision(said: String): Decision? {
        val t = said.lowercase().trim()
        if (t.isEmpty()) return null
        val deny = denyWords.containsMatchIn(t)
        // "don't do it" and "never run it" aren't a yes.
        val allow = allowWords.containsMatchIn(t.replace(Regex("\\b(don'?t|do not|never|not)\\s+\\w+(\\s+(it|that|this))?"), " "))
        return when {
            alwaysWords.containsMatchIn(t) && !Regex("\\b(don'?t|not|never)\\b").containsMatchIn(t) -> Decision.Always
            deny && !allow -> Decision.Deny
            allow && !deny -> Decision.Allow
            // "No, go ahead" is ambiguous; "don't" with "ok" ("ok, don't") leans to no.
            else -> null
        }
    }

    // Ordinals first: "the third one" is the third, not the first.
    private val ordinals = listOf(listOf("first", "第一"), listOf("second", "第二"), listOf("third", "第三"), listOf("fourth", "第四"))
    private val numbers = listOf(listOf("one", "1", "一"), listOf("two", "2", "二"), listOf("three", "3", "三"), listOf("four", "4", "四"))

    /** The option a spoken answer picks (by name, or "the second one"), or null for a free answer. */
    fun pick(said: String, options: List<String>): String? {
        val t = said.lowercase().replace(Regex("[^\\p{L}\\p{N} ]"), " ").replace(Regex("\\s+"), " ").trim()
        if (t.isEmpty()) return null
        val norm = options.map { it.lowercase().replace(Regex("[^\\p{L}\\p{N} ]"), " ").replace(Regex("\\s+"), " ").trim() }
        norm.indexOfFirst { it.isNotEmpty() && (t == it || Regex("\\b${Regex.escape(it)}\\b").containsMatchIn(t)) }
            .takeIf { it >= 0 }?.let { return options[it] }
        // "option two", "the first one", "第二个"
        val words = t.split(' ')
        if (words.size <= 4) {
            for (table in listOf(ordinals, numbers)) {
                table.forEachIndexed { i, names ->
                    if (i < options.size && names.any { n -> n in words || (n.any { c -> c.code > 0x2E80 } && t.contains(n)) }) return options[i]
                }
            }
        }
        return null
    }

    private val exitWords = Regex("\\b(stop|end|exit|quit|leave|close|turn off) (the )?voice( mode)?\\b|结束语音|退出语音|关闭语音")

    /** Asking to leave voice mode ("stop voice mode", "end voice"). */
    fun isExit(said: String): Boolean = exitWords.containsMatchIn(said.lowercase())
}
