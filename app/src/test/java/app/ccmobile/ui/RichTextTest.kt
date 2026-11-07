package app.ccmobile.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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

    @Test
    fun inlineHandlesDoubleBackticksAndItalicsWithoutCorruptingFollowingLines() {
        val markdown =
            "• **Root cause**: Inline code spans (`SpanStyle(background = C.Surface2)`) used an opaque background (`alpha = 1.0f`). " +
                "Because Android's `Layout.drawBackground` paints `BackgroundColorSpan` *after* Compose draws the text selection highlight path, " +
                "making selected characters inside `` `code` `` spans completely invisible.\n" +
                "• **Fix**: Switched inline code spans to a translucent tint (`Color_InlineCodeBg`) and provided explicit `LocalTextSelectionColors` " +
                "in [`CcTheme`](file:///data/data/com.termux/files/home/claude-code-mobile/app/src/main/java/app/ccmobile/ui/Theme.kt#L145-L153)."
        val rendered = inline(markdown)
        assertFalse(rendered.text.contains("file:///"))
        assertFalse(rendered.text.contains("**Fix**"))
        assertFalse(rendered.text.contains("*after*"))
        assertTrue(rendered.text.contains("inside `code` spans"))
        assertTrue(rendered.text.contains("in CcTheme."))
    }
}
