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
        assertEquals("unknown", UsageText.modelName("unknown"))
    }

    @Test fun durations() {
        assertEquals("in 1m", UsageText.until(5_000))
        assertEquals("in 2h 10m", UsageText.until((2 * 60 + 10) * 60_000L))
        assertEquals("in 3d 4h", UsageText.until(((3 * 24 + 4) * 60) * 60_000L))
    }
}
