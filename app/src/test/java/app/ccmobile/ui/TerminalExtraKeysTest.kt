package app.ccmobile.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class TerminalExtraKeysTest {
    @Test
    fun plainAltCtrlAndCtrlAltEscapeSequences() {
        assertEquals("\u001b[A", extraKeySequence("\u001b[A", ctrl = false, alt = false))
        assertEquals("\u001b[1;5D", extraKeySequence("\u001b[D", ctrl = true, alt = false))
        assertEquals("\u001b[1;3C", extraKeySequence("\u001b[C", ctrl = false, alt = true))
        assertEquals("\u001b[1;7B", extraKeySequence("\u001b[B", ctrl = true, alt = true))

        assertEquals("\u001f", extraKeySequence("/", ctrl = true, alt = false))
        assertEquals("\u001f", extraKeySequence("-", ctrl = true, alt = false))
        assertEquals("\u001b\u001f", extraKeySequence("/", ctrl = true, alt = true))
        assertEquals("\u001b/", extraKeySequence("/", ctrl = false, alt = true))
    }
}
