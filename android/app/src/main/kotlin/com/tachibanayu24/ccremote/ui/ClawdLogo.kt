package com.tachibanayu24.ccremote.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

// 8x8 pixel grid matching the launcher icon foreground.
private val PATTERN = arrayOf(
    "01111110",
    "11111111",
    "11011011",
    "11111111",
    "11111111",
    "01111110",
    "10101010",
    "10001000",
)

@Composable
fun ClawdLogo(
    modifier: Modifier = Modifier,
    pixelSize: Dp = 10.dp,
    color: Color = MaterialTheme.colorScheme.primary,
) {
    val rows = PATTERN.size
    val cols = PATTERN[0].length
    Canvas(
        modifier = modifier.size(width = pixelSize * cols, height = pixelSize * rows),
    ) {
        val px = pixelSize.toPx()
        for (row in PATTERN.indices) {
            val line = PATTERN[row]
            for (col in line.indices) {
                if (line[col] == '1') {
                    drawRect(
                        color = color,
                        topLeft = Offset(col * px, row * px),
                        size = Size(px, px),
                    )
                }
            }
        }
    }
}
