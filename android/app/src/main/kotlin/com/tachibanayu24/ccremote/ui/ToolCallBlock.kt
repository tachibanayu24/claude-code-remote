package com.tachibanayu24.ccremote.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tachibanayu24.ccremote.data.ToolCall
import com.tachibanayu24.ccremote.data.bashCommand
import com.tachibanayu24.ccremote.data.editOp
import com.tachibanayu24.ccremote.data.filePath
import com.tachibanayu24.ccremote.data.multiEditOps
import com.tachibanayu24.ccremote.data.pattern
import com.tachibanayu24.ccremote.data.str
import com.tachibanayu24.ccremote.data.url
import com.tachibanayu24.ccremote.data.writeContent
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import com.tachibanayu24.ccremote.ui.code.CodeBlock
import com.tachibanayu24.ccremote.ui.code.extensionOf
import com.tachibanayu24.ccremote.ui.code.resolveLanguage
import com.tachibanayu24.ccremote.ui.diff.DiffLine
import com.tachibanayu24.ccremote.ui.diff.DiffView
import com.tachibanayu24.ccremote.ui.diff.computeDiff
import dev.snipme.highlights.model.SyntaxLanguage
import java.net.URI

// Lines visible when collapsed — enough to show what changed without
// scrolling, small enough that long edits don't dominate the chat list.
private const val PREVIEW_LINES = 6

// Hard cap on rendered diff lines (even when fully expanded). Past this we
// just chop the tail and surface "…一部省略" so Compose doesn't have to lay
// out arbitrarily large diffs on a phone.
private const val DIFF_MAX_LINES = 300

/**
 * Render a single tool_use call inline under the assistant's narration.
 * Lightweight kinds (Bash command, Read path, ...) collapse to one line;
 * heavy kinds (Edit / MultiEdit / Write) show a 6-line preview by default
 * and expand to the full diff on tap. `key` makes the expand state
 * survivable across recomposition / process death via [rememberSaveable].
 */
@Composable
fun ToolCallBlock(call: ToolCall, key: String) {
    when (call.name) {
        "Bash" -> BashRow(call)
        "Edit" -> EditAccordion(call, key)
        "MultiEdit" -> MultiEditAccordion(call, key)
        "Write" -> WriteAccordion(call, key)
        "Read", "Glob" -> SimpleRow(call.name, call.filePath ?: call.pattern ?: "?")
        "Grep" -> SimpleRow("Grep", call.pattern ?: "?")
        "WebFetch" -> SimpleRow("WebFetch", call.url?.let(::hostOnly) ?: "?")
        "WebSearch" -> SimpleRow("WebSearch", call.input.str("query") ?: "?")
        "Agent" -> SimpleRow("Agent", agentTarget(call))
        "ScheduleWakeup" -> SimpleRow("ScheduleWakeup", scheduleWakeupTarget(call))
        "TaskCreate" -> SimpleRow("TaskCreate", call.input.str("subject") ?: "?")
        "TaskUpdate" -> SimpleRow("TaskUpdate", taskUpdateTarget(call))
        "TaskList" -> SimpleRow("TaskList", "")
        "TaskGet", "TaskStop", "TaskOutput" -> SimpleRow(call.name, taskRefTarget(call))
        else -> SimpleRow(prettyName(call.name), genericTarget(call))
    }
}

/** TaskUpdate は status 遷移 (in_progress→completed 等) が一番見たい情報。 */
private fun taskUpdateTarget(call: ToolCall): String {
    val id = call.input.str("taskId") ?: "?"
    val status = call.input.str("status")
    return if (!status.isNullOrBlank()) "#$id → $status" else "#$id"
}

private fun taskRefTarget(call: ToolCall): String =
    "#${call.input.str("taskId") ?: "?"}"

/** Agent の "description" は agent 起動の意図 (3-5 words) でちょうどよく短い。 */
private fun agentTarget(call: ToolCall): String {
    val type = call.input.str("subagent_type") ?: "general-purpose"
    val desc = call.input.str("description")
    return if (!desc.isNullOrBlank()) "$type · $desc" else type
}

/** ScheduleWakeup は「次の起動まで」が短いほど活発な loop。reason も一緒に出す。 */
private fun scheduleWakeupTarget(call: ToolCall): String {
    val sec = call.input["delaySeconds"]
        ?.let { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }
    val reason = call.input.str("reason")
    val delay = sec?.let { "${it}s" } ?: "?"
    return if (!reason.isNullOrBlank()) "$delay · $reason" else delay
}

/**
 * 未知のツール向けフォールバック: 「自然に主役になりそうな key」を順に当たって
 * 最初に見つかった文字列値を target にする。MCP ツールは大半が name/query/text
 * 系の入力なので、これでカバーできることが多い。
 */
private val GENERIC_KEYS = listOf(
    "subject", "description", "query", "prompt", "reason",
    "name", "title", "body", "text", "command", "path",
    "skill", "libraryName", "libraryId",
)

private fun genericTarget(call: ToolCall): String {
    for (k in GENERIC_KEYS) {
        val v = call.input.str(k)
        if (!v.isNullOrBlank()) return v
    }
    return ""
}

/**
 * `mcp__plugin_context7_context7__query-docs` のような MCP ツール名は冗長なので
 * 最後の `__` 以降だけ出す → `query-docs`。非 MCP はそのまま。
 */
