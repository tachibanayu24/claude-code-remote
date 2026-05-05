package com.tachibanayu24.ccremote.notification

import org.json.JSONObject

/**
 * Approval-request fields the FCM payload carries. Used to render the
 * notification body and (via the action receiver) to send the verdict back
 * to the backend. Tap-into-app no longer rehydrates this payload — the
 * detail screen for the session's cwd is opened instead.
 */
data class ApprovalPayload(
    val requestId: String,
    val cwd: String,
    val project: String,
    val sessionLabel: String,
    val toolName: String,
    val description: String,
    val inputPreview: String,
) {
    val notificationId: Int get() = requestId.hashCode()

    /** Body text shown in the notification: the most actionable bit of the input. */
    val detail: String
        get() {
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
            return keyArg ?: description.takeIf { it.isNotBlank() } ?: inputPreview.ifBlank { toolName }
        }

    /**
     * Channels truncates `input_preview` at 200 chars, which often breaks JSON
     * mid-string. Fall back to a regex that extracts the value of `"<key>":"..."`
     * whether or not the JSON closed cleanly. Returns the extracted value if
     * non-blank.
     */
    private fun extractKey(text: String, key: String): String? {
        val m = Regex("\"$key\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)").find(text) ?: return null
        val raw = m.groupValues[1]
        // Unescape JSON string escapes that we can match (subset is sufficient).
        val unescaped = raw
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
            .replace("\\n", "\n")
            .replace("\\t", "\t")
        return unescaped.takeIf { it.isNotBlank() }
    }

    /** Action label for the title — Claude's description if usable, else tool name. */
    val actionLabel: String
        get() {
            val descClean = description.takeIf {
                it.isNotBlank() && !(it.startsWith("{") && it.endsWith("}")) && it != detail
            }
            return descClean ?: toolName
        }

    val titleHead: String get() = sessionLabel.ifBlank { project }

    val title: String get() = "⚠️ $titleHead · $actionLabel"

    val subText: String? get() = if (sessionLabel.isNotBlank()) project else null

    companion object {
        fun fromFcm(data: Map<String, String>): ApprovalPayload? {
            val requestId = data["request_id"] ?: return null
            return ApprovalPayload(
                requestId = requestId,
                cwd = data["cwd"].orEmpty(),
                project = data["project"].orEmpty(),
                sessionLabel = data["session_label"].orEmpty(),
                toolName = data["tool_name"].orEmpty(),
                description = data["description"].orEmpty(),
                inputPreview = data["input_preview"].orEmpty(),
            )
        }
    }
}
