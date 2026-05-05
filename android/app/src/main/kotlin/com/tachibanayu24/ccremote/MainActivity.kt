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
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
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
                    val sessions by vmCompose.sessions.collectAsState()
                    val isRefreshing by vmCompose.isRefreshing.collectAsState()
                    val showSettings by vmCompose.showSettings.collectAsState()
                    val selectedCwd by vmCompose.selectedCwd.collectAsState()
                    val selectedDetail by vmCompose.selectedDetail.collectAsState()
                    val isSendingPrompt by vmCompose.isSendingPrompt.collectAsState()

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
                            isSendingPrompt = isSendingPrompt,
                            onBack = vmCompose::closeSession,
                            onSendPrompt = { text -> vmCompose.sendPrompt(selectedCwd!!, text) },
                            onDecideApproval = vmCompose::decideApproval,
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
        if (intent?.action != ACTION_OPEN_SESSION) return
        val cwd = intent.getStringExtra(EXTRA_CWD)?.takeIf { it.isNotBlank() } ?: return
        vm.openSession(cwd)
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
        const val ACTION_OPEN_SESSION = "com.tachibanayu24.ccremote.action.OPEN_SESSION"
        const val EXTRA_CWD = "cwd"
    }
}
