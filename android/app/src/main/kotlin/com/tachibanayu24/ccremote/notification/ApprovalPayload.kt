package com.tachibanayu24.ccremote.notification

import android.content.Intent
import android.os.Bundle
import org.json.JSONObject

/**
 * All approval-request fields the FCM payload carries, extracted once and
 * reused by the notification builder, the tap-into-app dialog, and the action
 * receiver.
 */
data class ApprovalPayload(
    val requestId: String,
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

    fun writeToIntent(intent: Intent) {
        intent.putExtra(EXTRA_REQUEST_ID, requestId)
        intent.putExtra(EXTRA_PROJECT, project)
        intent.putExtra(EXTRA_SESSION_LABEL, sessionLabel)
        intent.putExtra(EXTRA_TOOL_NAME, toolName)
        intent.putExtra(EXTRA_DESCRIPTION, description)
        intent.putExtra(EXTRA_INPUT_PREVIEW, inputPreview)
    }

    companion object {
        const val EXTRA_REQUEST_ID = "request_id"
        const val EXTRA_PROJECT = "project"
        const val EXTRA_SESSION_LABEL = "session_label"
        const val EXTRA_TOOL_NAME = "tool_name"
        const val EXTRA_DESCRIPTION = "description"
        const val EXTRA_INPUT_PREVIEW = "input_preview"

        fun fromFcm(data: Map<String, String>): ApprovalPayload? {
            val requestId = data["request_id"] ?: return null
            return ApprovalPayload(
                requestId = requestId,
                project = data["project"].orEmpty(),
                sessionLabel = data["session_label"].orEmpty(),
                toolName = data["tool_name"].orEmpty(),
                description = data["description"].orEmpty(),
                inputPreview = data["input_preview"].orEmpty(),
            )
        }

        fun fromBundle(bundle: Bundle?): ApprovalPayload? {
            val requestId = bundle?.getString(EXTRA_REQUEST_ID) ?: return null
            return ApprovalPayload(
                requestId = requestId,
                project = bundle.getString(EXTRA_PROJECT).orEmpty(),
                sessionLabel = bundle.getString(EXTRA_SESSION_LABEL).orEmpty(),
                toolName = bundle.getString(EXTRA_TOOL_NAME).orEmpty(),
                description = bundle.getString(EXTRA_DESCRIPTION).orEmpty(),
                inputPreview = bundle.getString(EXTRA_INPUT_PREVIEW).orEmpty(),
            )
        }
    }
}
