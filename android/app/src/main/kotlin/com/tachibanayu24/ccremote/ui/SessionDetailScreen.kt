package com.tachibanayu24.ccremote.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.tachibanayu24.ccremote.data.PendingApproval
import com.tachibanayu24.ccremote.data.QueuedPrompt
import com.tachibanayu24.ccremote.data.SessionDetailResponse
import com.tachibanayu24.ccremote.data.ToolUsage
import com.tachibanayu24.ccremote.data.Turn

private val InFlightAccent = Color(0xFF4ADE80)
private val PendingAccent = Color(0xFFFACC15)
private val QueuedAccent = Color(0xFF94A3B8)

// Mirror backend SESSION_HEARTBEAT_TTL_SEC: a session that hasn't pinged in
// 30s is considered closed and can't accept new prompts (channel.mjs is gone).
private const val SESSION_LIVE_TTL_SEC = 30L

@Composable
fun SessionDetailScreen(
    detail: SessionDetailResponse?,
    fallbackProjectName: String,
    isSendingPrompt: Boolean,
    onBack: () -> Unit,
    onSendPrompt: (String) -> Unit,
    onDecideApproval: (approvalId: String, decision: String, addToAllowlist: Boolean) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            // Pad for status/nav bars only. Don't pad for IME — let the
            // system's default pan behaviour shift the whole window up
            // when the keyboard opens, which keeps the latest chat items
            // visible above the keyboard without us recomputing layout.
            .windowInsetsPadding(WindowInsets.systemBars),
    ) {
        TopBar(
            projectName = detail?.session?.project_name ?: fallbackProjectName,
            aiTitle = detail?.session?.ai_title,
            onBack = onBack,
        )

        // Backend returns turns newest-first (DESC). Reverse for chat-style
        // chronological order: oldest at top, latest at bottom.
        val turns = detail?.turns?.asReversed().orEmpty()
        val pendingApprovals = detail?.pending_approvals.orEmpty()
        val currentPrompt = detail?.session?.current_prompt?.takeIf { it.isNotBlank() }
        val currentAssistantText = detail?.session?.current_assistant_text?.takeIf { it.isNotBlank() }
        val hasInFlight = currentPrompt != null
        // Backend also returns recently-delivered prompts so the queued bubble
        // doesn't flicker off during the gap between channel.mjs ack and the
        // heartbeat that picks the prompt up as current_prompt. Drop any
        // whose text already matches current_prompt (morphed into in-flight)
        // OR any committed turn's user_prompt (the turn finished — the bubble
        // would otherwise linger as a duplicate of the just-rendered turn).
        val committedPromptTexts = turns.mapNotNull {
            it.user_prompt?.takeIf { p -> p.isNotBlank() }
        }.toSet()
        val queuedPrompts = (detail?.queued_prompts.orEmpty()).filter {
            it.text != currentPrompt && it.text !in committedPromptTexts
        }

        val listState = rememberLazyListState()
        // Scroll to *bottom* whenever the visible content meaningfully
        // changes. animateScrollToItem(index) aligns the item top to the
        // viewport top, which leaves the last item floating with empty
        // space below — what we want is the last item's bottom flush with
        // the viewport bottom. scrollOffset=Int.MAX_VALUE asks for an
        // impossibly far-down position, which Compose clamps to the
        // maximum valid scroll → exactly "bottom of the last item at the
        // bottom of the viewport".
        val lastIndex = turns.size +
            (if (hasInFlight) 1 else 0) +
            queuedPrompts.size +
            pendingApprovals.size - 1
        val assistantLen = currentAssistantText?.length ?: 0
        LaunchedEffect(lastIndex, assistantLen) {
            if (lastIndex >= 0) {
                listState.scrollToItem(lastIndex, scrollOffset = Int.MAX_VALUE)
            }
        }

        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            when {
                detail == null -> Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(28.dp))
                }
                turns.isEmpty() && !hasInFlight && queuedPrompts.isEmpty() && pendingApprovals.isEmpty() -> EmptyState()
                else -> LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    state = listState,
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(
                        horizontal = 16.dp,
                        vertical = 12.dp,
                    ),
                    verticalArrangement = Arrangement.spacedBy(20.dp),
                ) {
                    items(turns, key = { it.id }) { TurnBlock(it) }
                    if (hasInFlight) {
                        item(key = "in-flight") {
                            InFlightBlock(prompt = currentPrompt!!, assistantText = currentAssistantText)
                        }
                    }
                    items(queuedPrompts, key = { "queued-${it.id}" }) { p -> QueuedPromptBlock(p) }
                    items(pendingApprovals, key = { "approval-${it.id}" }) { approval ->
                        PendingApprovalBlock(approval = approval, onDecide = onDecideApproval)
                    }
                }
            }
        }

        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        val sessionIsLive = detail?.session?.last_heartbeat?.let {
            System.currentTimeMillis() / 1000 - it < SESSION_LIVE_TTL_SEC
        } ?: true  // optimistic before first detail load arrives
        PromptInputBar(
            isSending = isSendingPrompt,
            isEnabled = sessionIsLive,
            onSend = onSendPrompt,
        )
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
private fun InFlightBlock(prompt: String, assistantText: String?) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = "▷ $prompt",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.primary,
            fontFamily = FontFamily.Monospace,
        )
        if (!assistantText.isNullOrBlank()) {
            ChatMarkdown(
                text = assistantText,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(6.dp)
                    .background(InFlightAccent, CircleShape),
            )
            Spacer(Modifier.size(6.dp))
            Text(
                text = "in flight…",
                style = MaterialTheme.typography.labelSmall,
                color = InFlightAccent,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}

@Composable
private fun QueuedPromptBlock(prompt: QueuedPrompt) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            text = "▷ ${prompt.text}",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.primary,
            fontFamily = FontFamily.Monospace,
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(6.dp)
                    .background(QueuedAccent, CircleShape),
            )
            Spacer(Modifier.size(6.dp))
            Text(
                text = "queued… (waiting for cc to pick up)",
                style = MaterialTheme.typography.labelSmall,
                color = QueuedAccent,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}

