package com.tachibanayu24.ccremote.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.tachibanayu24.ccremote.notification.ApprovalPayload

@Composable
fun ApprovalDialog(
    payload: ApprovalPayload,
    onAllow: () -> Unit,
    onAllowAlways: () -> Unit,
    onDeny: () -> Unit,
    onDismiss: () -> Unit,
) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            shape = RoundedCornerShape(16.dp),
            color = MaterialTheme.colorScheme.surface,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp),
        ) {
            Column(modifier = Modifier.padding(20.dp)) {
                // Scrollable content area — never truncates, grows as tall as
                // needed within the dialog and lets the user scroll the rest.
                Column(
                    modifier = Modifier
                        .verticalScroll(rememberScrollState())
                        .weight(1f, fill = false),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        text = payload.titleHead,
                        style = MaterialTheme.typography.titleSmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                    val header = if (payload.actionLabel != payload.toolName)
                        "${payload.toolName} · ${payload.actionLabel}"
                    else
                        payload.toolName
                    Text(
                        text = header,
                        style = MaterialTheme.typography.titleMedium,
                    )
                    if (payload.description.isNotBlank() && payload.description != payload.detail) {
                        Text(
                            text = payload.description,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                    Surface(
                        shape = RoundedCornerShape(8.dp),
                        color = MaterialTheme.colorScheme.surfaceVariant,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            text = payload.detail,
                            style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                            modifier = Modifier.padding(12.dp),
                        )
                    }
                }

                Spacer(Modifier.height(16.dp))

                // Buttons stay pinned at the bottom of the dialog, outside the
                // scrollable area so they're always reachable.
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = onAllow,
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("Allow") }
                    Button(
                        onClick = onAllowAlways,
                        modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.tertiary,
                            contentColor = MaterialTheme.colorScheme.onTertiary,
                        ),
                    ) { Text("Always allow") }
                    OutlinedButton(
                        onClick = onDeny,
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("Deny") }
                }
            }
        }
    }
}
