package com.tachibanayu24.ccremote

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import com.tachibanayu24.ccremote.notification.ApprovalActionReceiver
import com.tachibanayu24.ccremote.notification.ApprovalPayload
import com.tachibanayu24.ccremote.notification.CompletionPayload
import com.tachibanayu24.ccremote.ui.ApprovalDialog
import com.tachibanayu24.ccremote.ui.CompletionDialog
import com.tachibanayu24.ccremote.ui.HomeScreen
import com.tachibanayu24.ccremote.ui.MainViewModel
import com.tachibanayu24.ccremote.ui.SessionDetailScreen
import com.tachibanayu24.ccremote.ui.SettingsScreen
import com.tachibanayu24.ccremote.ui.SetupScreen
import com.tachibanayu24.ccremote.ui.theme.CcRemoteTheme

class MainActivity : ComponentActivity() {
    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* outcome ignored */ }

    private lateinit var vm: MainViewModel

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        ensureNotificationPermission()

        vm = ViewModelProvider(this, MainViewModel.Factory(application))[MainViewModel::class.java]
        handleIntent(intent)

        setContent {
            CcRemoteTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    val vmCompose: MainViewModel = viewModel(factory = MainViewModel.Factory(application))
                    val config by vmCompose.config.collectAsState()
                    val token by vmCompose.fcmToken.collectAsState()
                    val saveError by vmCompose.saveError.collectAsState()
                    val isWorking by vmCompose.isWorking.collectAsState()
                    val approval by vmCompose.approval.collectAsState()
                    val completion by vmCompose.completion.collectAsState()
                    val sessions by vmCompose.sessions.collectAsState()
                    val isRefreshing by vmCompose.isRefreshing.collectAsState()
                    val showSettings by vmCompose.showSettings.collectAsState()
                    val selectedCwd by vmCompose.selectedCwd.collectAsState()
                    val selectedDetail by vmCompose.selectedDetail.collectAsState()

                    // Treat detail and settings as pages: a back gesture
                    // returns to home instead of finishing the activity.
                    BackHandler(enabled = selectedCwd != null) {
                        vmCompose.closeSession()
                    }
                    BackHandler(enabled = showSettings) {
                        vmCompose.closeSettings()
                    }

                    val current = config
                    if (current == null) {
                        SetupScreen(
                            isWorking = isWorking,
                            error = saveError,
                            onSave = vmCompose::saveConfig,
                        )
                    } else if (showSettings) {
                        SettingsScreen(
                            config = current,
                            fcmToken = token,
                            onBack = vmCompose::closeSettings,
                            onResetConfig = vmCompose::resetConfig,
                            onTestNotification = vmCompose::sendTestNotification,
                        )
                    } else if (selectedCwd != null) {
                        val fallback = sessions.firstOrNull { it.cwd == selectedCwd }?.project_name
                            ?: selectedCwd!!.substringAfterLast('/')
                        SessionDetailScreen(
                            detail = selectedDetail,
                            fallbackProjectName = fallback,
                            onBack = vmCompose::closeSession,
                        )
                    } else {
                        HomeScreen(
                            sessions = sessions,
                            isRefreshing = isRefreshing,
                            onRefresh = vmCompose::refreshSessions,
                            onOpenSettings = vmCompose::openSettings,
                            onSelectSession = vmCompose::openSession,
                        )
                    }

                    approval?.let { payload ->
                        ApprovalDialog(
                            payload = payload,
                            onAllow = { decide(payload, ApprovalActionReceiver.DECISION_ALLOW, false) },
                            onAllowAlways = { decide(payload, ApprovalActionReceiver.DECISION_ALLOW, true) },
                            onDeny = { decide(payload, ApprovalActionReceiver.DECISION_DENY, false) },
                            onDismiss = { vmCompose.dismissApproval() },
                        )
                    }

                    completion?.let { payload ->
                        CompletionDialog(
                            payload = payload,
                            onDismiss = { vmCompose.dismissCompletion() },
                        )
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // Replace the activity's stored intent so a later config-change
        // recreation reads the freshly-arrived approval/completion, not the
        // launcher intent we started with.
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        when (intent?.action) {
            ACTION_VIEW_APPROVAL -> {
                val payload = ApprovalPayload.fromBundle(intent.extras) ?: return
                vm.showApproval(payload)
                NotificationManagerCompat.from(this).cancel(payload.notificationId)
            }
            ACTION_VIEW_COMPLETION -> {
                val payload = CompletionPayload.fromBundle(intent.extras) ?: return
                vm.showCompletion(payload)
                NotificationManagerCompat.from(this).cancel(payload.notificationId)
            }
        }
    }

    private fun decide(payload: ApprovalPayload, decision: String, addToAllowlist: Boolean) {
        val intent = Intent(this, ApprovalActionReceiver::class.java).apply {
            action = ApprovalActionReceiver.ACTION_RESPOND
            putExtra(ApprovalActionReceiver.EXTRA_REQUEST_ID, payload.requestId)
            putExtra(ApprovalActionReceiver.EXTRA_DECISION, decision)
            putExtra(ApprovalActionReceiver.EXTRA_ALLOWLIST, addToAllowlist)
            putExtra(ApprovalActionReceiver.EXTRA_NOTIFICATION_ID, payload.notificationId)
        }
        sendBroadcast(intent)
        vm.dismissApproval()
    }

    private fun ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) {
                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }

    companion object {
        const val ACTION_VIEW_APPROVAL = "com.tachibanayu24.ccremote.action.VIEW_APPROVAL"
        const val ACTION_VIEW_COMPLETION = "com.tachibanayu24.ccremote.action.VIEW_COMPLETION"
    }
}
