package com.tachibanayu24.ccremote.notification

import com.tachibanayu24.ccremote.data.ApprovalCommandFormatter

/**
 * Approval-request fields the FCM payload carries. Used to render the
 * notification body and (via the action receiver) to send the verdict back
 * to the backend. Tap-into-app no longer rehydrates this payload — the
 * detail screen for the session is opened instead.
 */
data class ApprovalPayload(
    val requestId: String,
    val sessionId: String,
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
        get() = ApprovalCommandFormatter.extract(
            toolName = toolName,
            inputPreview = inputPreview,
            fallback = description.takeIf { it.isNotBlank() } ?: toolName,
        )

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
                sessionId = data["session_id"].orEmpty(),
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
