package com.tachibanayu24.ccremote.ui.diff

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.tachibanayu24.ccremote.ui.code.highlight
import dev.snipme.highlights.model.SyntaxLanguage

private val AddBg = Color(0x3322C55E)   // green tint
private val AddGutterBg = Color(0x5022C55E)
private val DelBg = Color(0x33EF4444)   // red tint
private val DelGutterBg = Color(0x50EF4444)
private val ContextBg = Color.Transparent

/**
 * GitHub-style unified diff render. Each row has:
 *   [old line# | new line#] [+/-/" "] [code text]
 * The code-text column is wrapped in a `horizontalScroll` that shares its
 * state across all rows, so dragging one line scrolls the entire diff in
 * lock-step. The line-number gutter stays fixed in the visible viewport.
 *
 * No internal scroll state is created when the caller provides one (e.g. the
 * accordion preview wants the same scroll as the expanded view, so
 * collapsing/expanding doesn't reset the position).
 */
@Composable
fun DiffView(
    lines: List<DiffLine>,
    language: SyntaxLanguage?,
    modifier: Modifier = Modifier,
    scrollState: ScrollState = rememberScrollState(),
) {
    if (lines.isEmpty()) return
    val gutterWidthCh = remember(lines) {
        // Width of the largest line number, used for both old & new columns.
        lines.maxOf { maxOf(it.oldLine ?: 0, it.newLine ?: 0) }
            .toString()
            .length
            .coerceAtLeast(2)
    }
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(6.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f),
    ) {
        Column {
            for (line in lines) {
                DiffRow(line, language, gutterWidthCh, scrollState)
            }
        }
    }
}

@Composable
private fun DiffRow(
    line: DiffLine,
    language: SyntaxLanguage?,
    gutterWidthCh: Int,
    scroll: ScrollState,
) {
    val (rowBg, gutterBg, marker) = when (line) {
        is DiffLine.Add -> Triple(AddBg, AddGutterBg, "+")
        is DiffLine.Del -> Triple(DelBg, DelGutterBg, "-")
        is DiffLine.Context -> Triple(ContextBg, ContextBg, " ")
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(rowBg)
            .height(20.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Approx 8sp per ch * gutterWidthCh; render line numbers in a small
        // monospace block. Fixed-width chars keep multiline diffs aligned
        // without measurement gymnastics.
        val gutterDp = (gutterWidthCh * 8 + 8).dp
        LineNumber(line.oldLine, gutterDp, gutterBg)
        LineNumber(line.newLine, gutterDp, gutterBg)
        Text(
            text = marker,
            modifier = Modifier
                .background(gutterBg)
                .padding(horizontal = 4.dp),
            style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Box(
            modifier = Modifier
                .horizontalScroll(scroll)
                .widthIn(min = 0.dp),
        ) {
            Text(
                text = remember(line.text, language) { highlight(line.text, language) },
                modifier = Modifier.padding(horizontal = 6.dp),
                fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.bodySmall,
                softWrap = false,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

@Composable
private fun LineNumber(num: Int?, width: androidx.compose.ui.unit.Dp, bg: Color) {
    Text(
        text = num?.toString().orEmpty(),
        modifier = Modifier
            .width(width)
            .background(bg)
            .padding(horizontal = 4.dp),
        style = MaterialTheme.typography.bodySmall,
        fontFamily = FontFamily.Monospace,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = TextAlign.End,
        softWrap = false,
    )
}
