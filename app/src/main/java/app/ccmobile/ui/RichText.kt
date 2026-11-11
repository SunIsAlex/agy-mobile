package app.ccmobile.ui

import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.ccmobile.R
import com.hrm.latex.renderer.Latex
import com.hrm.latex.renderer.measure.LatexMeasurerState
import com.hrm.latex.renderer.measure.rememberLatexMeasurer
import com.hrm.latex.renderer.model.LatexConfig
import com.hrm.latex.renderer.model.LatexTheme
import kotlinx.coroutines.delay

internal sealed interface Block
internal data class Prose(val text: String) : Block
internal data class Fence(val code: String) : Block
internal data class Heading(val text: String) : Block
internal data class LatexBlock(val formula: String) : Block

/** Just enough Markdown for Claude's replies: fenced code, math formulas, headings, `code`, **bold**, *italic*, and [links](url). */
@Composable
fun RichText(text: String, modifier: Modifier = Modifier, color: Color = Color_Body) {
    val blocks = remember(text) { parseBlocks(text) }
    val isDark = C.palette.dark
    val latexConfig = remember(isDark, color) {
        LatexConfig(
            fontSize = 15.sp,
            theme = if (isDark) LatexTheme.dark(color, Color.Transparent) else LatexTheme.light(color, Color.Transparent),
        )
    }
    val headingLatexConfig = remember(isDark) {
        LatexConfig(
            fontSize = 16.sp,
            theme = if (isDark) LatexTheme.dark(C.Text, Color.Transparent) else LatexTheme.light(C.Text, Color.Transparent),
        )
    }
    val measurer = rememberLatexMeasurer(latexConfig)
    val headingMeasurer = rememberLatexMeasurer(headingLatexConfig)

    SelectionContainer(modifier) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            for (block in blocks) when (block) {
                is Fence -> CodeBlock(block.code)
                is LatexBlock -> LatexMathBlock(block.formula)
                is Heading -> {
                    val (annotated, inlineMap) = remember(block.text, headingLatexConfig) {
                        val map = mutableMapOf<String, InlineTextContent>()
                        val str = inlineText(block.text, headingMeasurer, headingLatexConfig, map)
                        str to map
                    }
                    Text(
                        text = annotated,
                        inlineContent = inlineMap,
                        color = C.Text,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
                is Prose -> {
                    val (annotated, inlineMap) = remember(block.text, latexConfig) {
                        val map = mutableMapOf<String, InlineTextContent>()
                        val str = inlineText(block.text, measurer, latexConfig, map)
                        str to map
                    }
                    Text(
                        text = annotated,
                        inlineContent = inlineMap,
                        color = color,
                        fontSize = 15.sp,
                        lineHeight = 22.sp,
                    )
                }
            }
        }
    }
}

@Composable
fun LatexMathBlock(formula: String, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1500)
            copied = false
        }
    }
    val config = remember(C.palette.dark) {
        LatexConfig(
            fontSize = 16.5.sp,
            theme = if (C.palette.dark) LatexTheme.dark(C.Text, Color.Transparent) else LatexTheme.light(C.Text, Color.Transparent),
        )
    }

    Box(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(C.Code)
            .border(1.dp, C.Border, RoundedCornerShape(10.dp))
            .padding(12.dp),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(end = 36.dp),
            contentAlignment = Alignment.Center,
        ) {
            Latex(
                latex = formula,
                config = config,
                isDarkTheme = C.palette.dark,
            )
        }
        IconButton(
            onClick = {
                val clipboard = context.getSystemService(ClipboardManager::class.java)
                clipboard?.setPrimaryClip(ClipData.newPlainText("latex", formula))
                copied = true
            },
            modifier = Modifier
                .size(32.dp)
                .align(Alignment.TopEnd),
        ) {
            CcIcon(
                if (copied) R.drawable.ic_check else R.drawable.ic_copy,
                tint = if (copied) C.Green else C.Faint,
                size = 16.dp,
                contentDescription = if (copied) "Copied" else "Copy LaTeX",
            )
        }
    }
}

// A getter, not a value: it must follow the theme when it changes.
private val Color_Body get() = C.Text.copy(alpha = 0.92f)
// Translucent tint so Android's BackgroundColorSpan doesn't paint over Compose's selection highlight.
private val Color_InlineCodeBg get() = C.Text.copy(alpha = if (C.palette.dark) 0.11f else 0.08f)

