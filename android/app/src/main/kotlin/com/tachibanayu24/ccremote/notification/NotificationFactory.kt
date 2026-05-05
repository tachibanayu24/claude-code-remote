package com.tachibanayu24.ccremote.notification

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.tachibanayu24.ccremote.MainActivity
import com.tachibanayu24.ccremote.R
import java.util.concurrent.atomic.AtomicInteger

object NotificationFactory {
    const val CHANNEL_APPROVAL = "approval"
    const val CHANNEL_INFO = "info"

    private const val PENDING_FLAGS =
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

    // Monotonic counter for info notifications. Avoids the
    // `System.currentTimeMillis().hashCode()` collision risk inside the same
    // millisecond. Starts above the 16-bit space to keep approval IDs
    // (`requestId.hashCode()`) distinct in practice.
    private val infoNotificationIdSeq = AtomicInteger(1_000_000)

    fun showApproval(context: Context, data: Map<String, String>) {
        val payload = ApprovalPayload.fromFcm(data) ?: return
        val notificationId = payload.notificationId

        val approve = actionPending(
            context, payload, ApprovalActionReceiver.DECISION_ALLOW,
            addToAllowlist = false, requestCode = notificationId * 4,
        )
        val approveAlways = actionPending(
            context, payload, ApprovalActionReceiver.DECISION_ALLOW,
            addToAllowlist = true, requestCode = notificationId * 4 + 1,
        )
        val deny = actionPending(
            context, payload, ApprovalActionReceiver.DECISION_DENY,
            addToAllowlist = false, requestCode = notificationId * 4 + 2,
        )
        val tap = openSessionPending(context, payload.cwd, requestCode = notificationId * 4 + 3)

        val notification = NotificationCompat.Builder(context, CHANNEL_APPROVAL)
            .setSmallIcon(R.drawable.ic_clawd)
            .setContentTitle(payload.title)
            .setContentText(payload.detail.ifBlank { payload.toolName })
            .setStyle(NotificationCompat.BigTextStyle().bigText(payload.detail.ifBlank { payload.toolName }))
            .setSubText(payload.subText)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            // EVENT signals "user-actionable thing happening now" (recommended
            // by Material guidelines for actionable prompts) — closer fit
            // than REMINDER, and works with DND override channels.
            .setCategory(NotificationCompat.CATEGORY_EVENT)
            .setAutoCancel(true)
            .setContentIntent(tap)
            .addAction(R.drawable.ic_check, "Allow", approve)
            .addAction(R.drawable.ic_check, "Always", approveAlways)
            .addAction(R.drawable.ic_close, "Deny", deny)
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
        val project = data["project"].orEmpty()
        val sessionLabel = data["session_label"].orEmpty()
        val cwd = data["cwd"].orEmpty()
        val subText = if (sessionLabel.isNotBlank() && project.isNotBlank()) project else null
        val notificationId = infoNotificationIdSeq.incrementAndGet()

        val tap = openSessionPending(context, cwd, requestCode = notificationId)

        val builder = NotificationCompat.Builder(context, CHANNEL_INFO)
            .setSmallIcon(R.drawable.ic_clawd)
            .setContentTitle(title)
            .setSubText(subText)
            .setPriority(if (kind == "completed") NotificationCompat.PRIORITY_DEFAULT else NotificationCompat.PRIORITY_LOW)
            .setAutoCancel(true)
            .setContentIntent(tap)
        if (body.isNotBlank()) {
            builder.setContentText(body).setStyle(NotificationCompat.BigTextStyle().bigText(body))
        }

        try {
            NotificationManagerCompat.from(context).notify(notificationId, builder.build())
        } catch (_: SecurityException) {
            // ignore
        }
    }

    private fun actionPending(
        context: Context,
        payload: ApprovalPayload,
        decision: String,
        addToAllowlist: Boolean,
        requestCode: Int,
    ): PendingIntent {
        val intent = Intent(context, ApprovalActionReceiver::class.java).apply {
            action = ApprovalActionReceiver.ACTION_RESPOND
            putExtra(ApprovalActionReceiver.EXTRA_REQUEST_ID, payload.requestId)
            putExtra(ApprovalActionReceiver.EXTRA_DECISION, decision)
            putExtra(ApprovalActionReceiver.EXTRA_ALLOWLIST, addToAllowlist)
            putExtra(ApprovalActionReceiver.EXTRA_NOTIFICATION_ID, payload.notificationId)
        }
        return PendingIntent.getBroadcast(context, requestCode, intent, PENDING_FLAGS)
    }

    /**
     * Tap intent for both approval and completion notifications: route into
     * the session detail screen for `cwd`. If cwd is missing (older payload
     * or test push), fall back to the launcher behaviour.
     */
    private fun openSessionPending(context: Context, cwd: String, requestCode: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            if (cwd.isNotBlank()) {
                action = MainActivity.ACTION_OPEN_SESSION
                putExtra(MainActivity.EXTRA_CWD, cwd)
            }
        }
        return PendingIntent.getActivity(context, requestCode, intent, PENDING_FLAGS)
    }
}
