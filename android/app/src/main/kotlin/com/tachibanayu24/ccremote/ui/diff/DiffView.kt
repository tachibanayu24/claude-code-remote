package com.tachibanayu24.ccremote.ui.diff

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import com.tachibanayu24.ccremote.ui.theme.CodeFontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.tachibanayu24.ccremote.ui.code.highlight
import dev.snipme.highlights.model.SyntaxLanguage

private val AddBg = Color(0x3322C55E)   // green tint
private val DelBg = Color(0x33EF4444)   // red tint
private val ContextBg = Color.Transparent

/**
 * GitHub-style unified diff render. Each row is `[line# | +/-/" " | code]`.
 * The code column wraps `horizontalScroll`; sharing the same `ScrollState`
 * across rows makes dragging one line scroll the whole diff in lock-step.
 * The line-number gutter stays fixed in the visible viewport.
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
        // Just enough room for the widest line number, no extra padding —
        // the row's body padding already separates it from the marker. ~7sp
        // per digit in our small monospace style.
        val maxDigits = lines
            .maxOf { displayLineNumOf(it) }
            .toString()
            .length
            .coerceAtLeast(2)
        (maxDigits * 7).dp
    }
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(6.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f),
    ) {
        Column {
            for (line in lines) {
                DiffRow(line, language, gutterWidth, scrollState)
            }
        }
    }
}

@Composable
private fun DiffRow(
    line: DiffLine,
    language: SyntaxLanguage?,
    gutterWidth: Dp,
    scroll: ScrollState,
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
            .height(20.dp),
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
        // weight(1f) gives the code column the *remaining* row width — without
        // it, horizontalScroll inside a Row child sees infinite max-width and
        // the inner Text takes its full intrinsic width, exceeding the row
        // and leaving nothing for the scroll modifier to actually scroll.
        Text(
            text = remember(line.text, language) { highlight(line.text, language) },
            modifier = Modifier
                .weight(1f)
                .horizontalScroll(scroll)
                .padding(horizontal = 6.dp),
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
    Text(
        text = num.toString(),
        modifier = Modifier
            .width(width)
            .padding(start = 6.dp, end = 4.dp),
        style = MaterialTheme.typography.bodySmall,
        fontFamily = CodeFontFamily,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = TextAlign.End,
        softWrap = false,
    )
}