internal fun parseBlocks(text: String): List<Block> {
    val blocks = mutableListOf<Block>()
    val prose = StringBuilder()

    fun flushProse() {
        val p = prose.toString().trim('\n')
        prose.clear()
        if (p.isBlank()) return

        val codeRanges = mutableListOf<IntRange>()
        val codeRegex = Regex("""(?<!`)``+([^\n]+?)``+(?!`)|(?<!`)`([^`\n]+)`(?!`)""")
        for (m in codeRegex.findAll(p)) {
            codeRanges.add(m.range)
        }

        val displayMathRegex = Regex("""(?s)(?<!\\)\$\$(.+?)(?<!\\)\$\$|(?<!\\)\\\[(.+?)(?<!\\)\\\]""")
        var last = 0
        for (m in displayMathRegex.findAll(p)) {
            if (codeRanges.any { it.first <= m.range.first && m.range.last <= it.last }) {
                continue
            }
            val before = p.substring(last, m.range.first).trim()
            if (before.isNotBlank()) blocks.add(Prose(before))
            val formula = (m.groupValues[1].ifEmpty { m.groupValues[2] }).trim()
            if (formula.isNotEmpty()) blocks.add(LatexBlock(formula))
            last = m.range.last + 1
        }
        val after = p.substring(last).trim()
        if (after.isNotBlank()) blocks.add(Prose(after))
    }

    val lines = text.lines()
    var i = 0
    while (i < lines.size) {
        val line = lines[i]
        val trimmed = line.trim()
        when {
            line.trimStart().startsWith("```") -> {
                flushProse()
                val lang = line.trimStart().removePrefix("```").trim().lowercase()
                val isLatex = lang == "latex" || lang == "math" || lang == "tex"
                val code = StringBuilder()
                i++
                while (i < lines.size && !lines[i].trimStart().startsWith("```")) code.appendLine(lines[i++])
                val content = code.toString().trimEnd()
                if (isLatex) {
                    blocks.add(LatexBlock(content.trim()))
                } else {
                    blocks.add(Fence(content))
                }
            }
            trimmed.startsWith("$$") -> {
                flushProse()
                if (trimmed.length > 4 && trimmed.endsWith("$$")) {
                    val formula = trimmed.removePrefix("$$").removeSuffix("$$").trim()
                    if (formula.isNotEmpty()) blocks.add(LatexBlock(formula))
                } else {
                    val math = StringBuilder()
                    val rest = trimmed.removePrefix("$$").trim()
                    if (rest.isNotEmpty()) math.appendLine(rest)
                    i++
                    while (i < lines.size && !lines[i].trim().contains("$$")) {
                        math.appendLine(lines[i++])
                    }
                    if (i < lines.size) {
                        val beforeEnd = lines[i].substringBefore("$$").trim()
                        if (beforeEnd.isNotEmpty()) math.appendLine(beforeEnd)
                    }
                    val formula = math.toString().trim()
                    if (formula.isNotEmpty()) blocks.add(LatexBlock(formula))
                }
            }
            trimmed.startsWith("\\[") -> {
                flushProse()
                if (trimmed.length > 4 && trimmed.endsWith("\\]")) {
                    val formula = trimmed.removePrefix("\\[").removeSuffix("\\]").trim()
                    if (formula.isNotEmpty()) blocks.add(LatexBlock(formula))
                } else {
                    val math = StringBuilder()
                    val rest = trimmed.removePrefix("\\[").trim()
                    if (rest.isNotEmpty()) math.appendLine(rest)
                    i++
                    while (i < lines.size && !lines[i].trim().contains("\\]")) {
                        math.appendLine(lines[i++])
                    }
                    if (i < lines.size) {
                        val beforeEnd = lines[i].substringBefore("\\]").trim()
                        if (beforeEnd.isNotEmpty()) math.appendLine(beforeEnd)
                    }
                    val formula = math.toString().trim()
                    if (formula.isNotEmpty()) blocks.add(LatexBlock(formula))
                }
            }
            line.startsWith("#") -> {
                flushProse()
                blocks.add(Heading(line.trimStart('#').trim()))
            }
            line.isBlank() -> flushProse()
            else -> prose.appendLine(line.replace(Regex("^(\\s*)[-*] "), "$1• "))
        }
        i++
    }
    flushProse()
    return blocks
}

