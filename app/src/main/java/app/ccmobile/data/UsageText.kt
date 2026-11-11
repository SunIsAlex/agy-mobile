package app.ccmobile.data

import java.time.Duration
import java.util.Locale

/** Labels and number formats for the Usage screen. */
object UsageText {
    /** 940 → "940", 12_345 → "12.3k", 653_676 → "654k", 1_240_000 → "1.24M". */
    fun compact(n: Long): String {
        fun fmt(v: Double, unit: String) = when {
            v < 10 -> String.format(Locale.US, "%.2f", v).trimEnd('0').trimEnd('.') + unit
            v < 100 -> String.format(Locale.US, "%.1f", v).removeSuffix(".0") + unit
            else -> "${Math.round(v)}$unit"
        }
        return when {
            n < 1_000 -> n.toString()
            n < 999_500 -> fmt(n / 1e3, "k")
            n < 999_500_000 -> fmt(n / 1e6, "M")
            else -> fmt(n / 1e9, "B")
        }
    }

    /** "claude-opus-5-5" → "Opus 5.5", "gemini-4-carbon" → "Gemini 4 Carbon", "gemini-4-argon" → "Gemini 4 Argon", "gpt-oss-120b" → "GPT-OSS 120B". */
    fun modelName(id: String): String {
        when (id) {
            "gemini-4-carbon" -> return "Gemini 4 Carbon"
            "gemini-4-argon" -> return "Gemini 4 Argon"
            "gemini-3.8-flash" -> return "Gemini 3.8 Flash"
            "gpt-oss-120b" -> return "GPT-OSS 120B"
        }
        if (id.startsWith("gemini-")) {
            return id.split('-').joinToString(" ") { part -> part.replaceFirstChar { it.uppercase() } }
        }
        if (!id.startsWith("claude-")) return id
        val parts = id.removePrefix("claude-").split('-').filterNot { it.length == 8 && it.all(Char::isDigit) }
        val family = parts.firstOrNull()?.takeIf { it.isNotEmpty() && it.none(Char::isDigit) } ?: return id
        val version = parts.drop(1).takeWhile { it.all(Char::isDigit) }.joinToString(".")
        return family.replaceFirstChar { it.uppercase() } + if (version.isEmpty()) "" else " $version"
    }

    /** Name and subtitle for a plan-limit window id from agy /usage or rate_limit_event. */
    fun windowLabel(id: String): Pair<String, String> = when (id) {
        "gemini-5h" -> "Gemini" to "5-hour window"
        "gemini-weekly" -> "Gemini" to "7-day window"
        "gemini-carbon-wtu-weekly" -> "Gemini 4 Carbon" to "7-day WTU window"
        "gemini-argon-wtu-weekly" -> "Gemini 4 Argon" to "7-day WTU window"
        "3p-5h" -> "Claude & GPT" to "5-hour window"
        "3p-weekly" -> "Claude & GPT" to "7-day window"
        "five_hour" -> "Current session" to "5-hour window"
        "seven_day" -> "This week" to "All models"
        "seven_day_opus" -> "This week" to "Opus"
        "seven_day_sonnet" -> "This week" to "Sonnet"
        else -> id.replace('_', ' ').replace('-', ' ').replaceFirstChar { it.uppercase() } to ""
    }

    /** 0.0 → "0%", 0.031 → "3.1%", 0.85 → "85%", 1.0 → "100%". */
    fun percent(utilization: Double): String {
        val pct = utilization.coerceIn(0.0, 1.0) * 100.0
        return when {
            pct <= 0.0 -> "0%"
            pct < 0.05 -> "<0.1%"
            pct >= 99.95 && pct < 100.0 -> "99.9%"
            pct >= 100.0 -> "100%"
            else -> String.format(Locale.US, "%.1f", pct).removeSuffix(".0") + "%"
        }
    }

    /** "in 2h 10m", "in 3d 4h", "in 5m". */
    fun until(ms: Long): String {
        val d = Duration.ofMillis(ms.coerceAtLeast(0))
        return when {
            d.toDays() >= 1 -> "in ${d.toDays()}d ${d.toHoursPart()}h"
            d.toHours() >= 1 -> "in ${d.toHours()}h ${d.toMinutesPart()}m"
            else -> "in ${d.toMinutes().coerceAtLeast(1)}m"
        }
    }

    /** Second-granularity relative time: "just now", "4s ago", "1m 12s ago". */
    fun ago(deltaMs: Long): String {
        val sec = (deltaMs.coerceAtLeast(0) / 1_000)
        return when {
            sec < 2 -> "just now"
            sec < 60 -> "${sec}s ago"
            sec < 3_600 -> "${sec / 60}m ${sec % 60}s ago"
            else -> "${sec / 3_600}h ${(sec % 3_600) / 60}m ago"
        }
    }

    /** Returns the most relevant quota window for [model] (or the default model when null). */
    fun windowForModel(model: String?, windows: List<LimitWindow>): LimitWindow? {
        if (windows.isEmpty()) return null
        val m = model?.lowercase(Locale.US).orEmpty()
        val matching = when {
            m.startsWith("claude-") || m.startsWith("gpt-") ->
                windows.filter { it.id.startsWith("3p-") || it.id == "five_hour" || it.id.startsWith("seven_day") }
            m.contains("carbon") ->
                windows.filter { it.id.contains("carbon") }.ifEmpty { windows.filter { it.id.startsWith("gemini-") } }
            m.contains("argon") ->
                windows.filter { it.id.contains("argon") }.ifEmpty { windows.filter { it.id.startsWith("gemini-") } }
            m.startsWith("gemini-") ->
                windows.filter { it.id.startsWith("gemini-") && !it.id.contains("argon") && !it.id.contains("carbon") }
                    .ifEmpty { windows.filter { it.id.startsWith("gemini-") } }
            else ->
                windows.filter { it.id.startsWith("gemini-") && !it.id.contains("argon") && !it.id.contains("carbon") }
                    .ifEmpty { windows.filter { it.id.startsWith("gemini-") } }
                    .ifEmpty { windows.filter { !it.id.startsWith("3p-") } }
        }
        val pool = matching.ifEmpty { windows }
        return pool.filter { !it.disabled }.maxByOrNull { it.utilization }
            ?: pool.maxByOrNull { it.utilization }
    }
}
