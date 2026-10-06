package app.ccmobile.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private sealed interface Block
private data class Prose(val text: String) : Block
private data class Fence(val code: String) : Block
private data class Heading(val text: String) : Block

/** Just enough Markdown for Claude's replies: fenced code, headings, `code`, **bold**. */
@Composable
fun RichText(text: String) {
    val blocks = remember(text) { parseBlocks(text) }
    SelectionContainer {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            for (block in blocks) when (block) {
                is Fence -> CodeBlock(block.code)
                is Heading -> Text(block.text, color = C.Text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                is Prose -> Text(inline(block.text), color = Color_Body, fontSize = 15.sp, lineHeight = 22.sp)
            }
        }
    }
}

// A getter, not a value: it must follow the theme when it changes.
private val Color_Body get() = C.Text.copy(alpha = 0.92f)

private fun parseBlocks(text: String): List<Block> {
    val blocks = mutableListOf<Block>()
    val prose = StringBuilder()
    fun flushProse() {
        val p = prose.toString().trim('\n')
        if (p.isNotBlank()) blocks.add(Prose(p))
        prose.clear()
    }
    val lines = text.lines()
    var i = 0
    while (i < lines.size) {
        val line = lines[i]
        when {
            line.trimStart().startsWith("```") -> {
                flushProse()
                val code = StringBuilder()
                i++
                while (i < lines.size && !lines[i].trimStart().startsWith("```")) code.appendLine(lines[i++])
                blocks.add(Fence(code.toString().trimEnd()))
            }
            line.startsWith("#") -> {
                flushProse()
                blocks.add(Heading(line.trimStart('#').trim()))
            }
            else -> prose.appendLine(line.replace(Regex("^(\\s*)[-*] "), "$1• "))
        }
        i++
    }
    flushProse()
    return blocks
}

private fun inline(text: String): AnnotatedString = buildAnnotatedString {
    val pattern = Regex("`([^`]+)`|\\*\\*([^*]+)\\*\\*")
    var last = 0
    for (m in pattern.findAll(text)) {
        append(text.substring(last, m.range.first))
        val code = m.groupValues[1]
        if (code.isNotEmpty()) {
            pushStyle(SpanStyle(fontFamily = Mono, background = C.Surface2, color = C.ClayPill, fontSize = 13.5.sp))
            append(code)
        } else {
            pushStyle(SpanStyle(fontWeight = FontWeight.SemiBold))
            append(m.groupValues[2])
        }
        pop()
        last = m.range.last + 1
    }
    append(text.substring(last))
}
