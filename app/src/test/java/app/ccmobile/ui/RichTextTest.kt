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

    @Test
    fun parseBlocksExtractsLatexFencedCodeAndDollarDisplayMath() {
        val markdown = """
            Here is an equation:
            $$
            \int_0^\infty e^{-x^2} dx = \frac{\sqrt{\pi}}{2}
            $$
            And single line:
            $$\sum_{k=1}^n k = \frac{n(n+1)}{2}$$
            And bracket format:
            \[
            E = mc^2
            \]
            And fenced code:
            ```latex
            \begin{pmatrix} a & b \\ c & d \end{pmatrix}
            ```
            And regular code:
            ```kotlin
            val x = 42
            ```
        """.trimIndent()

        val blocks = parseBlocks(markdown)
        assertEquals(10, blocks.size)
        assertTrue(blocks[0] is Prose)
        assertTrue(blocks[1] is LatexBlock)
        assertEquals("\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}", (blocks[1] as LatexBlock).formula)
        assertTrue(blocks[2] is Prose)
        assertTrue(blocks[3] is LatexBlock)
        assertEquals("\\sum_{k=1}^n k = \\frac{n(n+1)}{2}", (blocks[3] as LatexBlock).formula)
        assertTrue(blocks[4] is Prose)
        assertTrue(blocks[5] is LatexBlock)
        assertEquals("E = mc^2", (blocks[5] as LatexBlock).formula)
        assertTrue(blocks[6] is Prose)
        assertTrue(blocks[7] is LatexBlock)
        assertEquals("\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}", (blocks[7] as LatexBlock).formula)
        assertTrue(blocks[8] is Prose)
        assertTrue(blocks[9] is Fence)
        assertEquals("val x = 42", (blocks[9] as Fence).code)
    }

    @Test
    fun parseBlocksExtractsDisplayMathFromProseWhileRespectingInlineCode() {
        val proseWithMath = "The energy is \$\$E = mc^2\$\$ where c is light speed."
        val blocks = parseBlocks(proseWithMath)
        assertEquals(3, blocks.size)
        assertEquals("The energy is", (blocks[0] as Prose).text)
        assertEquals("E = mc^2", (blocks[1] as LatexBlock).formula)
        assertEquals("where c is light speed.", (blocks[2] as Prose).text)

        val proseWithCode = "Use `\$\$` or `\\[` for display math."
        val blocksCode = parseBlocks(proseWithCode)
        assertEquals(1, blocksCode.size)
        assertTrue(blocksCode[0] is Prose)
    }

    @Test
    fun inlineParsesInlineLatexMathWithoutMistakingCurrency() {
        val markdown = "The formula is \$E = mc^2\$ and \\(a^2 + b^2 = c^2\\), but costs \$10 to \$20."
        val rendered = inline(markdown)
        assertEquals("The formula is E = mc^2 and a^2 + b^2 = c^2, but costs \$10 to \$20.", rendered.text)

        val codeWithMath = "In code: `\$x\$` should stay as code."
        val renderedCode = inline(codeWithMath)
        assertEquals("In code: \$x\$ should stay as code.", renderedCode.text)
    }
}

