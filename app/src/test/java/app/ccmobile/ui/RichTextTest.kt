package app.ccmobile.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RichTextTest {
    @Test
    fun inlineStripsFileLinksAndKeepsTranslucentBackgroundForSelection() {
        val rendered = inline(
            "The project in [`/data/ccm/home/video/ccmobile`](file:///data/ccm/home/video/ccmobile) " +
                "updated ([`script.py`](file:///data/ccm/home/video/ccmobile/script.py), [subs.py](file:///data/ccm/home/video/ccmobile/subs.py)).",
        )
        assertEquals(
            "The project in /data/ccm/home/video/ccmobile updated (script.py, subs.py).",
            rendered.text,
        )
        val bgSpans = rendered.spanStyles.filter { it.item.background.alpha > 0f }
        assertEquals(3, bgSpans.size)
        for (span in bgSpans) {
            assertTrue("Inline code background must be translucent so selection highlight remains visible", span.item.background.alpha < 0.25f)
        }
    }
}
