package com.tachibanayu24.ccremote.data

import org.json.JSONObject

/**
 * Pulls the actually-executed command / target out of an `input_preview`
 * JSON blob so the UI knows what the user is approving. Channels truncates
 * the preview at 200 chars, so we fall back to a regex extractor that
 * handles partially-broken JSON `"<key>":"..."` pairs.
 *
 * Returns the tool's key argument when extractable (Bash → command,
 * Edit → file_path, Grep → pattern, etc.), else the raw input_preview, and
 * finally the tool name as last-resort label.
 */
object ApprovalCommandFormatter {
    fun extract(toolName: String, inputPreview: String, fallback: String = toolName): String {
        val parsed = runCatching { JSONObject(inputPreview) }.getOrNull()
        val keyArg = when (toolName) {
            "Bash" -> parsed?.optString("command")?.takeIf { it.isNotBlank() }
                ?: extractKey(inputPreview, "command")
            "Edit", "Write", "MultiEdit" -> parsed?.optString("file_path")?.takeIf { it.isNotBlank() }
                ?: extractKey(inputPreview, "file_path")
            "Read", "Glob" -> parsed?.optString("file_path")?.takeIf { it.isNotBlank() }
                ?: parsed?.optString("pattern")?.takeIf { it.isNotBlank() }
                ?: extractKey(inputPreview, "file_path")
                ?: extractKey(inputPreview, "pattern")
            "Grep" -> parsed?.optString("pattern")?.takeIf { it.isNotBlank() }
                ?: extractKey(inputPreview, "pattern")
            else -> null
        }
        return keyArg ?: inputPreview.ifBlank { fallback }
    }

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
}
