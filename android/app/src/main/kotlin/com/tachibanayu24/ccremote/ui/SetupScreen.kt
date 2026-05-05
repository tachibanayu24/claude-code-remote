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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp

private const val MIN_SECRET_LENGTH = 16

@Composable
fun SetupScreen(
    isWorking: Boolean,
    error: String?,
    onSave: (url: String, secret: String) -> Unit,
) {
    var url by remember { mutableStateOf("") }
    var secret by remember { mutableStateOf("") }

    val urlError by remember {
        derivedStateOf {
            val trimmed = url.trim()
            when {
                trimmed.isBlank() -> null
                !trimmed.startsWith("http://") && !trimmed.startsWith("https://") ->
                    "http:// または https:// で始めてください"
                else -> null
            }
        }
    }
    val secretError by remember {
        derivedStateOf {
            val trimmed = secret.trim()
            when {
                trimmed.isBlank() -> null
                trimmed.length < MIN_SECRET_LENGTH -> "${MIN_SECRET_LENGTH} 文字以上にしてください"
                else -> null
            }
        }
    }
    val canSubmit = url.trim().isNotEmpty() &&
        secret.trim().isNotEmpty() &&
        urlError == null &&
        secretError == null

    Column(
        modifier = Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 32.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        ClawdHeader()

        Text(
            text = "claude-code-remote",
            style = MaterialTheme.typography.displayMedium,
            color = MaterialTheme.colorScheme.primary,
        )
        Text(
            text = "初回セットアップ。Workers backend の URL と shared secret を入力。",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(Modifier.height(8.dp))

        OutlinedTextField(
            value = url,
            onValueChange = { url = it },
            label = { Text("Backend URL") },
            placeholder = { Text("https://claude-code-remote.<sub>.workers.dev") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth(),
            textStyle = MaterialTheme.typography.bodyMedium,
            isError = urlError != null,
            supportingText = urlError?.let { { Text(it) } },
        )

        OutlinedTextField(
            value = secret,
            onValueChange = { secret = it },
            label = { Text("Shared Secret") },
            placeholder = { Text("32 bytes hex") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(),
            textStyle = MaterialTheme.typography.bodyMedium,
            isError = secretError != null,
            supportingText = secretError?.let { { Text(it) } },
        )

        if (error != null) {
            Text(
                text = error,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
            )
        }

        Button(
            onClick = { onSave(url, secret) },
            enabled = !isWorking && canSubmit,
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (isWorking) {
                CircularProgressIndicator(
                    color = MaterialTheme.colorScheme.onPrimary,
                    strokeWidth = 2.dp,
                    modifier = Modifier.height(20.dp),
                )
            } else {
                Text("接続して登録")
            }
        }
    }
}

@Composable
private fun ClawdHeader() {
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        ClawdLogo(pixelSize = 7.dp)
    }
}
