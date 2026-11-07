package app.ccmobile.data

import org.junit.Assert.assertEquals
import org.junit.Test

class UsageTextTest {
    @Test fun compactNumbers() {
        assertEquals("940", UsageText.compact(940))
        assertEquals("1k", UsageText.compact(1_000))
        assertEquals("12.3k", UsageText.compact(12_345))
        assertEquals("654k", UsageText.compact(653_676))
        assertEquals("1M", UsageText.compact(999_600))
        assertEquals("1.24M", UsageText.compact(1_240_000))
        assertEquals("30.2M", UsageText.compact(30_224_135))
    }

    @Test fun modelNames() {
        assertEquals("Opus 5.5", UsageText.modelName("claude-opus-5-5"))
        assertEquals("Haiku 4.5", UsageText.modelName("claude-haiku-4-5-20251001"))
        assertEquals("Sonnet 5", UsageText.modelName("claude-sonnet-5"))
        assertEquals("Haiku 5.5", UsageText.modelName("claude-haiku-5-5"))
        assertEquals("Gemini 4 Argon", UsageText.modelName("gemini-4-argon"))
        assertEquals("Gemini 3.8 Flash", UsageText.modelName("gemini-3.8-flash"))
        assertEquals("GPT-OSS 120B", UsageText.modelName("gpt-oss-120b"))
        assertEquals("unknown", UsageText.modelName("unknown"))
    }

    @Test fun windowLabels() {
        assertEquals("Gemini" to "5-hour window", UsageText.windowLabel("gemini-5h"))
        assertEquals("Gemini 4 Argon" to "7-day WTU window", UsageText.windowLabel("gemini-argon-wtu-weekly"))
        assertEquals("Claude & GPT" to "5-hour window", UsageText.windowLabel("3p-5h"))
    }

    @Test fun durations() {
        assertEquals("in 1m", UsageText.until(5_000))
        assertEquals("in 2h 10m", UsageText.until((2 * 60 + 10) * 60_000L))
        assertEquals("in 3d 4h", UsageText.until(((3 * 24 + 4) * 60) * 60_000L))
    }

    @Test fun percentagesAndAgo() {
        assertEquals("0%", UsageText.percent(0.0))
        assertEquals("<0.1%", UsageText.percent(0.0002))
        assertEquals("3.1%", UsageText.percent(0.031))
        assertEquals("12.8%", UsageText.percent(0.128))
        assertEquals("85%", UsageText.percent(0.85))
        assertEquals("100%", UsageText.percent(1.0))

        assertEquals("just now", UsageText.ago(500))
        assertEquals("4s ago", UsageText.ago(4_200))
        assertEquals("1m 12s ago", UsageText.ago(72_000))
    }

    @Test fun windowForModelSelectsMatchingQuotaFamily() {
        val windows = listOf(
            LimitWindow("gemini-5h", 0.031, 1000L),
            LimitWindow("gemini-weekly", 0.004, 2000L),
            LimitWindow("3p-5h", 0.0, 0L, disabled = true),
            LimitWindow("3p-weekly", 1.0, 3000L),
            LimitWindow("gemini-argon-wtu-weekly", 0.128, 4000L),
        )
        assertEquals("gemini-5h", UsageText.windowForModel("gemini-3.8-flash", windows)?.id)
        assertEquals("gemini-argon-wtu-weekly", UsageText.windowForModel("gemini-4-argon", windows)?.id)
        assertEquals("3p-weekly", UsageText.windowForModel("claude-opus-5-5", windows)?.id)
        assertEquals("3p-weekly", UsageText.windowForModel("gpt-oss-120b", windows)?.id)
        assertEquals("gemini-argon-wtu-weekly", UsageText.windowForModel(null, windows)?.id)
    }
}
