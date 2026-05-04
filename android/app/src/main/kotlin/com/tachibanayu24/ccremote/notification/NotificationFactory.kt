package com.tachibanayu24.ccremote.notification

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.tachibanayu24.ccremote.MainActivity
import com.tachibanayu24.ccremote.R

object NotificationFactory {
    const val CHANNEL_APPROVAL = "approval"
    const val CHANNEL_INFO = "info"

    fun showApproval(context: Context, data: Map<String, String>) {
        val requestId = data["request_id"] ?: return
        val project = data["project"] ?: "?"
        val toolName = data["tool_name"] ?: "?"
        val toolSummary = data["tool_summary"].orEmpty()

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
            .setContentTitle("⚠️ $project · 承認待ち")
            .setContentText("$toolName: $toolSummary")
            .setStyle(NotificationCompat.BigTextStyle().bigText("$toolName: $toolSummary"))
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

    fun showInfo(context: Context, data: Map<String, String>) {
        val title = data["title"] ?: "claude-code-remote"
        val body = data["body"].orEmpty()
        val kind = data["kind"] ?: "info"
        val notificationId = ("info-" + System.currentTimeMillis()).hashCode()

        val tapPending = PendingIntent.getActivity(
            context,
            notificationId,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_INFO)
            .setSmallIcon(R.drawable.ic_clawd)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(if (kind == "completed") NotificationCompat.PRIORITY_DEFAULT else NotificationCompat.PRIORITY_LOW)
            .setAutoCancel(true)
            .setContentIntent(tapPending)
            .build()

        try {
            NotificationManagerCompat.from(context).notify(notificationId, notification)
        } catch (_: SecurityException) {
            // ignore
        }
    }
}