private fun prettyName(name: String): String =
    if (name.startsWith("mcp__")) name.substringAfterLast("__") else name

@Composable
private fun ToolHeader(
    name: String,
    target: String,
    expandable: Boolean = false,
    expanded: Boolean = false,
    onToggle: (() -> Unit)? = null,
    suffix: String? = null,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .let { if (expandable && onToggle != null) it.clickable(onClick = onToggle) else it }
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = "▸ $name",
            color = MaterialTheme.colorScheme.primary,
            style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace,
        )
        if (target.isNotBlank()) {
            Spacer(Modifier.width(6.dp))
            // 1 行固定 + 横スクロール。折り返すと header が縦に伸びてリスト視認性
            // が落ちる一方、truncate だと全文が見えない。Bash の CodeBlock と
            // 同じ horizontalScroll に揃えて「読みたければ横にスワイプ」にする。
            // 縦タップ (accordion 展開) と横スワイプは Compose のジェスチャ
            // 競合で両立する。
            Text(
                text = "· $target",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                softWrap = false,
                maxLines = 1,
                overflow = TextOverflow.Clip,
                modifier = Modifier
                    .weight(1f)
                    .horizontalScroll(rememberScrollState()),
            )
        }
        if (suffix != null) {
            Spacer(Modifier.width(8.dp))
            Text(
                text = suffix,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.labelSmall,
            )
        }
        if (expandable) {
            Spacer(Modifier.width(4.dp))
            Icon(
                imageVector = if (expanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                contentDescription = if (expanded) "折りたたむ" else "展開",
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.height(16.dp),
            )
        }
    }
}

@Composable
private fun SimpleRow(name: String, target: String) {
    ToolHeader(name = name, target = target)
}

@Composable
private fun BashRow(call: ToolCall) {
    val command = call.bashCommand ?: ""
    Column {
        ToolHeader(name = "Bash", target = "")
        if (command.isNotBlank()) {
            // SyntaxLanguage.SHELL の keyword 表は実コマンド (git/npm/curl 等) と
            // 噛み合わず誤強調が目立つので、Bash はあえてハイライトせず
            // プレーン monospace で出す。
            CodeBlock(code = command, language = null)
        }
    }
}

@Composable
private fun EditAccordion(call: ToolCall, key: String) {
    val edit = call.editOp ?: return SimpleRow("Edit", call.filePath ?: "?")
    val path = call.filePath ?: ""
    val full = remember(edit) { computeDiff(edit.oldString, edit.newString) }
    DiffAccordion(name = "Edit", target = path, all = full, language = languageFor(path), key = key)
}

@Composable
private fun MultiEditAccordion(call: ToolCall, key: String) {
    val ops = call.multiEditOps
    if (ops.isEmpty()) return SimpleRow("MultiEdit", call.filePath ?: "?")
    val path = call.filePath ?: ""
    val full = remember(ops) { ops.flatMap { computeDiff(it.oldString, it.newString) } }
    DiffAccordion(
        name = "MultiEdit",
        target = path,
        suffix = "${ops.size} edits",
        all = full,
        language = languageFor(path),
        key = key,
    )
}

@Composable
private fun WriteAccordion(call: ToolCall, key: String) {
    val content = call.writeContent ?: return SimpleRow("Write", call.filePath ?: "?")
    val path = call.filePath ?: ""
    val lines = remember(content) { content.split('\n') }
    if (lines.size <= 2) {
        // Tiny writes — full diff visualization is overkill, drop straight
        // into a code block.
        Column {
            ToolHeader(name = "Write", target = path)
            CodeBlock(code = content, language = languageFor(path))
        }
        return
    }
    val full = remember(content) { computeDiff("", content) }
    DiffAccordion(name = "Write", target = path, all = full, language = languageFor(path), key = key)
}

/**
 * Diff-bearing accordion: header is always visible, body is a 6-line
 * preview by default and the full diff (capped at [DIFF_MAX_LINES]) when
 * expanded. The header chevron toggles state, persisted via
 * [rememberSaveable] keyed on the unique `key` so process recreation
 * doesn't collapse what the user opened.
 */
@Composable
private fun DiffAccordion(
    name: String,
    target: String,
    all: List<DiffLine>,
    language: SyntaxLanguage?,
    key: String,
    suffix: String? = null,
) {
    var expanded by rememberSaveable(key = key) { mutableStateOf(false) }
    val rendered = if (expanded) all.take(DIFF_MAX_LINES) else all.take(PREVIEW_LINES)
    val truncated = expanded && all.size > DIFF_MAX_LINES
    val hidden = if (!expanded) (all.size - rendered.size).coerceAtLeast(0) else 0

    Column {
        ToolHeader(
            name = name,
            target = target,
            expandable = all.size > PREVIEW_LINES,
            expanded = expanded,
            onToggle = { expanded = !expanded },
            suffix = suffix
                ?: if (hidden > 0) "+${hidden} 行" else null,
        )
        if (rendered.isNotEmpty()) {
            DiffView(lines = rendered, language = language)
        }
        if (truncated) {
            Text(
                text = "… 一部省略 (${all.size - DIFF_MAX_LINES} 行)",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 4.dp, start = 8.dp),
            )
        }
    }
}

private fun languageFor(path: String): SyntaxLanguage? =
    extensionOf(path)?.let(::resolveLanguage)

private fun hostOnly(url: String): String =
    runCatching { URI(url).host ?: url }.getOrDefault(url)
