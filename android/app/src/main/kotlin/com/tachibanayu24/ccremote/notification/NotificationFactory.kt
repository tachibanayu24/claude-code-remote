package com.tachibanayu24.ccremote.notification

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.tachibanayu24.ccremote.MainActivity
import com.tachibanayu24.ccremote.R
import org.json.JSONObject
import org.json.JSONException

object NotificationFactory {
    const val CHANNEL_APPROVAL = "approval"
    const val CHANNEL_INFO = "info"

    fun showApproval(context: Context, data: Map<String, String>) {
        val requestId = data["request_id"] ?: return
        val project = data["project"] ?: "?"
        val sessionLabel = data["session_label"].orEmpty()
        val toolName = data["tool_name"] ?: "?"
        val description = data["description"].orEmpty()
        val inputPreview = data["input_preview"].orEmpty()
        val detail = formatToolDetail(toolName, inputPreview)
        val descClean = description.takeIf {
            it.isNotBlank() && !(it.startsWith("{") && it.endsWith("}")) && it != detail
        }
        val titleHead = sessionLabel.ifBlank { project }
        val actionLabel = descClean ?: toolName
        val title = "⚠️ $titleHead · $actionLabel"
        val subText = if (sessionLabel.isNotBlank()) project else null

        val notificationId = requestId.hashCode()

        val approveIntent = Intent(context, ApprovalActionReceiver::class.java).apply {
            action = ApprovalActionReceiver.ACTION_RESPOND
            putExtra(ApprovalActionReceiver.EXTRA_REQUEST_ID, requestId)
            putExtra(ApprovalActionReceiver.EXTRA_DECISION, "allow")
            putExtra(ApprovalActionReceiver.EXTRA_NOTIFICATION_ID, notificationId)
        }
        val denyIntent = Intent(context, ApprovalActionReceiver::class.java).apply {
            action = ApprovalActionReceiver.ACTION_RESPOND
            putExtra(ApprovalActionReceiver.EXTRA_REQUEST_ID, requestId)
            putExtra(ApprovalActionReceiver.EXTRA_DECISION, "deny")
            putExtra(ApprovalActionReceiver.EXTRA_NOTIFICATION_ID, notificationId)
        }

        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val approvePending = PendingIntent.getBroadcast(context, notificationId * 2, approveIntent, flags)
        val denyPending = PendingIntent.getBroadcast(context, notificationId * 2 + 1, denyIntent, flags)
        val tapPending = PendingIntent.getActivity(
            context,
            notificationId * 2 + 2,
            Intent(context, MainActivity::class.java),
            flags,
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_APPROVAL)
            .setSmallIcon(R.drawable.ic_clawd)
            .setContentTitle(title)
            .setContentText(detail.ifBlank { toolName })
            .setStyle(NotificationCompat.BigTextStyle().bigText(detail.ifBlank { toolName }))
            .setSubText(subText)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setContentIntent(tapPending)
            .addAction(R.drawable.ic_check, "Allow", approvePending)
            .addAction(R.drawable.ic_close, "Deny", denyPending)
            .build()

        try {
            NotificationManagerCompat.from(context).notify(notificationId, notification)
        } catch (_: SecurityException) {
            // POST_NOTIFICATIONS not granted on Android 13+
        }
    }

    private fun formatToolDetail(toolName: String, inputPreview: String): String {
        val parsed = runCatching { JSONObject(inputPreview) }.getOrNull()
        val keyArg = when (toolName) {
            "Bash" -> parsed?.optString("command")?.takeIf { it.isNotBlank() }
            "Edit", "Write", "MultiEdit" -> parsed?.optString("file_path")?.takeIf { it.isNotBlank() }
            "Read", "Glob" -> parsed?.optString("file_path")?.takeIf { it.isNotBlank() }
                ?: parsed?.optString("pattern")?.takeIf { it.isNotBlank() }
            "Grep" -> parsed?.optString("pattern")?.takeIf { it.isNotBlank() }
            else -> null
        }
        return keyArg ?: inputPreview.ifBlank { toolName }
    }

    fun showInfo(context: Context, data: Map<String, String>) {
        val title = data["title"] ?: "claude-code-remote"
        val body = data["body"].orEmpty()
        val kind = data["kind"] ?: "info"
        val project = data["project"].orEmpty()
        val sessionLabel = data["session_label"].orEmpty()
        val subText = if (sessionLabel.isNotBlank() && project.isNotBlank()) project else null
        val notificationId = ("info-" + System.currentTimeMillis()).hashCode()

        val tapPending = PendingIntent.getActivity(
            context,
            notificationId,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val builder = NotificationCompat.Builder(context, CHANNEL_INFO)
            .setSmallIcon(R.drawable.ic_clawd)
            .setContentTitle(title)
            .setSubText(subText)
            .setPriority(if (kind == "completed") NotificationCompat.PRIORITY_DEFAULT else NotificationCompat.PRIORITY_LOW)
            .setAutoCancel(true)
            .setContentIntent(tapPending)
        if (body.isNotBlank()) {
            builder.setContentText(body).setStyle(NotificationCompat.BigTextStyle().bigText(body))
        }
        val notification = builder.build()

        try {
            NotificationManagerCompat.from(context).notify(notificationId, notification)
        } catch (_: SecurityException) {
            // ignore
        }
    }
}
