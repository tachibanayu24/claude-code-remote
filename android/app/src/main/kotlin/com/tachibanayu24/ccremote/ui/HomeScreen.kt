package com.tachibanayu24.ccremote.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.tachibanayu24.ccremote.data.Session

@Composable
fun HomeScreen(
    sessions: List<Session>,
    isRefreshing: Boolean,
    onRefresh: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .safeDrawingPadding(),
    ) {
        TopBar(
            isRefreshing = isRefreshing,
            onRefresh = onRefresh,
            onOpenSettings = onOpenSettings,
        )
        if (sessions.isEmpty()) {
            EmptyState(modifier = Modifier.fillMaxSize())
        } else {
            val active = sessions.filter { it.state != "closed" }
            val closed = sessions.filter { it.state == "closed" }
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(
                    horizontal = 12.dp,
                    vertical = 8.dp,
                ),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (active.isNotEmpty()) {
                    item { SectionLabel("active") }
                    items(active, key = { it.cwd }) { SessionRow(it) }
                }
                if (closed.isNotEmpty()) {
                    item { SectionLabel("closed", topPadding = 16.dp) }
                    items(closed, key = { it.cwd }) { SessionRow(it) }
                }
            }
        }
    }
}

@Composable
private fun TopBar(
    isRefreshing: Boolean,
    onRefresh: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = "claude-code-remote",
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.primary,
            fontFamily = FontFamily.Monospace,
        )
        Spacer(Modifier.weight(1f))
        IconButton(onClick = onRefresh, enabled = !isRefreshing) {
            if (isRefreshing) {
                CircularProgressIndicator(
                    modifier = Modifier.size(20.dp),
                    strokeWidth = 2.dp,
                )
            } else {
                Icon(
                    imageVector = Icons.Filled.Refresh,
                    contentDescription = "refresh",
                )
            }
        }
        IconButton(onClick = onOpenSettings) {
            Icon(
                imageVector = Icons.Filled.Settings,
                contentDescription = "settings",
            )
        }
    }
}

@Composable
private fun SectionLabel(label: String, topPadding: androidx.compose.ui.unit.Dp = 0.dp) {
    Text(
        text = "— $label —",
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        fontFamily = FontFamily.Monospace,
        modifier = Modifier
            .padding(top = topPadding, bottom = 4.dp, start = 8.dp),
    )
}

@Composable
private fun SessionRow(session: Session) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(10.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            StateDot(state = session.state)
            Spacer(Modifier.size(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = session.project_name,
                    style = MaterialTheme.typography.titleSmall,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                val subtitle = subtitleFor(session)
                if (subtitle.isNotBlank()) {
                    Text(
                        text = subtitle,
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun StateDot(state: String) {
    val color = when (state) {
        "working" -> Color(0xFF4ADE80)            // green
        "awaiting_approval" -> Color(0xFFFACC15)  // amber
        "idle" -> Color(0xFF94A3B8)               // slate
        else -> Color(0xFF475569)                 // closed: dark slate
    }
    Box(
        modifier = Modifier
            .size(10.dp)
            .background(color = color, shape = CircleShape),
    )
}

private fun subtitleFor(session: Session): String {
    val label = stateLabel(session)
    val title = session.ai_title?.takeIf { it.isNotBlank() }
    return if (title != null) "$label · $title" else label
}

private fun stateLabel(session: Session): String = when (session.state) {
    "working" -> "working"
    "awaiting_approval" -> "awaiting (${session.pending_count})"
    "idle" -> "idle · ${formatAgo(session.heartbeat_age_sec)}"
    else -> "closed · ${formatAgo(session.heartbeat_age_sec)}"
}

private fun formatAgo(sec: Long): String {
    if (sec < 60) return "${sec}s ago"
    val m = sec / 60
    if (m < 60) return "${m}m ago"
    val h = m / 60
    if (h < 24) return "${h}h ago"
    return "${h / 24}d ago"
}

@Composable
private fun EmptyState(modifier: Modifier = Modifier) {
    Box(modifier = modifier, contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            ClawdLogo(pixelSize = 4.dp)
            Spacer(Modifier.height(16.dp))
            Text(
                text = "no sessions yet",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontFamily = FontFamily.Monospace,
            )
            Text(
                text = "start CC with cc-remote channel to register",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
