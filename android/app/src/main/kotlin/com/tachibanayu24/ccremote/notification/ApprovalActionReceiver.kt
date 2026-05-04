package com.tachibanayu24.ccremote.notification

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat
import com.tachibanayu24.ccremote.data.BackendClient
import com.tachibanayu24.ccremote.data.ConfigStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class ApprovalActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_RESPOND) return
        val requestId = intent.getStringExtra(EXTRA_REQUEST_ID) ?: return
        val decision = intent.getStringExtra(EXTRA_DECISION) ?: return
        val notificationId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, -1)

        if (notificationId != -1) {
            NotificationManagerCompat.from(context).cancel(notificationId)
        }

        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val config = ConfigStore.current(context.applicationContext) ?: return@launch
                val client = BackendClient(config)
                runCatching { client.respondApproval(requestId, decision) }
                client.close()
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val ACTION_RESPOND = "com.tachibanayu24.ccremote.action.RESPOND"
        const val EXTRA_REQUEST_ID = "request_id"
        const val EXTRA_DECISION = "decision"
        const val EXTRA_NOTIFICATION_ID = "notification_id"
    }
}