@Composable
private fun PendingApprovalBlock(
    approval: PendingApproval,
    onDecide: (String, String, Boolean) -> Unit,
) {
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .background(PendingAccent, CircleShape),
                )
                Spacer(Modifier.size(8.dp))
                Text(
                    text = "awaiting · ${approval.tool_name}",
                    style = MaterialTheme.typography.labelLarge,
                    color = PendingAccent,
                    fontFamily = FontFamily.Monospace,
                )
            }
            val description = approval.description
                .takeIf { it.isNotBlank() && !(it.startsWith("{") && it.endsWith("}")) }
            val command = approvalCommand(approval)
            if (description != null && description != command) {
                Text(
                    text = description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (command.isNotBlank()) {
                Surface(
                    shape = RoundedCornerShape(8.dp),
                    color = MaterialTheme.colorScheme.surface,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        text = command,
                        style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                        color = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.padding(10.dp),
                    )
                }
            }
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Button(
                    onClick = { onDecide(approval.id, "allow", false) },
                    modifier = Modifier.weight(1f),
                ) { Text("Allow") }
                Button(
                    onClick = { onDecide(approval.id, "allow", true) },
                    modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.tertiary,
                        contentColor = MaterialTheme.colorScheme.onTertiary,
                    ),
                ) { Text("Always") }
                OutlinedButton(
                    onClick = { onDecide(approval.id, "deny", false) },
                    modifier = Modifier.weight(1f),
                ) { Text("Deny") }
            }
        }
    }
}

@Composable
private fun PromptInputBar(
    isSending: Boolean,
    isEnabled: Boolean,
    onSend: (String) -> Unit,
) {
    var text by remember { mutableStateOf("") }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            modifier = Modifier.weight(1f),
            placeholder = {
                Text(
                    text = if (isEnabled) "send a prompt…" else "session closed — restart cc-remote channel",
                    fontFamily = FontFamily.Monospace,
                )
            },
            textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
            maxLines = 4,
            enabled = isEnabled && !isSending,
        )
        Spacer(Modifier.size(8.dp))
        IconButton(
            onClick = {
                val toSend = text.trim()
                if (toSend.isNotEmpty()) {
                    onSend(toSend)
                    text = ""
                }
            },
            enabled = isEnabled && !isSending && text.isNotBlank(),
        ) {
            if (isSending) {
                CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
            } else {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.Send,
                    contentDescription = "send",
                )
            }
        }
    }
}

/**
 * Pull the actually-executed command / target out of `input_preview` so the
 * user knows what they're approving. `input_preview` is the JSON-stringified
 * tool input (truncated to 200 chars by Channels), `description` is CC's
 * friendly action label. Returns the tool's key argument when we can extract
 * it (Bash → command, Edit → file_path, Grep → pattern, etc.), falling back
 * to the raw input_preview so we never silently swallow context.
 */
private fun approvalCommand(approval: PendingApproval): String {
    val parsed = runCatching { org.json.JSONObject(approval.input_preview) }.getOrNull()
    val keyArg = when (approval.tool_name) {
        "Bash" -> parsed?.optString("command")?.takeIf { it.isNotBlank() }
            ?: extractKey(approval.input_preview, "command")
        "Edit", "Write", "MultiEdit" -> parsed?.optString("file_path")?.takeIf { it.isNotBlank() }
            ?: extractKey(approval.input_preview, "file_path")
        "Read", "Glob" -> parsed?.optString("file_path")?.takeIf { it.isNotBlank() }
            ?: parsed?.optString("pattern")?.takeIf { it.isNotBlank() }
            ?: extractKey(approval.input_preview, "file_path")
            ?: extractKey(approval.input_preview, "pattern")
        "Grep" -> parsed?.optString("pattern")?.takeIf { it.isNotBlank() }
            ?: extractKey(approval.input_preview, "pattern")
        else -> null
    }
    return keyArg ?: approval.input_preview.ifBlank { approval.tool_name }
}

/**
 * Channels truncates input_preview at 200 chars, often mid-string. Fall back
 * to a regex that handles a partially-broken JSON `"<key>":"..."` pair.
 */
private fun extractKey(text: String, key: String): String? {
    val m = Regex("\"$key\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)").find(text) ?: return null
    val raw = m.groupValues[1]
    val unescaped = raw
        .replace("\\\"", "\"")
        .replace("\\\\", "\\")
        .replace("\\n", "\n")
        .replace("\\t", "\t")
    return unescaped.takeIf { it.isNotBlank() }
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
            text = "no turns yet — send a prompt below",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontFamily = FontFamily.Monospace,
        )
    }
}
