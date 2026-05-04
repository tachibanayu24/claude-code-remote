package com.tachibanayu24.ccremote.notification

import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.tachibanayu24.ccremote.data.BackendClient
import com.tachibanayu24.ccremote.data.ConfigStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import android.os.Build

class CcRemoteMessagingService : FirebaseMessagingService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        scope.launch {
            val config = ConfigStore.current(applicationContext) ?: return@launch
            runCatching {
                BackendClient(config).also {
                    it.registerDevice(token, Build.MODEL)
                    it.close()
                }
            }
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        val data = message.data
        when (data["type"]) {
            "approval_request" -> NotificationFactory.showApproval(applicationContext, data)
            "approval_resolved" -> {
                val requestId = data["request_id"] ?: return
                NotificationManagerCompat.from(applicationContext).cancel(requestId.hashCode())
            }
            "info" -> NotificationFactory.showInfo(applicationContext, data)
        }
    }
}
