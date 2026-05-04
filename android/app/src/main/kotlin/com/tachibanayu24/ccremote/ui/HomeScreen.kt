package com.tachibanayu24.ccremote.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.tachibanayu24.ccremote.data.Config

@Composable
fun HomeScreen(
    config: Config,
    fcmToken: String?,
    onResetConfig: () -> Unit,
    onTestNotification: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 32.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        ClawdBanner()

        StatusCard(
            label = "BACKEND",
            value = config.backendUrl,
        )
        StatusCard(
            label = "DEVICE_ID",
            value = config.deviceId,
        )
        StatusCard(
            label = "FCM_TOKEN",
            value = fcmToken?.let { it.take(48) + "…" } ?: "(未取得)",
        )

        Spacer(Modifier.height(8.dp))

        Button(
            onClick = onTestNotification,
            modifier = Modifier.fillMaxWidth(),
        ) { Text("テスト通知を送る") }

        OutlinedButton(
            onClick = onResetConfig,
            modifier = Modifier.fillMaxWidth(),
        ) { Text("設定をリセット") }

        Spacer(Modifier.height(16.dp))

        Text(
            text = "通知が届くと、ロック画面でも Approve / Deny ボタンから直接応答できます。",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun ClawdBanner() {
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        ClawdLogo(pixelSize = 8.dp)
        Spacer(Modifier.height(12.dp))
        Text(
            text = "claude-code-remote",
            style = MaterialTheme.typography.titleLarge,
            color = MaterialTheme.colorScheme.onBackground,
        )
    }
}

@Composable
private fun StatusCard(label: String, value: String) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(8.dp),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.primary,
            )
            Text(
                text = value,
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}
