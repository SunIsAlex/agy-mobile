package app.ccmobile.data

import app.ccmobile.data.SpeechText.Decision
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechTextTest {
    @Test fun markdownBecomesSentences() {
        val md = """
            ## Done

            I fixed **the bug** in `Voice.kt`:
            - tests pass
            - see [the PR](https://github.com/x/y/pull/1)

            ```kotlin
            val x = 1
            ```
            | a | b |
            |---|---|
            | 1 | 2 |
            More at https://example.com
        """.trimIndent()
        assertEquals(
            "Done. I fixed the bug in Voice.kt: tests pass. see the PR. (code) (table) More at a link.",
            SpeechText.speakable(md),
        )
    }

    @Test fun emphasisAndUnderscoresInNames() {
        assertEquals("Set my_var to *ptr, not this.", SpeechText.speakable("Set my_var to *ptr, _not_ this"))
    }

    @Test fun decisions() {
        assertEquals(Decision.Allow, SpeechText.decision("Yes, go ahead."))
        assertEquals(Decision.Allow, SpeechText.decision("ok"))
        assertEquals(Decision.Allow, SpeechText.decision("可以"))
        assertEquals(Decision.Deny, SpeechText.decision("No."))
        assertEquals(Decision.Deny, SpeechText.decision("Don't do that"))
        assertEquals(Decision.Deny, SpeechText.decision("不要"))
        assertEquals(Decision.Always, SpeechText.decision("Always allow it"))
        assertEquals(Decision.Deny, SpeechText.decision("never do it"))
        assertNull(SpeechText.decision("what does that command do?"))
        assertNull(SpeechText.decision(""))
    }

    @Test fun picks() {
        val options = listOf("Use SQLite", "Use Postgres", "Skip the database")
        assertEquals("Use Postgres", SpeechText.pick("use postgres please", options))
        assertEquals("Skip the database", SpeechText.pick("the third one", options))
        assertEquals("Use SQLite", SpeechText.pick("first", options))
        assertEquals("Use Postgres", SpeechText.pick("第二个", options))
        assertNull(SpeechText.pick("something else entirely, like a flat file on disk", options))
    }

    @Test fun exit() {
        assertTrue(SpeechText.isExit("OK, stop voice mode."))
        assertTrue(SpeechText.isExit("end voice"))
        assertFalse(SpeechText.isExit("stop the server"))
    }
}
