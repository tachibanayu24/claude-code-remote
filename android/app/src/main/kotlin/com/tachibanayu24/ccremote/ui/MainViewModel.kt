package com.tachibanayu24.ccremote.ui

import android.app.Application
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.google.firebase.messaging.FirebaseMessaging
import com.tachibanayu24.ccremote.BuildConfig
import com.tachibanayu24.ccremote.data.BackendClient
import com.tachibanayu24.ccremote.data.Config
import com.tachibanayu24.ccremote.data.ConfigStore
import com.tachibanayu24.ccremote.notification.ApprovalPayload
import com.tachibanayu24.ccremote.notification.CompletionPayload
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

class MainViewModel(private val app: Application) : AndroidViewModel(app) {
    val config: StateFlow<Config?> =
        ConfigStore.flow(app).stateIn(viewModelScope, SharingStarted.Eagerly, null)

    private val _fcmToken = MutableStateFlow<String?>(null)
    val fcmToken: StateFlow<String?> = _fcmToken

    private val _saveError = MutableStateFlow<String?>(null)
    val saveError: StateFlow<String?> = _saveError

    private val _isWorking = MutableStateFlow(false)
    val isWorking: StateFlow<Boolean> = _isWorking

    private val _approval = MutableStateFlow<ApprovalPayload?>(null)
    val approval: StateFlow<ApprovalPayload?> = _approval

    fun showApproval(payload: ApprovalPayload) { _approval.value = payload }
    fun dismissApproval() { _approval.value = null }

    private val _completion = MutableStateFlow<CompletionPayload?>(null)
    val completion: StateFlow<CompletionPayload?> = _completion

    fun showCompletion(payload: CompletionPayload) { _completion.value = payload }
    fun dismissCompletion() { _completion.value = null }

    init {
        viewModelScope.launch {
            // Auto-bootstrap from local.properties (build-time injected) if DataStore is empty.
            if (ConfigStore.current(app) == null) {
                val url = BuildConfig.BACKEND_URL
                val secret = BuildConfig.SHARED_SECRET
                if (url.isNotBlank() && secret.isNotBlank()) {
                    ConfigStore.save(app, url, secret)
                }
            }
            val token = runCatching { FirebaseMessaging.getInstance().token.await() }.getOrNull()
                ?: return@launch
            _fcmToken.value = token
            val saved = ConfigStore.current(app) ?: return@launch
            val client = BackendClient(saved)
            runCatching { client.registerDevice(token, Build.MODEL) }
            client.close()
        }
    }

    fun saveConfig(url: String, secret: String) {
        if (_isWorking.value) return
        viewModelScope.launch {
            _isWorking.value = true
            _saveError.value = null
            try {
                val cleanUrl = url.trim().trimEnd('/')
                val cleanSecret = secret.trim()
                if (cleanUrl.isBlank() || cleanSecret.isBlank()) {
                    _saveError.value = "URL とシークレットを入力してください"
                    return@launch
                }
                val tempDeviceId = "probe"
                val probe = BackendClient(Config(cleanUrl, cleanSecret, tempDeviceId))
                if (!probe.health()) {
                    _saveError.value = "Backend に接続できません (URL を確認)"
                    probe.close()
                    return@launch
                }
                probe.close()

                ConfigStore.save(app, cleanUrl, cleanSecret)
                val saved = ConfigStore.flow(app).first { it != null }
                if (saved != null) {
                    val token = runCatching { FirebaseMessaging.getInstance().token.await() }.getOrNull()
                    if (token != null) {
                        _fcmToken.value = token
                        val client = BackendClient(saved)
                        runCatching { client.registerDevice(token, Build.MODEL) }
                        client.close()
                    } else {
                        _saveError.value = "FCM トークン取得に失敗 (Firebase 設定を確認)"
                    }
                }
            } catch (e: Exception) {
                _saveError.value = e.message ?: "不明なエラー"
            } finally {
                _isWorking.value = false
            }
        }
    }

    fun resetConfig() {
        viewModelScope.launch {
            ConfigStore.clear(app)
            _saveError.value = null
        }
    }

    fun sendTestNotification() {
        viewModelScope.launch {
            val current = config.value ?: return@launch
            val client = BackendClient(current)
            runCatching { client.sendTestNotification() }
            client.close()
        }
    }

    class Factory(private val app: Application) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T = MainViewModel(app) as T
    }
}
