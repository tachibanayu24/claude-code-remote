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
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.core.content.ContextCompat
import com.tachibanayu24.ccremote.ui.HomeScreen
import com.tachibanayu24.ccremote.ui.MainViewModel
import com.tachibanayu24.ccremote.ui.Screen
import com.tachibanayu24.ccremote.ui.SessionDetailScreen
import com.tachibanayu24.ccremote.ui.SettingsScreen
import com.tachibanayu24.ccremote.ui.SetupScreen
import com.tachibanayu24.ccremote.ui.theme.BgGradientBottom
import com.tachibanayu24.ccremote.ui.theme.BgGradientTop
import com.tachibanayu24.ccremote.ui.theme.CcRemoteTheme

class MainActivity : ComponentActivity() {
    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* outcome ignored */ }

    private val vm: MainViewModel by viewModels { MainViewModel.Factory(application) }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        ensureNotificationPermission()
        handleIntent(intent)

        setContent {
            CcRemoteTheme {
                // Surface keeps the Material content-color resolution working
                // (so default Icon tints / Text colors stay correct) but its
                // own fill is transparent — the gradient brush behind it is
                // what actually paints the app background.
                Surface(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(
                            Brush.verticalGradient(listOf(BgGradientTop, BgGradientBottom)),
                        ),
                    color = Color.Transparent,
                    contentColor = MaterialTheme.colorScheme.onBackground,
                ) {
                    val config by vm.config.collectAsState()
                    val state by vm.uiState.collectAsState()

                    // Treat detail and settings as pages: a back gesture
                    // returns to home instead of finishing the activity.
                    BackHandler(enabled = state.screen != Screen.Home) {
                        when (state.screen) {
                            is Screen.Detail -> vm.exitDetail()
                            Screen.Settings -> vm.closeSettings()
                            Screen.Home -> Unit
                        }
                    }

                    val current = config
                    if (current == null) {
                        SetupScreen(
                            isWorking = state.isSaving,
                            error = state.saveError,
                            onSave = vm::saveConfig,
                        )
                        return@Surface
                    }
                    when (val screen = state.screen) {
                        Screen.Home -> HomeScreen(
                            sessions = state.sessions,
                            isRefreshing = state.isRefreshing,
                            onRefresh = vm::refreshSessions,
                            onOpenSettings = vm::openSettings,
                            onSelectSession = vm::openSession,
                        )
                        is Screen.Detail -> SessionDetailScreen(
                            detail = state.selectedDetail,
                            isSendingPrompt = state.isSendingPrompt,
                            onBack = vm::exitDetail,
                            onSendPrompt = { text -> vm.sendPrompt(screen.sessionId, text) },
                            onDecideApproval = vm::decideApproval,
                            onAnswerQuestion = vm::answerQuestion,
                            onCloseSession = { vm.requestCloseSession(screen.sessionId) },
                        )
                        Screen.Settings -> SettingsScreen(
                            config = current,
                            fcmToken = state.fcmToken,
                            notificationSettings = state.notificationSettings,
                            isSavingSettings = state.isSavingSettings,
                            settingsError = state.settingsError,
                            onBack = vm::closeSettings,
                            onSaveNotificationSettings = vm::saveNotificationSettings,
                            onResetConfig = vm::resetConfig,
                            onTestNotification = vm::sendTestNotification,
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
        val sessionId = intent.getStringExtra(EXTRA_SESSION_ID)?.takeIf { it.isNotBlank() } ?: return
        vm.openSession(sessionId)
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
        const val EXTRA_SESSION_ID = "session_id"
    }
}