internal fun inlineText(
    text: String,
    measurer: LatexMeasurerState? = null,
    config: LatexConfig? = null,
    inlineMap: MutableMap<String, InlineTextContent>? = null,
): AnnotatedString = buildAnnotatedString {
    val codeStyle = SpanStyle(fontFamily = Mono, background = Color_InlineCodeBg, color = C.ClayPill, fontSize = 13.5.sp)
    val mathStyle = SpanStyle(fontStyle = FontStyle.Italic)
    val pattern = Regex(
        "\\[([^\\[\\]\\n]+)]\\(([^)\\s]+)\\)" + // 1: linkLabel, 2: linkUrl
            "|(?<!`)``+([^\\n]+?)``+(?!`)" +        // 3: multiCode
            "|(?<!`)`([^`\\n]+)`(?!`)" +            // 4: singleCode
            "|\\*\\*([^\\n]+?)\\*\\*" +              // 5: bold
            "|(?<!\\\\)\\\\\\((.+?)\\\\\\)" +         // 6: latexParens \( ... \)
            "|(?<![\\\$])\\$(?!\\s)([^$\\n]+?)(?<![\\s\\\\])\\$(?!\\d)" + // 7: latexDollar $ ... $
            "|(?<!\\*)\\*([^\\s*](?:[^\\n*]*?[^\\s*])?)\\*(?!\\*)", // 8: italic
    )
    var last = 0
    var inlineIndex = 0
    for (m in pattern.findAll(text)) {
        append(text.substring(last, m.range.first))
        val linkLabel = m.groupValues[1]
        val linkUrl = m.groupValues[2]
        val multiCode = m.groupValues[3]
        val singleCode = m.groupValues[4]
        val bold = m.groupValues[5]
        val latexParens = m.groupValues[6]
        val latexDollar = m.groupValues[7]
        val italic = m.groupValues[8]
        when {
            linkLabel.isNotEmpty() -> {
                val trimmedLabel = linkLabel.trim()
                val isBackticked = trimmedLabel.startsWith("`") && trimmedLabel.endsWith("`") && trimmedLabel.length >= 2
                val cleanLabel = if (isBackticked) trimmedLabel.trim('`').trim() else linkLabel
                when {
                    linkUrl.startsWith("http://") || linkUrl.startsWith("https://") || linkUrl.startsWith("mailto:") -> {
                        pushLink(LinkAnnotation.Url(linkUrl))
                        pushStyle(
                            SpanStyle(
                                color = if (isBackticked) C.ClayPill else C.ClayText,
                                background = if (isBackticked) Color_InlineCodeBg else Color.Unspecified,
                                fontFamily = if (isBackticked) Mono else null,
                                fontSize = if (isBackticked) 13.5.sp else TextUnit.Unspecified,
                                textDecoration = TextDecoration.Underline,
                            ),
                        )
                        append(cleanLabel)
                        pop()
                        pop()
                    }
                    isBackticked || linkUrl.startsWith("file:") || linkUrl.startsWith("/") || linkUrl.startsWith("#") -> {
                        pushStyle(codeStyle)
                        append(cleanLabel)
                        pop()
                    }
                    else -> {
                        pushStyle(SpanStyle(color = C.ClayText, fontWeight = FontWeight.Medium))
                        append(inlineText(cleanLabel, measurer, config, inlineMap))
                        pop()
                    }
                }
            }
            multiCode.isNotEmpty() -> {
                val cleaned = if (multiCode.length >= 2 && multiCode.startsWith(" ") && multiCode.endsWith(" ")) {
                    multiCode.substring(1, multiCode.length - 1)
                } else {
                    multiCode
                }
                pushStyle(codeStyle)
                append(cleaned)
                pop()
            }
            singleCode.isNotEmpty() -> {
                pushStyle(codeStyle)
                append(singleCode)
                pop()
            }
            bold.isNotEmpty() -> {
                pushStyle(SpanStyle(fontWeight = FontWeight.SemiBold))
                append(inlineText(bold, measurer, config, inlineMap))
                pop()
            }
            latexParens.isNotEmpty() || latexDollar.isNotEmpty() -> {
                val formula = latexParens.ifEmpty { latexDollar }.trim()
                if (formula.isNotEmpty()) {
                    var rendered = false
                    if (measurer != null && config != null && inlineMap != null) {
                        try {
                            val inline = measurer.inlineContent(formula, config)
                            if (inline != null) {
                                val id = "math_${inlineIndex++}_${formula.hashCode()}"
                                inlineMap[id] = inline
                                appendInlineContent(id, formula)
                                rendered = true
                            }
                        } catch (_: Throwable) {
                            // On measuring/parsing exception, fall back to styled text
                        }
                    }
                    if (!rendered) {
                        pushStyle(mathStyle)
                        append(formula)
                        pop()
                    }
                }
            }
            italic.isNotEmpty() -> {
                pushStyle(SpanStyle(fontStyle = FontStyle.Italic))
                append(inlineText(italic, measurer, config, inlineMap))
                pop()
            }
        }
        last = m.range.last + 1
    }
    append(text.substring(last))
}

internal fun inline(text: String): AnnotatedString = inlineText(text, null, null, null)
