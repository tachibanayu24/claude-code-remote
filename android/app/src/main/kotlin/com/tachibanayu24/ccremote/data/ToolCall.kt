package com.tachibanayu24.ccremote.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * One `tool_use` block extracted from CC's jsonl during a turn. `input` is
 * passed through verbatim so the UI can branch on `name` and pull the tool's
 * key arguments (Bash → command, Edit → file_path/old_string/new_string,
 * MultiEdit → edits[], Read → file_path, etc.) without the backend having to
 * know about every CC tool shape.
 */
@Serializable
data class ToolCall(
    val name: String,
    val input: JsonObject = JsonObject(emptyMap()),
)

/**
 * Typed accessors. CC's tool input shapes are stable enough that hardcoding
 * them here is cheaper than a generic JSON walker — the UI knows exactly what
 * fields each kind has, and unknown tools fall through to a generic "name +
 * raw input preview" rendering.
 *
 * `str` is `internal` so [ToolCallBlock] can reuse it for tools whose only
 * meaningful input is a string (Task*, WebSearch, Agent, ...) without
 * needing a typed accessor per tool.
 */
internal fun JsonObject.str(key: String): String? =
    this[key]?.let { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }

data class EditOp(val oldString: String, val newString: String)

val ToolCall.bashCommand: String? get() = input.str("command")
val ToolCall.filePath: String? get() = input.str("file_path")
val ToolCall.pattern: String? get() = input.str("pattern")
val ToolCall.url: String? get() = input.str("url")

val ToolCall.editOp: EditOp?
    get() {
        val old = input.str("old_string") ?: return null
        val new = input.str("new_string") ?: return null
        return EditOp(old, new)
    }

val ToolCall.writeContent: String? get() = input.str("content")

val ToolCall.multiEditOps: List<EditOp>
    get() = input["edits"]
        ?.let { runCatching { it.jsonArray }.getOrNull() }
        ?.mapNotNull { el ->
            val obj = runCatching { el.jsonObject }.getOrNull() ?: return@mapNotNull null
            val old = obj.str("old_string") ?: return@mapNotNull null
            val new = obj.str("new_string") ?: return@mapNotNull null
            EditOp(old, new)
        }
        .orEmpty()
