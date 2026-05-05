package com.tachibanayu24.ccremote.notification

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat
import com.tachibanayu24.ccremote.data.BackendClientHolder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class ApprovalActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_RESPOND) return
        val requestId = intent.getStringExtra(EXTRA_REQUEST_ID) ?: return
        val decision = intent.getStringExtra(EXTRA_DECISION) ?: return
        val addToAllowlist = intent.getBooleanExtra(EXTRA_ALLOWLIST, false)
        val notificationId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, -1)

        if (notificationId != -1) {
            NotificationManagerCompat.from(context).cancel(notificationId)
        }

        // BroadcastReceivers run briefly (default ANR window: 10s). goAsync()
        // gives us up to ~10s of background time; we wrap the network call in
        // a SupervisorJob so a single failed call doesn't crash anything else,
        // and finish() unconditionally so we don't trigger ANR.
        val pending = goAsync()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        scope.launch {
            try {
                BackendClientHolder.ensure(context.applicationContext)
                    ?.respondApproval(requestId, decision, addToAllowlist)
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val ACTION_RESPOND = "com.tachibanayu24.ccremote.action.RESPOND"
        const val EXTRA_REQUEST_ID = "request_id"
        const val EXTRA_DECISION = "decision"
        const val EXTRA_ALLOWLIST = "add_to_allowlist"
        const val EXTRA_NOTIFICATION_ID = "notification_id"

        const val DECISION_ALLOW = "allow"
        const val DECISION_DENY = "deny"
    }
}
