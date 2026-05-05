package com.tachibanayu24.ccremote.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp

// Tailwind cyan-300; reads well on the dark Material 3 surface.
private val InlineCodeColor = Color(0xFF67E8F9)
private val CodeBlockTextColor = Color(0xFFE2E8F0)
// Tailwind sky-400 — distinguishes link-styled text from cyan inline code.
private val LinkColor = Color(0xFF38BDF8)
private val FENCE_RE = Regex("```([a-zA-Z0-9_+-]*)\\s*\\n([\\s\\S]*?)```")
// Three inline forms; named groups disambiguate which matched.
private val INLINE_RE = Regex(
    "\\*\\*(?<bold>[^*]+)\\*\\*|`(?<code>[^`\\n]+)`|\\[(?<linkText>[^\\]]+)\\]\\((?<linkUrl>[^)]+)\\)"
)

/**
 * Lightweight chat-text renderer. Handles `**bold**`, `` `inline code` ``,
 * markdown links `[text](url)` (tappable via [LinkAnnotation]), and
 * ```` ```fenced code blocks``` ````. Everything else is rendered as
 * monospace plain text. We deliberately avoid pulling in a markdown library
 * — the cost-benefit doesn't justify it for these forms.
 */
@Composable
fun ChatMarkdown(
    text: String,
    color: Color,
    style: TextStyle = MaterialTheme.typography.bodyMedium,
) {
    // Splitting only depends on the source text, not on Compose state.
    val blocks = remember(text) { splitByFencedCode(text) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        blocks.forEach { block ->
            when (block) {
                is ChatBlock.Plain -> Text(
                    text = remember(block.text) { parseInline(block.text) },
                    style = style.copy(fontFamily = FontFamily.Monospace),
                    color = color,
                )
                is ChatBlock.Code -> Surface(
                    shape = RoundedCornerShape(6.dp),
                    color = MaterialTheme.colorScheme.surfaceVariant,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        text = block.code,
                        style = style.copy(fontFamily = FontFamily.Monospace),
                        color = CodeBlockTextColor,
                        modifier = Modifier.padding(12.dp),
                    )
                }
            }
        }
    }
}

private sealed class ChatBlock {
    data class Plain(val text: String) : ChatBlock()
    data class Code(val code: String) : ChatBlock()
}

private fun splitByFencedCode(text: String): List<ChatBlock> {
    val blocks = mutableListOf<ChatBlock>()
    var lastEnd = 0
    for (m in FENCE_RE.findAll(text)) {
        if (m.range.first > lastEnd) {
            val plain = text.substring(lastEnd, m.range.first).trim('\n')
            if (plain.isNotEmpty()) blocks += ChatBlock.Plain(plain)
        }
        blocks += ChatBlock.Code(m.groupValues[2].trimEnd('\n'))
        lastEnd = m.range.last + 1
    }
    if (lastEnd < text.length) {
        val tail = text.substring(lastEnd).trim('\n')
        if (tail.isNotEmpty()) blocks += ChatBlock.Plain(tail)
    }
    if (blocks.isEmpty()) blocks += ChatBlock.Plain(text)
    return blocks
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
