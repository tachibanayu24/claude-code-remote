package com.tachibanayu24.ccremote

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
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
import androidx.lifecycle.viewmodel.compose.viewModel
import com.tachibanayu24.ccremote.ui.HomeScreen
import com.tachibanayu24.ccremote.ui.MainViewModel
import com.tachibanayu24.ccremote.ui.SetupScreen
import com.tachibanayu24.ccremote.ui.theme.CcRemoteTheme

class MainActivity : ComponentActivity() {
    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* outcome ignored */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        ensureNotificationPermission()

        setContent {
            CcRemoteTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    val vm: MainViewModel = viewModel(factory = MainViewModel.Factory(application))
                    val config by vm.config.collectAsState()
                    val token by vm.fcmToken.collectAsState()
                    val saveError by vm.saveError.collectAsState()
                    val isWorking by vm.isWorking.collectAsState()

                    val current = config
                    if (current == null) {
                        SetupScreen(
                            isWorking = isWorking,
                            error = saveError,
                            onSave = vm::saveConfig,
                        )
                    } else {
                        HomeScreen(
                            config = current,
                            fcmToken = token,
                            onResetConfig = vm::resetConfig,
                            onTestNotification = vm::sendTestNotification,
                        )
                    }
                }
            }
        }
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
}
