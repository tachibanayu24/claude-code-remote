package com.tachibanayu24.ccremote.ui.diff

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.tachibanayu24.ccremote.ui.code.highlight
import com.tachibanayu24.ccremote.ui.theme.CodeFontFamily
import dev.snipme.highlights.model.SyntaxLanguage

private val AddBg = Color(0x3322C55E)   // green tint
private val DelBg = Color(0x33EF4444)   // red tint
private val ContextBg = Color.Transparent

/**
 * GitHub-style unified diff render. Each row is `[line# | +/-/" " | code]`.
 * The whole diff is a single horizontal-scroll region — line numbers, marker
 * and code all move together. `Modifier.width(IntrinsicSize.Max)` on the
 * Column makes every row size to the widest line so add/del row tints fill
 * uniformly to the right edge.
 *
 * Single line-number column (not GitHub's two): for context rows we show
 * the new-side number, for adds the new-side, for dels the old-side. On a
 * narrow phone the second column eats more space than it earns.
 */
@Composable
fun DiffView(
    lines: List<DiffLine>,
    language: SyntaxLanguage?,
    modifier: Modifier = Modifier,
    scrollState: ScrollState = rememberScrollState(),
) {
    if (lines.isEmpty()) return
    val gutterWidth: Dp = remember(lines) {
        // ~9sp per digit at bodySmall (12sp) Fira Code; pad +6 so the
        // rightmost digit doesn't kiss the marker column.
        val maxDigits = lines
            .maxOf { displayLineNumOf(it) }
            .toString()
            .length
            .coerceAtLeast(2)
        (maxDigits * 9 + 6).dp
    }
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(6.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f),
    ) {
        // SelectionContainer at the diff-region level: long-press anywhere
        // inside starts a selection that can extend across rows. Line
        // numbers and the +/- marker are part of the selection too —
        // simpler and matches what GitHub does on mobile.
        SelectionContainer {
            Column(
                modifier = Modifier
                    .horizontalScroll(scrollState)
                    .width(IntrinsicSize.Max),
            ) {
                for (line in lines) {
                    DiffRow(line, language, gutterWidth)
                }
            }
        }
    }
}

@Composable
private fun DiffRow(
    line: DiffLine,
    language: SyntaxLanguage?,
    gutterWidth: Dp,
) {
    val (rowBg, marker) = when (line) {
        is DiffLine.Add -> AddBg to "+"
        is DiffLine.Del -> DelBg to "-"
        is DiffLine.Context -> ContextBg to " "
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(rowBg)
            // heightIn(min) — a fixed height clipped descenders / large font
            // scales (Settings > Display > Font size: largest). Lets the row
            // grow when bodySmall renders taller than 20.dp.
            .heightIn(min = 20.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        LineNumber(displayLineNumOf(line), gutterWidth)
        Text(
            text = marker,
            modifier = Modifier.padding(horizontal = 4.dp),
            style = MaterialTheme.typography.bodySmall,
            fontFamily = CodeFontFamily,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        // No weight / no per-row scroll: the parent Column handles horizontal
        // scrolling for the whole region. softWrap=false lets the Text take
        // its full intrinsic width, which feeds into the Column's
        // IntrinsicSize.Max measurement.
        Text(
            text = remember(line.text, language) { highlight(line.text, language) },
            modifier = Modifier.padding(end = 6.dp),
            fontFamily = CodeFontFamily,
            style = MaterialTheme.typography.bodySmall,
            softWrap = false,
            color = MaterialTheme.colorScheme.onSurface,
        )
    }
}

/**
 * Single-column line-number rule: show whichever side carries a number for
 * this row kind. Context rows have both — pick the new-side so the column
 * tracks the "after" state of the file.
 */
private fun displayLineNumOf(line: DiffLine): Int = when (line) {
    is DiffLine.Context -> line.newLine
    is DiffLine.Add -> line.newLine
    is DiffLine.Del -> line.oldLine
}

@Composable
private fun LineNumber(num: Int, width: Dp) {
    // Modifier order matters: padding *then* width so the digit area is the
    // full `width` and the padding sits outside it. The opposite order eats
    // into the digit area and clips multi-digit numbers.
    Text(
        text = num.toString(),
        modifier = Modifier
            .padding(start = 6.dp, end = 4.dp)
            .width(width),
        style = MaterialTheme.typography.bodySmall,
        fontFamily = CodeFontFamily,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = TextAlign.End,
        softWrap = false,
    )
}
