package com.tachibanayu24.ccremote.ui

import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.RepeatMode
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
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
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import com.tachibanayu24.ccremote.data.Block
import com.tachibanayu24.ccremote.data.PendingApproval
import com.tachibanayu24.ccremote.data.PendingQuestion
import com.tachibanayu24.ccremote.data.QueuedPrompt
import com.tachibanayu24.ccremote.data.SessionDetailResponse
import com.tachibanayu24.ccremote.data.ToolCall
import com.tachibanayu24.ccremote.data.ToolUsage
import com.tachibanayu24.ccremote.data.Turn
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonObject

private val InFlightAccent = Color(0xFF4ADE80)
private val PendingAccent = Color(0xFFFACC15)
private val QueuedAccent = Color(0xFF94A3B8)

// Mirror backend SESSION_HEARTBEAT_TTL_SEC: a session that hasn't pinged in
// 30s is considered closed and can't accept new prompts (channel.mjs is gone).
private const val SESSION_LIVE_TTL_SEC = 30L

@Composable
fun SessionDetailScreen(
    detail: SessionDetailResponse?,
    isSendingPrompt: Boolean,
    onBack: () -> Unit,
    onSendPrompt: (String) -> Unit,
    onDecideApproval: (approvalId: String, decision: String, addToAllowlist: Boolean) -> Unit,
    onAnswerQuestion: (questionId: String, answers: JsonObject) -> Unit,
    onCloseSession: () -> Unit,
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
        // Title is just the ai_title (or a session-id discriminator if CC
        // hasn't named it yet). The project name is already on Home and
        // would be redundant noise here.
        val sessionId = detail?.session?.session_id
        val aiTitle = detail?.session?.ai_title?.takeIf { it.isNotBlank() }
        val titleText = aiTitle
            ?: sessionId?.let { "#${it.takeLast(6)}" }
            ?: ""

        // Backend returns turns newest-first (DESC). Reverse for chat-style
        // chronological order: oldest at top, latest at bottom.
        val turns = remember(detail) { detail?.turns?.asReversed().orEmpty() }
        val pendingApprovals = detail?.pending_approvals.orEmpty()
        val pendingQuestions = detail?.pending_questions.orEmpty()
        val currentPrompt = detail?.session?.current_prompt?.takeIf { it.isNotBlank() }
        val currentBlocks = detail?.session?.current_blocks.orEmpty()
        val hasInFlight = currentPrompt != null

        // Re-evaluate "is the channel.mjs alive?" once a second so menu /
        // input bar enable state stays in sync, not only when a new heartbeat
        // bumps `detail`.
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
        // 「閉じる」 dialog の文言切り替え用。 null = idle (graceful 終了),
        // 非 null = in-flight (強制終了の警告を表示)。
        val inflightLabel: String? = when {
            hasInFlight -> "ターン処理中"
            pendingApprovals.isNotEmpty() || pendingQuestions.isNotEmpty() -> "承認待ち"
            else -> null
        }
        TopBar(
            title = titleText,
            onBack = onBack,
            canClose = sessionIsLive,
            inflightLabel = inflightLabel,
            onCloseSession = onCloseSession,
        )
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
            pendingApprovals.size +
            pendingQuestions.size
        // Track total characters across all blocks so in-flight streaming
        // (text appended one chunk at a time) triggers the auto-scroll.
        val liveLen = currentBlocks.sumOf {
            when (it.kind) {
                "text" -> it.text?.length ?: 0
                else -> 1
            }
        }
        LaunchedEffect(itemCount, liveLen) {
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
                turns.isEmpty() && !hasInFlight && queuedPrompts.isEmpty() && pendingApprovals.isEmpty() && pendingQuestions.isEmpty() -> EmptyState()
                else -> LazyColumn(
                    // Chat content is slightly translucent so the animated
                    // Clawd backdrop bleeds through where text or whitespace
                    // permits. Cards (PendingApprovalBlock) inherit the same
                    // alpha so they don't feel like opaque islands.
                    modifier = Modifier
                        .fillMaxSize()
                        .alpha(0.82f),
                    state = listState,
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(20.dp),
                ) {
                    items(turns, key = { it.id }) { TurnBlock(it) }
                    if (hasInFlight) {
                        item(key = "in-flight") {
                            InFlightBlock(prompt = currentPrompt!!, blocks = currentBlocks)
                        }
                    }
                    items(queuedPrompts, key = { "queued-${it.id}" }) { p -> QueuedPromptBlock(p) }
                    items(pendingApprovals, key = { "approval-${it.id}" }) { approval ->
                        PendingApprovalBlock(approval = approval, onDecide = onDecideApproval)
                    }
                    items(pendingQuestions, key = { "question-${it.id}" }) { question ->
                        PendingQuestionBlock(question = question, onAnswer = onAnswerQuestion)
                    }
                }
            }
        }

        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        PromptInputBar(
            isSending = isSendingPrompt,
            isEnabled = sessionIsLive,
            onSend = onSendPrompt,
        )
    }
}

