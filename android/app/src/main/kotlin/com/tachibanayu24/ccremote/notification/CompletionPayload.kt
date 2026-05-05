package com.tachibanayu24.ccremote.notification

import android.content.Intent
import android.os.Bundle

/**
 * Carries the data needed to render the "Claude finished" popup: title head,
 * elapsed time, and the full assistant message. Built from the FCM payload by
 * NotificationFactory and re-hydrated by MainActivity from the tap intent.
 */
data class CompletionPayload(
    val notificationId: Int,
    val titleHead: String,
    val project: String,
    val sessionLabel: String,
    val elapsedMs: Long,
    val fullMessage: String,
) {
    fun writeToIntent(intent: Intent) {
        intent.putExtra(EXTRA_NOTIFICATION_ID, notificationId)
        intent.putExtra(EXTRA_TITLE_HEAD, titleHead)
        intent.putExtra(EXTRA_PROJECT, project)
        intent.putExtra(EXTRA_SESSION_LABEL, sessionLabel)
        intent.putExtra(EXTRA_ELAPSED_MS, elapsedMs)
        intent.putExtra(EXTRA_FULL_MESSAGE, fullMessage)
    }

    companion object {
        const val EXTRA_NOTIFICATION_ID = "completion_notification_id"
        const val EXTRA_TITLE_HEAD = "completion_title_head"
        const val EXTRA_PROJECT = "completion_project"
        const val EXTRA_SESSION_LABEL = "completion_session_label"
        const val EXTRA_ELAPSED_MS = "completion_elapsed_ms"
        const val EXTRA_FULL_MESSAGE = "completion_full_message"

        fun fromBundle(bundle: Bundle?): CompletionPayload? {
            val message = bundle?.getString(EXTRA_FULL_MESSAGE) ?: return null
            return CompletionPayload(
                notificationId = bundle.getInt(EXTRA_NOTIFICATION_ID, 0),
                titleHead = bundle.getString(EXTRA_TITLE_HEAD).orEmpty(),
                project = bundle.getString(EXTRA_PROJECT).orEmpty(),
                sessionLabel = bundle.getString(EXTRA_SESSION_LABEL).orEmpty(),
                elapsedMs = bundle.getLong(EXTRA_ELAPSED_MS, 0L),
                fullMessage = message,
            )
        }
    }
}

fun formatElapsed(ms: Long): String {
    if (ms <= 0) return ""
    val s = ms / 1000
    if (s < 60) return "${s}s"
    val m = s / 60
    val sec = s % 60
    if (m < 60) return if (sec > 0) "${m}m ${sec}s" else "${m}m"
    val h = m / 60
    val min = m % 60
    return if (min > 0) "${h}h ${min}m" else "${h}h"
}
