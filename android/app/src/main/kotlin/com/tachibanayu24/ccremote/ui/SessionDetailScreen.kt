package com.tachibanayu24.ccremote.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.tachibanayu24.ccremote.data.SessionDetailResponse
import com.tachibanayu24.ccremote.data.ToolUsage
import com.tachibanayu24.ccremote.data.Turn

@Composable
fun SessionDetailScreen(
    detail: SessionDetailResponse?,
    fallbackProjectName: String,
    onBack: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .safeDrawingPadding(),
    ) {
        TopBar(
            projectName = detail?.session?.project_name ?: fallbackProjectName,
            aiTitle = detail?.session?.ai_title,
            onBack = onBack,
        )
        if (detail == null) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(28.dp))
            }
            return@Column
        }

        // Backend returns turns newest-first (DESC). Reverse for chat-style
        // chronological order: oldest at top, latest at bottom.
        val turns = detail.turns.asReversed()
        val currentPrompt = detail.session.current_prompt?.takeIf { it.isNotBlank() }
        val hasInFlight = currentPrompt != null

        if (turns.isEmpty() && !hasInFlight) {
            EmptyState()
            return@Column
        }

        val listState = rememberLazyListState()
        // Scroll to bottom whenever the visible item count grows — covers both
        // initial load and incremental updates from the 15s detail poll.
        val itemCount = turns.size + if (hasInFlight) 1 else 0
        LaunchedEffect(itemCount) {
            if (itemCount > 0) listState.animateScrollToItem(itemCount - 1)
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            state = listState,
            contentPadding = androidx.compose.foundation.layout.PaddingValues(
                horizontal = 16.dp,
                vertical = 12.dp,
            ),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            items(turns, key = { it.id }) { TurnBlock(it) }
            if (currentPrompt != null) {
                item(key = "in-flight") {
                    InFlightBlock(currentPrompt)
                }
            }
        }
    }
}

@Composable
private fun TopBar(
    projectName: String,
    aiTitle: String?,
    onBack: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 4.dp, end = 8.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onBack) {
            Icon(
                imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                contentDescription = "back",
            )
        }
        Column {
            Text(
                text = projectName,
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.primary,
                fontFamily = FontFamily.Monospace,
            )
            if (!aiTitle.isNullOrBlank()) {
                Text(
                    text = aiTitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun TurnBlock(turn: Turn) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (!turn.user_prompt.isNullOrBlank()) {
            Text(
                text = "▷ ${turn.user_prompt}",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.primary,
                fontFamily = FontFamily.Monospace,
            )
        }
        if (!turn.assistant_text.isNullOrBlank()) {
            ChatMarkdown(
                text = turn.assistant_text,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
        val footer = footerLine(turn)
        if (footer.isNotBlank()) {
            Text(
                text = footer,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}

@Composable
private fun InFlightBlock(prompt: String) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            text = "▷ $prompt",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.primary,
            fontFamily = FontFamily.Monospace,
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(6.dp)
                    .background(Color(0xFF4ADE80), CircleShape),
            )
            Spacer(Modifier.size(6.dp))
            Text(
                text = "in flight…",
                style = MaterialTheme.typography.labelSmall,
                color = Color(0xFF4ADE80),
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}

private fun footerLine(turn: Turn): String {
    val parts = mutableListOf<String>()
    formatElapsed(turn.elapsed_ms)?.let { parts += it }
    if (turn.tool_summary.isNotEmpty()) parts += summarizeTools(turn.tool_summary)
    return parts.joinToString(" · ")
}

private fun summarizeTools(tools: List<ToolUsage>): String =
    tools.joinToString(" ") { "${it.name}×${it.count}" }

private fun formatElapsed(ms: Long?): String? {
    if (ms == null || ms < 0) return null
    val s = ms / 1000
    if (s < 60) return "${s}s"
    val m = s / 60
    val sec = s % 60
    if (m < 60) return if (sec == 0L) "${m}m" else "${m}m ${sec}s"
    val h = m / 60
    val min = m % 60
    return if (min == 0L) "${h}h" else "${h}h ${min}m"
}

@Composable
private fun EmptyState() {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(
            text = "no turns yet",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontFamily = FontFamily.Monospace,
        )
    }
}