@Composable
private fun TopBar(
    title: String,
    onBack: () -> Unit,
    canClose: Boolean,
    inflightLabel: String?,
    onCloseSession: () -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    var showCloseDialog by remember { mutableStateOf(false) }
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
        if (title.isNotBlank()) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.primary,
                fontFamily = FontFamily.Monospace,
            )
        }
        Spacer(Modifier.weight(1f))
        // channel.mjs が生きてる (= SIGTERM を届けられる) ときだけ menu を出す。
        // closed セッションでは marker を立てても消費する側が居ないので意味なし。
        if (canClose) {
            Box {
                IconButton(onClick = { menuOpen = true }) {
                    Icon(
                        imageVector = Icons.Filled.MoreVert,
                        contentDescription = "メニュー",
                    )
                }
                DropdownMenu(
                    expanded = menuOpen,
                    onDismissRequest = { menuOpen = false },
                ) {
                    DropdownMenuItem(
                        text = { Text("閉じる") },
                        onClick = {
                            menuOpen = false
                            showCloseDialog = true
                        },
                    )
                }
            }
        }
    }
    if (showCloseDialog) {
        SessionCloseDialog(
            sessionLabel = title,
            inflightLabel = inflightLabel,
            onConfirm = {
                showCloseDialog = false
                onCloseSession()
            },
            onDismiss = { showCloseDialog = false },
        )
    }
}

/**
 * 閉じる確認 dialog。 in-flight (working / awaiting_approval) の場合は
 * 「処理中だが終了させる」 旨を強調する。 inflightLabel が null なら idle 扱い。
 */
@Composable
private fun SessionCloseDialog(
    sessionLabel: String,
    inflightLabel: String?,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    val inflight = inflightLabel != null
    val titleText = if (inflight) "処理中のセッションを閉じる？" else "セッションを閉じる？"
    val body = buildString {
        if (sessionLabel.isNotBlank()) {
            append(sessionLabel)
            append("\n\n")
        }
        if (inflight) {
            append("CC は現在 ")
            append(inflightLabel)
            append(" です。 SIGTERM を送って強制終了します。 ")
            append("作業途中の jsonl flush が間に合わない可能性があるので、 急ぎでなければ完了を待つことを推奨します。")
        } else {
            append("PC の CC プロセスに SIGTERM を送って終了させます。 ")
            append("(CC は graceful に jsonl を flush して落ちます)")
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(titleText) },
        text = { Text(body) },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(if (inflight) "強制終了" else "閉じる")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("キャンセル") }
        },
    )
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
        // Render blocks in the exact order they appeared in CC's jsonl, so a
        // narration → Edit → narration → Bash sequence shows interleaved
        // (matching the CLI), not "all text first, all tools last".
        BlockList(blocks = turn.blocks, keyPrefix = turn.id)
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

