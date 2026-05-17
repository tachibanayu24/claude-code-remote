package com.tachibanayu24.ccremote.ui

import android.app.Activity
import android.view.WindowManager
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.tachibanayu24.ccremote.data.Config
import com.tachibanayu24.ccremote.data.NotificationSettings

@Composable
fun SettingsScreen(
    config: Config,
    fcmToken: String?,
    notificationSettings: NotificationSettings?,
    isSavingSettings: Boolean,
    settingsError: String?,
    onBack: () -> Unit,
    onSaveNotificationSettings: (askDelaySec: Long, stopThresholdSec: Long, questionAskDelaySec: Long) -> Unit,
    onResetConfig: () -> Unit,
    onTestNotification: () -> Unit,
) {
    // FLAG_SECURE blocks screenshots and recent-task previews from capturing
    // the secret token while this screen is on top. Cleared on dispose so
    // the rest of the app remains shareable.
    val context = LocalContext.current
    DisposableEffect(Unit) {
        val window = (context as? Activity)?.window
        window?.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        onDispose { window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .safeDrawingPadding(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = "戻る",
                )
            }
            Text(
                text = "Settings",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.primary,
            )
        }
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            NotificationTimingSection(
                settings = notificationSettings,
                isSaving = isSavingSettings,
                error = settingsError,
                onSave = onSaveNotificationSettings,
            )

            Spacer(Modifier.height(8.dp))

            Button(
                onClick = onTestNotification,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("テスト通知を送る") }

            DebugInfoSection(config = config, fcmToken = fcmToken)

            OutlinedButton(
                onClick = onResetConfig,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("設定をリセット") }
        }
    }
}

@Composable
private fun NotificationTimingSection(
    settings: NotificationSettings?,
    isSaving: Boolean,
    error: String?,
    onSave: (askDelaySec: Long, stopThresholdSec: Long, questionAskDelaySec: Long) -> Unit,
) {
    var askDelay by remember { mutableStateOf("") }
    var stopThreshold by remember { mutableStateOf("") }
    var questionAskDelay by remember { mutableStateOf("") }
    LaunchedEffect(settings?.ask_delay_ms, settings?.stop_threshold_ms, settings?.question_ask_delay_ms) {
        if (settings != null) {
            askDelay = (settings.ask_delay_ms / 1000).toString()
            stopThreshold = (settings.stop_threshold_ms / 1000).toString()
            questionAskDelay = (settings.question_ask_delay_ms / 1000).toString()
        }
    }

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(8.dp),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = "通知タイミング",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.primary,
            )

            SecondsInputRow(
                label = "Ask 通知の遅延 (承認)",
                hint = "PC で即答した場合は通知しない。0 で即時。",
                value = askDelay,
                onChange = { askDelay = it },
            )

            SecondsInputRow(
                label = "Ask 通知の遅延 (質問)",
                hint = "AskUserQuestion 用。 PC で選択肢を読む時間を見越して長め推奨 (default 30 秒)。",
                value = questionAskDelay,
                onChange = { questionAskDelay = it },
            )

            SecondsInputRow(
                label = "完了通知の閾値",
                hint = "この時間より短いターンは通知しない。0 で常に通知。",
                value = stopThreshold,
                onChange = { stopThreshold = it },
            )

            if (error != null) {
                Text(
                    text = error,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            Button(
                onClick = {
                    val ask = askDelay.toLongOrNull() ?: return@Button
                    val stop = stopThreshold.toLongOrNull() ?: return@Button
                    val q = questionAskDelay.toLongOrNull() ?: return@Button
                    onSave(ask, stop, q)
                },
                enabled = !isSaving && settings != null,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (isSaving) "保存中…" else "保存") }
        }
    }
}

@Composable
private fun SecondsInputRow(
    label: String,
    hint: String,
    value: String,
    onChange: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = value,
                onValueChange = { input -> onChange(input.filter { it.isDigit() }) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.width(120.dp),
            )
            Spacer(Modifier.width(8.dp))
            Text(text = "秒", style = MaterialTheme.typography.bodyMedium)
        }
        Text(
            text = hint,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun DebugInfoSection(config: Config, fcmToken: String?) {
    var expanded by remember { mutableStateOf(false) }
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(8.dp),
    ) {
        Column {
            TextButton(
                onClick = { expanded = !expanded },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    text = "詳細（Debug 情報）",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.weight(1f),
                )
                Icon(
                    imageVector = if (expanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                    contentDescription = if (expanded) "閉じる" else "開く",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (expanded) {
                Column(
                    modifier = Modifier.padding(start = 16.dp, end = 8.dp, bottom = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    StatusRow(label = "BACKEND", value = config.backendUrl, revealable = true)
                    StatusRow(label = "DEVICE_ID", value = config.deviceId, revealable = true)
                    StatusRow(
                        label = "FCM_TOKEN",
                        value = fcmToken ?: "(未取得)",
                        revealable = fcmToken != null,
                    )
                }
            }
        }
    }
}

@Composable
private fun StatusRow(
    label: String,
    value: String,
    revealable: Boolean = false,
) {
    var revealed by remember { mutableStateOf(false) }
    val display = if (!revealable || revealed) value else "•".repeat(32)
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.primary,
            )
            if (revealable) {
                Spacer(Modifier.weight(1f))
                IconButton(onClick = { revealed = !revealed }) {
                    Icon(
                        imageVector = if (revealed) Icons.Filled.VisibilityOff else Icons.Filled.Visibility,
                        contentDescription = if (revealed) "値を隠す" else "値を表示",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        Text(
            text = display,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurface,
        )
    }
}
