package com.tachibanayu24.ccremote.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.tachibanayu24.ccremote.ui.code.CodeBlock
import com.tachibanayu24.ccremote.ui.code.resolveLanguage
import com.tachibanayu24.ccremote.ui.theme.CodeFontFamily

// Tailwind cyan-300; reads well on the dark Material 3 surface.
private val InlineCodeColor = Color(0xFF67E8F9)
// Tailwind sky-400 — distinguishes link-styled text from cyan inline code.
private val LinkColor = Color(0xFF38BDF8)
private val FENCE_RE = Regex("```([a-zA-Z0-9_+-]*)\\s*\\n([\\s\\S]*?)```")
// Three inline forms; named groups disambiguate which matched.
private val INLINE_RE = Regex(
    "\\*\\*(?<bold>[^*]+)\\*\\*|`(?<code>[^`\\n]+)`|\\[(?<linkText>[^\\]]+)\\]\\((?<linkUrl>[^)]+)\\)"
)
// Pipe-table line: starts and ends with a pipe (after trim) and contains at
// least one cell separator. Conservative — won't false-positive on prose
// like "see |here| for details".
private val TABLE_LINE_RE = Regex("^\\s*\\|.*\\|\\s*$")
// Separator-row cell: 3+ dashes, optionally surrounded by `:` for alignment
// markers. We don't honor alignment yet — every cell is left-aligned.
private val TABLE_SEPARATOR_CELL_RE = Regex("^\\s*:?-{3,}:?\\s*$")

/**
 * Lightweight chat-text renderer. Handles `**bold**`, `` `inline code` ``,
 * markdown links `[text](url)` (tappable via [LinkAnnotation]), pipe-style
 * tables, and ```` ```fenced code blocks``` ````. Headings and lists pass
 * through as raw monospace text — that matches what CC's own terminal does.
 */
@Composable
fun ChatMarkdown(
    text: String,
    color: Color,
    style: TextStyle = MaterialTheme.typography.bodyMedium,
) {
    // Splitting only depends on the source text, not on Compose state.
    val blocks = remember(text) { splitChatBlocks(text) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        blocks.forEach { block ->
            when (block) {
                is ChatBlock.Plain -> Text(
                    text = remember(block.text) { parseInline(block.text) },
                    style = style.copy(fontFamily = CodeFontFamily),
                    color = color,
                )
                is ChatBlock.Code -> CodeBlock(
                    code = block.code,
                    language = resolveLanguage(block.lang),
                )
                is ChatBlock.Table -> TableBlock(block, color, style)
            }
        }
    }
}

private sealed class ChatBlock {
    data class Plain(val text: String) : ChatBlock()
    data class Code(val lang: String, val code: String) : ChatBlock()
    data class Table(val header: List<String>, val rows: List<List<String>>) : ChatBlock()
}

/**
 * Two-pass split: fenced code first (so `|` characters inside code don't
 * trick the table detector), then tables, then anything left as plain.
 */
private fun splitChatBlocks(text: String): List<ChatBlock> {
    val out = mutableListOf<ChatBlock>()
    for (block in splitByFencedCode(text)) {
        when (block) {
            is ChatBlock.Code -> out += block
            is ChatBlock.Plain -> out += extractTables(block.text)
            is ChatBlock.Table -> out += block  // unreachable in this layer
        }
    }
    return out
}

private fun splitByFencedCode(text: String): List<ChatBlock> {
    val blocks = mutableListOf<ChatBlock>()
    var lastEnd = 0
    for (m in FENCE_RE.findAll(text)) {
        if (m.range.first > lastEnd) {
            val plain = text.substring(lastEnd, m.range.first).trim('\n')
            if (plain.isNotEmpty()) blocks += ChatBlock.Plain(plain)
        }
        blocks += ChatBlock.Code(lang = m.groupValues[1], code = m.groupValues[2].trimEnd('\n'))
        lastEnd = m.range.last + 1
    }
    if (lastEnd < text.length) {
        val tail = text.substring(lastEnd).trim('\n')
        if (tail.isNotEmpty()) blocks += ChatBlock.Plain(tail)
    }
    if (blocks.isEmpty()) blocks += ChatBlock.Plain(text)
    return blocks
}

/**
 * Find pipe-tables inside a plain-text block. A table is `header | sep |
 * body...`: a table-shaped first line, a separator-row second line, and
 * zero or more table-shaped body lines. Anything that isn't a table is
 * collected back into Plain blocks so inline parsing still applies.
 */