/**
 * Render an ordered list of narration / tool_use blocks. Text blocks share
 * an outer SelectionContainer so a multi-block highlight gesture works; each
 * tool_use block carries its own inner selection (CodeBlock / DiffView).
 */
@Composable
private fun BlockList(blocks: List<Block>, keyPrefix: String) {
    blocks.forEachIndexed { idx, b ->
        when (b.kind) {
            "text" -> {
                val text = b.text
                if (!text.isNullOrBlank()) {
                    SelectionContainer {
                        ChatMarkdown(
                            text = text,
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                    }
                }
            }
            "tool_use" -> {
                val call = ToolCall(
                    name = b.name ?: "",
                    input = b.input ?: JsonObject(emptyMap()),
                )
                ToolCallBlock(call = call, key = "${keyPrefix}#$idx")
            }
        }
    }
}

@Composable
private fun InFlightBlock(prompt: String, blocks: List<Block>) {
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
        // Live blocks reuse the same ordered renderer as committed turns so
        // in-flight Bash invocations / Edits are visible mid-turn, not just
        // the partial narration.
        BlockList(blocks = blocks, keyPrefix = "in-flight")
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

/**
 * 承認 / 質問カード共通の外枠。 awaiting アクセントの色付き丸 + ヘッダー文字
 * + body スロット。 ドメイン固有 (Allow/Deny ボタン or QuestionForm) は content
 * lambda に任せる。
 */
@Composable
private fun PendingCard(
    header: String,
    content: @Composable ColumnScope.() -> Unit,
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
                    text = header,
                    style = MaterialTheme.typography.labelLarge,
                    color = PendingAccent,
                    fontFamily = FontFamily.Monospace,
                )
            }
            content()
        }
    }
}

@Composable
private fun PendingApprovalBlock(
    approval: PendingApproval,
    onDecide: (String, String, Boolean) -> Unit,
) {
    val haptic = LocalHapticFeedback.current
    PendingCard(header = "awaiting · ${approval.tool_name}") {
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
            if (approval.supports_always) {
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
            }
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

@Composable
private fun PendingQuestionBlock(
    question: PendingQuestion,
    onAnswer: (questionId: String, answers: JsonObject) -> Unit,
) {
    val haptic = LocalHapticFeedback.current
    var isSubmitting by remember(question.id) { mutableStateOf(false) }
    val count = question.questions.size
    PendingCard(header = "asking · $count question${if (count > 1) "s" else ""}") {
        QuestionForm(
            questions = question.questions,
            isSubmitting = isSubmitting,
            error = null,
            onSubmit = { answers ->
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                isSubmitting = true
                onAnswer(question.id, answers)
                // 次の polling (1.5s) で pending row が消えれば自然にリセット。
            },
        )
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
    // 端末標準の音声認識 Activity を起動して結果テキストを取得する。
    // RECORD_AUDIO 権限は不要 (system UI が持つ)、結果は文字列として戻る。
    val voiceLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val spoken = result.data
            ?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
            ?.firstOrNull()
            ?.takeIf { it.isNotBlank() }
            ?: return@rememberLauncherForActivityResult
        // 既存テキストに半角スペース区切りで追記。空欄ならそのまま差し替え。
        text = if (text.isBlank()) spoken else "$text $spoken"
    }
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
        Spacer(Modifier.size(4.dp))
        IconButton(
            onClick = {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(
                        RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                        RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
                    )
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ja-JP")
                    putExtra(RecognizerIntent.EXTRA_PROMPT, "話してください")
                }
                // 端末に音声認識が無い (極端なカスタム ROM 等) と
                // ActivityNotFoundException が出るので静かに飲み込む。
                runCatching { voiceLauncher.launch(intent) }
            },
            enabled = isEnabled && !isSending,
        ) {
            Icon(
                imageVector = Icons.Default.Mic,
                contentDescription = "音声入力",
            )
        }
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
