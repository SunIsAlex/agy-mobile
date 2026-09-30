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

    /** "claude-opus-5-5" → "Opus 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5". */
    fun modelName(id: String): String {
        if (!id.startsWith("claude-")) return id
        val parts = id.removePrefix("claude-").split('-').filterNot { it.length == 8 && it.all(Char::isDigit) }
        val family = parts.firstOrNull()?.takeIf { it.isNotEmpty() && it.none(Char::isDigit) } ?: return id
        val version = parts.drop(1).takeWhile { it.all(Char::isDigit) }.joinToString(".")
        return family.replaceFirstChar { it.uppercase() } + if (version.isEmpty()) "" else " $version"
    }

    /** Name and subtitle for a plan-limit window id from rate_limit_event. */
    fun windowLabel(id: String): Pair<String, String> = when (id) {
        "five_hour" -> "Current session" to "5-hour window"
        "seven_day" -> "This week" to "All models"
        "seven_day_opus" -> "This week" to "Opus"
        "seven_day_sonnet" -> "This week" to "Sonnet"
        else -> id.replace('_', ' ').replaceFirstChar { it.uppercase() } to ""
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
}