private fun extractTables(plain: String): List<ChatBlock> {
    val lines = plain.split('\n')
    val out = mutableListOf<ChatBlock>()
    val buffer = mutableListOf<String>()
    fun flushBuffer() {
        if (buffer.isEmpty()) return
        val joined = buffer.joinToString("\n").trim('\n')
        if (joined.isNotEmpty()) out += ChatBlock.Plain(joined)
        buffer.clear()
    }
    var i = 0
    while (i < lines.size) {
        val curr = lines[i]
        val next = lines.getOrNull(i + 1)
        if (next != null
            && TABLE_LINE_RE.matches(curr)
            && TABLE_LINE_RE.matches(next)
            && isTableSeparator(next)
        ) {
            flushBuffer()
            val header = parseTableRow(curr)
            i += 2
            val rows = mutableListOf<List<String>>()
            while (i < lines.size && TABLE_LINE_RE.matches(lines[i])) {
                rows += parseTableRow(lines[i])
                i++
            }
            out += ChatBlock.Table(header, rows)
        } else {
            buffer += curr
            i++
        }
    }
    flushBuffer()
    return out
}

private fun isTableSeparator(line: String): Boolean {
    val cells = parseTableRow(line)
    return cells.isNotEmpty() && cells.all { TABLE_SEPARATOR_CELL_RE.matches(it) }
}

private fun parseTableRow(line: String): List<String> =
    line.trim().trim('|').split('|').map { it.trim() }

/**
 * Each column is its own [Column] so cells auto-align to the widest entry
 * in that column without manual measurement. Vertical dividers between
 * columns and a per-column header divider give a recognizable table feel.
 * The whole row scrolls horizontally as a unit when content exceeds the
 * surface width.
 */
@Composable
private fun TableBlock(
    table: ChatBlock.Table,
    color: Color,
    style: TextStyle,
) {
    if (table.header.isEmpty()) return
    val scroll = rememberScrollState()
    val cellStyle = style.copy(fontFamily = CodeFontFamily)
    val headerStyle = cellStyle.copy(fontWeight = FontWeight.Bold)
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(6.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f),
    ) {
        Row(
            modifier = Modifier
                .horizontalScroll(scroll)
                .padding(8.dp),
        ) {
            table.header.forEachIndexed { colIdx, _ ->
                TableColumn(
                    headerText = table.header[colIdx],
                    bodyTexts = table.rows.map { it.getOrNull(colIdx).orEmpty() },
                    color = color,
                    headerStyle = headerStyle,
                    cellStyle = cellStyle,
                )
                if (colIdx < table.header.size - 1) {
                    VerticalDivider(
                        modifier = Modifier.padding(horizontal = 2.dp),
                        color = MaterialTheme.colorScheme.outlineVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun TableColumn(
    headerText: String,
    bodyTexts: List<String>,
    color: Color,
    headerStyle: TextStyle,
    cellStyle: TextStyle,
) {
    Column {
        Text(
            text = remember(headerText) { parseInline(headerText) },
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 4.dp),
            style = headerStyle,
            color = color,
            softWrap = false,
        )
        HorizontalDivider(
            modifier = Modifier.padding(vertical = 2.dp),
            color = MaterialTheme.colorScheme.outlineVariant,
        )
        bodyTexts.forEach { cell ->
            Text(
                text = remember(cell) { parseInline(cell) },
                modifier = Modifier.padding(horizontal = 6.dp, vertical = 4.dp),
                style = cellStyle,
                color = color,
                softWrap = false,
            )
        }
    }
}

private fun parseInline(text: String): AnnotatedString = buildAnnotatedString {
    var cursor = 0
    val linkStyle = TextLinkStyles(
        style = SpanStyle(color = LinkColor, textDecoration = TextDecoration.Underline),
    )
    for (m in INLINE_RE.findAll(text)) {
        if (m.range.first > cursor) append(text.substring(cursor, m.range.first))
        val bold = m.groups["bold"]?.value
        val code = m.groups["code"]?.value
        val linkText = m.groups["linkText"]?.value
        val linkUrl = m.groups["linkUrl"]?.value
        when {
            bold != null -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(bold) }
            code != null -> withStyle(SpanStyle(color = InlineCodeColor)) { append(code) }
            linkText != null && linkUrl != null -> {
                // LinkAnnotation makes the span tappable — Compose 1.7+ feature.
                // The system handles URI launching; no Activity context needed.
                val link = LinkAnnotation.Url(url = linkUrl, styles = linkStyle)
                withLink(link) { append(linkText) }
            }
        }
        cursor = m.range.last + 1
    }
    if (cursor < text.length) append(text.substring(cursor))
}

private inline fun AnnotatedString.Builder.withStyle(
    style: SpanStyle,
    block: AnnotatedString.Builder.() -> Unit,
) {
    pushStyle(style)
    try { block() } finally { pop() }
}

private inline fun AnnotatedString.Builder.withLink(
    link: LinkAnnotation,
    block: AnnotatedString.Builder.() -> Unit,
) {
    pushLink(link)
    try { block() } finally { pop() }
}
