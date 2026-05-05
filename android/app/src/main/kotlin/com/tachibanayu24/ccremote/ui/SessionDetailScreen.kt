package com.tachibanayu24.ccremote.ui

import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.RepeatMode
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
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
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.tachibanayu24.ccremote.data.ApprovalCommandFormatter
import com.tachibanayu24.ccremote.data.PendingApproval
import com.tachibanayu24.ccremote.data.QueuedPrompt
import com.tachibanayu24.ccremote.data.SessionDetailResponse
import com.tachibanayu24.ccremote.data.ToolUsage
import com.tachibanayu24.ccremote.data.Turn
import kotlinx.coroutines.delay

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
        val turns = remember(detail) { detail?.turns?.asReversed().orEmpty() }
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
        val queuedPrompts by remember(detail, currentPrompt, turns) {
            derivedStateOf {
                val committed = turns
                    .mapNotNull { it.user_prompt?.takeIf { p -> p.isNotBlank() } }
                    .toSet()
                (detail?.queued_prompts.orEmpty()).filter {
                    it.text != currentPrompt && it.text !in committed
                }
            }
        }

        val listState = rememberLazyListState()
        // Re-run the auto-scroll only when the list shape *or* the live
        // assistant text grows. Tracking just the count would miss the case
        // where in-flight chunks stream in while no new items appear.
        val itemCount = turns.size +
            (if (hasInFlight) 1 else 0) +
            queuedPrompts.size +
            pendingApprovals.size
        val assistantLen = currentAssistantText?.length ?: 0
        LaunchedEffect(itemCount, assistantLen) {
            if (itemCount > 0) {
                listState.scrollToItem(itemCount - 1, scrollOffset = Int.MAX_VALUE)
            }
        }

        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            // Faded Clawd backdrop — a quiet CC accent that animates on its
            // own. Sits behind the chat content; pixelSize/alpha tuned so the
            // mascot reads as decoration rather than something to interact
            // with. interactive=false to let touches reach the LazyColumn.
            ClawdLogo(
                modifier = Modifier
                    .align(Alignment.Center)
                    .alpha(0.35f),
                pixelSize = 10.dp,
                interactive = false,
            )
            when {
                detail == null -> Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(28.dp))
                }
                turns.isEmpty() && !hasInFlight && queuedPrompts.isEmpty() && pendingApprovals.isEmpty() -> EmptyState()
                else -> LazyColumn(
                    // Chat content is slightly translucent so the animated
                    // Clawd backdrop bleeds through where text or whitespace
                    // permits. Cards (PendingApprovalBlock) inherit the same
                    // alpha so they don't feel like opaque islands.
                    modifier = Modifier
                        .fillMaxSize()
                        .alpha(0.72f),
                    state = listState,
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
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
        // Re-evaluate "is the channel.mjs alive?" once a second so the input
        // bar enables/disables in real time, not only when a new heartbeat
        // bumps detail.
        val sessionIsLive by produceState(initialValue = true, key1 = detail?.session?.last_heartbeat) {
            val lastHeartbeat = detail?.session?.last_heartbeat
            if (lastHeartbeat == null) {
                value = true
                return@produceState
            }
            while (true) {
                value = System.currentTimeMillis() / 1000 - lastHeartbeat < SESSION_LIVE_TTL_SEC
                delay(1_000)
            }
        }
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
                contentDescription = "戻る",
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
            SelectionContainer {
                Text(
                    text = "▷ ${turn.user_prompt}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.primary,
                    fontFamily = FontFamily.Monospace,
                )
            }
        }
        if (!turn.assistant_text.isNullOrBlank()) {
            SelectionContainer {
                ChatMarkdown(
                    text = turn.assistant_text,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
        }
        // Inline tool_calls: lightweight kinds compact to one line, Edit/
        // MultiEdit/Write open into a 6-line preview + tap-to-expand diff.
        // Key includes turn.id so each turn's expand state is independent
        // and survives saved-state restoration.
        turn.tool_calls.forEachIndexed { idx, call ->
            ToolCallBlock(call = call, key = "${turn.id}#${idx}")
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
    val transition = rememberInfiniteTransition(label = "in-flight-pulse")
    val pulseAlpha by transition.animateFloat(
        initialValue = 0.4f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 900),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "in-flight-alpha",
    )
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SelectionContainer {
            Text(
                text = "▷ $prompt",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.primary,
                fontFamily = FontFamily.Monospace,
            )
        }
        if (!assistantText.isNullOrBlank()) {
            SelectionContainer {
                ChatMarkdown(
                    text = assistantText,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(6.dp)
                    .alpha(pulseAlpha)
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
        SelectionContainer {
            Text(
                text = "▷ ${prompt.text}",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.primary,
                fontFamily = FontFamily.Monospace,
            )
        }
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
    val haptic = LocalHapticFeedback.current
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
            val command = remember(approval.tool_name, approval.input_preview) {
                ApprovalCommandFormatter.extract(approval.tool_name, approval.input_preview)
            }
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
                    SelectionContainer {
                        Text(
                            text = command,
                            style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                            color = MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.padding(10.dp),
                        )
                    }
                }
            }
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Button(
                    onClick = {
                        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                        onDecide(approval.id, "allow", false)
                    },
                    modifier = Modifier
                        .weight(1f)
                        .semantics {
                            role = Role.Button
                            contentDescription = "${approval.tool_name} を許可"
                        },
                ) { Text("Allow") }
                Button(
                    onClick = {
                        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                        onDecide(approval.id, "allow", true)
                    },
                    modifier = Modifier
                        .weight(1f)
                        .semantics {
                            role = Role.Button
                            contentDescription = "${approval.tool_name} を常に許可"
                        },
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.tertiary,
                        contentColor = MaterialTheme.colorScheme.onTertiary,
                    ),
                ) { Text("Always") }
                OutlinedButton(
                    onClick = {
                        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                        onDecide(approval.id, "deny", false)
                    },
                    modifier = Modifier
                        .weight(1f)
                        .semantics {
                            role = Role.Button
                            contentDescription = "${approval.tool_name} を拒否"
                        },
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
    val haptic = LocalHapticFeedback.current
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
                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
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
                    contentDescription = "送信",
                )
            }
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
            text = "no turns yet — send a prompt below",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontFamily = FontFamily.Monospace,
        )
    }
}
