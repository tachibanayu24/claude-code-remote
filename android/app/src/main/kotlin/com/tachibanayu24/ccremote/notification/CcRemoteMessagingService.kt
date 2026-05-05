package com.tachibanayu24.ccremote.notification

import android.os.Build
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.tachibanayu24.ccremote.data.BackendClientHolder
import com.tachibanayu24.ccremote.widget.WidgetSyncWorker
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class CcRemoteMessagingService : FirebaseMessagingService() {
    // Tied to the service lifetime via onDestroy; see structured concurrency
    // guidance in Android docs. Without cancel(), launches queued by the last
    // onNewToken can leak past service teardown.
    private val job = SupervisorJob()
    private val scope = CoroutineScope(job + Dispatchers.IO)

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        scope.launch {
            BackendClientHolder.ensure(applicationContext)?.registerDevice(token, Build.MODEL)
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        val data = message.data
        when (data["type"]) {
            "approval_request" -> NotificationFactory.showApproval(applicationContext, data)
            "approval_resolved" -> {
                data["request_id"]?.let { requestId ->
                    NotificationManagerCompat.from(applicationContext).cancel(requestId.hashCode())
                }
            }
            "info" -> NotificationFactory.showInfo(applicationContext, data)
        }
        // Every recognized event changes session state visible to the widget
        // (new pending approval, resolved approval, completion). Trigger a
        // one-shot sync so the home screen catches up without waiting for
        // the 15-minute periodic worker.
        WidgetSyncWorker.enqueueOnce(applicationContext)
    }
}
