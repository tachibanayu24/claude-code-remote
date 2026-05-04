package com.tachibanayu24.ccremote.ui

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.random.Random

// Clawd palette (upstream: clawd_body / clawd_background)
private val ClawdBody = Color(0xFFD77757)

private enum class ClawdPose { Default, LookLeft, LookRight, ArmsUp }

// 18-column x 5-row bit grids decoded from upstream Unicode block art.
// Each "pixel" is one quadrant of a Unicode cell. Visible region is 5 rows
// (the 6th quadrant-row in upstream is always empty so omitted here).
private val PATTERNS: Map<ClawdPose, Array<String>> = mapOf(
    ClawdPose.Default to arrayOf(
        "000111111111111000",
        "000110111111011000",
        "011111111111111110",
        "000111111111111000",
        "000010100001010000",
    ),
    ClawdPose.LookLeft to arrayOf(
        "000101111111011000",
        "000111111111111000",
        "011111111111111110",
        "000111111111111000",
        "000010100001010000",
    ),
    ClawdPose.LookRight to arrayOf(
        "000110111111101000",
        "000111111111111000",
        "011111111111111110",
        "000111111111111000",
        "000010100001010000",
    ),
    ClawdPose.ArmsUp to arrayOf(
        "000111111111111000",
        "011110111111011110",
        "001111111111111100",
        "000111111111111000",
        "000010100001010000",
    ),
)

private data class Frame(val pose: ClawdPose, val crouch: Boolean, val durationMs: Long)

// Upstream: FRAME_MS = 60ms. Sequences from AnimatedClawd.tsx.
private val JUMP_WAVE = listOf(
    Frame(ClawdPose.Default, true,  120L),
    Frame(ClawdPose.ArmsUp,  false, 180L),
    Frame(ClawdPose.Default, false,  60L),
    Frame(ClawdPose.Default, true,  120L),
    Frame(ClawdPose.ArmsUp,  false, 180L),
    Frame(ClawdPose.Default, false,  60L),
)

private val LOOK_AROUND = listOf(
    Frame(ClawdPose.LookRight, false, 300L),
    Frame(ClawdPose.LookLeft,  false, 300L),
    Frame(ClawdPose.Default,   false,  60L),
)

@Composable
fun ClawdLogo(
    modifier: Modifier = Modifier,
    pixelSize: Dp = 5.dp,
    interactive: Boolean = true,
    autoAnimate: Boolean = true,
) {
    var pose by remember { mutableStateOf(ClawdPose.Default) }
    var crouching by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    var currentJob by remember { mutableStateOf<Job?>(null) }

    val crouchOffset by animateDpAsState(
        targetValue = if (crouching) pixelSize * 2f else 0.dp,
        label = "clawd-crouch",
    )

    fun runRandomSequence() {
        currentJob?.cancel()
        currentJob = scope.launch {
            val seq = if (Random.nextBoolean()) JUMP_WAVE else LOOK_AROUND
            try {
                for (f in seq) {
                    pose = f.pose
                    crouching = f.crouch
                    delay(f.durationMs)
                }
            } finally {
                pose = ClawdPose.Default
                crouching = false
            }
        }
    }

    if (autoAnimate) {
        LaunchedEffect(Unit) {
            delay(Random.nextLong(2500L, 5000L))
            while (true) {
                if (currentJob?.isActive != true) {
                    runRandomSequence()
                }
                delay(Random.nextLong(4000L, 9000L))
            }
        }
    }

    val tap = if (interactive) {
        Modifier.clickable { runRandomSequence() }
    } else Modifier

    // Each pixel is rendered as 1 unit wide x 2 units tall, matching CLI cell
    // aspect (cells in monospace terminals are roughly 1:2 width:height).
    val totalWidth = pixelSize * 18
    val visibleHeight = pixelSize * 2 * 5  // 5 rows × tall pixel
    val crouchSlack = pixelSize * 2
    val totalHeight = visibleHeight + crouchSlack

    Canvas(
        modifier = modifier
            .size(width = totalWidth, height = totalHeight)
            .then(tap),
    ) {
        val pw = pixelSize.toPx()
        val ph = pw * 2f
        val yShift = crouchOffset.toPx()
        val pattern = PATTERNS.getValue(pose)
        for (rowIdx in pattern.indices) {
            val row = pattern[rowIdx]
            for (colIdx in row.indices) {
                if (row[colIdx] == '1') {
                    drawRect(
                        color = ClawdBody,
                        topLeft = Offset(colIdx * pw, rowIdx * ph + yShift),
                        size = Size(pw, ph),
                    )
                }
            }
        }
    }
}
