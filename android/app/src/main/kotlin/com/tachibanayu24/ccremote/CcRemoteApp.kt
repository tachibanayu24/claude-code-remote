package com.tachibanayu24.ccremote

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import com.tachibanayu24.ccremote.notification.NotificationFactory

class CcRemoteApp : Application() {
    override fun onCreate() {
        super.onCreate()
        createNotificationChannels()
    }

    private fun createNotificationChannels() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(
                NotificationFactory.CHANNEL_APPROVAL,
                "承認待ち",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Claude Code の権限承認待ちを通知します"
            }
        )
        nm.createNotificationChannel(
            NotificationChannel(
                NotificationFactory.CHANNEL_INFO,
                "情報",
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "応答完了・待機などの情報通知"
            }
        )
    }
}
