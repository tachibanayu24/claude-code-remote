package com.tachibanayu24.ccremote.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.tachibanayu24.ccremote.data.Session

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    sessions: List<Session>,
    isRefreshing: Boolean,
    onRefresh: () -> Unit,
    onOpenSettings: () -> Unit,
    onSelectSession: (String) -> Unit,
) {
    // Refresh whenever the home screen is presented (e.g. after returning
    // from detail/settings). The 30s poll covers passive updates; this
    // covers the "I just opened the app" case.
    LaunchedEffect(Unit) { onRefresh() }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .safeDrawingPadding(),
    ) {
        TopBar(onOpenSettings = onOpenSettings)
        // Filter sessions only when the source list changes — avoids running
        // the partition every recomposition.
        val partitioned by remember(sessions) {
            derivedStateOf {
                sessions.partition { it.state != "closed" }
            }
        }
        val (active, closed) = partitioned

        PullToRefreshBox(
            isRefreshing = isRefreshing,
            onRefresh = onRefresh,
            modifier = Modifier.fillMaxSize(),
        ) {
            if (sessions.isEmpty()) {
                EmptyState(modifier = Modifier.fillMaxSize())
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    if (active.isNotEmpty()) {
                        item { SectionLabel("active") }
                        items(active, key = { it.session_id }) {
                            SessionRow(it, onClick = { onSelectSession(it.session_id) })
                        }
                    }
                    if (closed.isNotEmpty()) {
                        item { SectionLabel("closed", topPadding = 16.dp) }
                        items(closed, key = { it.session_id }) {
                            SessionRow(it, onClick = { onSelectSession(it.session_id) })
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TopBar(onOpenSettings: () -> Unit) {
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
        IconButton(onClick = onOpenSettings) {
            Icon(
                imageVector = Icons.Filled.Settings,
                contentDescription = "設定を開く",
            )
        }
    }
}

@Composable
private fun SectionLabel(label: String, topPadding: Dp = 0.dp) {
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
private fun SessionRow(session: Session, onClick: () -> Unit) {
    val titleLine = remember(session) { titleLineFor(session) }
    val talkBackLabel = remember(session, titleLine) {
        "${stateLabel(session)}, $titleLine"
    }
    Card(
        modifier = Modifier
            .fillMaxWidth()
            // 48dp minimum tap target satisfies a11y guidelines even on
            // small font scales.
            .sizeIn(minHeight = 48.dp)
            .clickable(onClickLabel = "セッションを開く", onClick = onClick)
            .semantics {
                role = Role.Button
                contentDescription = talkBackLabel
            },
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
                    text = titleLine,
                    style = MaterialTheme.typography.titleSmall,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                // ai_title is already encoded in titleLine; subtitle just
                // shows the live state so we don't repeat it.
                val subtitle = stateLabel(session)
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

/**
 * Title line shown in the home list. Multiple CC sessions can live in the
 * same project, so append a discriminator: ai_title if CC has named the
 * session, otherwise the last 6 hex chars of session_id (the same `#abcd1f`
 * shorthand used in logs).
 */
private fun titleLineFor(session: Session): String {
    val discriminator = session.ai_title?.takeIf { it.isNotBlank() }
        ?: "#" + session.session_id.takeLast(6)
    return "${session.project_name} · $discriminator"
}

private val WorkingColor = Color(0xFF4ADE80)            // green
private val AwaitingColor = Color(0xFFFACC15)            // amber
private val IdleColor = Color(0xFF94A3B8)                // slate
private val ClosedColor = Color(0xFF475569)              // dark slate

@Composable
private fun StateDot(state: String) {
    val color = when (state) {
        "working" -> WorkingColor
        "awaiting_approval" -> AwaitingColor
        "idle" -> IdleColor
        else -> ClosedColor
    }
    Box(
        modifier = Modifier
            .size(10.dp)
            .background(color = color, shape = CircleShape),
    )
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

