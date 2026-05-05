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
import com.tachibanayu24.ccremote.data.Session
import com.tachibanayu24.ccremote.data.SessionDetailResponse
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
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

    private val _sessions = MutableStateFlow<List<Session>>(emptyList())
    val sessions: StateFlow<List<Session>> = _sessions

    private val _isRefreshing = MutableStateFlow(false)
    val isRefreshing: StateFlow<Boolean> = _isRefreshing

    private val _showSettings = MutableStateFlow(false)
    val showSettings: StateFlow<Boolean> = _showSettings

    fun openSettings() { _showSettings.value = true }
    fun closeSettings() { _showSettings.value = false }

    private val _selectedCwd = MutableStateFlow<String?>(null)
    val selectedCwd: StateFlow<String?> = _selectedCwd

    private val _selectedDetail = MutableStateFlow<SessionDetailResponse?>(null)
    val selectedDetail: StateFlow<SessionDetailResponse?> = _selectedDetail

    private val _isSendingPrompt = MutableStateFlow(false)
    val isSendingPrompt: StateFlow<Boolean> = _isSendingPrompt

    private var detailPollJob: Job? = null

    fun openSession(cwd: String) {
        // If already on this session, leave the existing poll running so the
        // current detail data isn't briefly cleared.
        if (_selectedCwd.value == cwd) return
        _selectedCwd.value = cwd
        _selectedDetail.value = null
        startDetailPolling(cwd)
    }

    private fun startDetailPolling(cwd: String) {
        detailPollJob?.cancel()
        detailPollJob = viewModelScope.launch {
            while (_selectedCwd.value == cwd) {
                val current = config.value
                if (current != null) {
                    val client = BackendClient(current)
                    runCatching { client.sessionDetail(cwd) }.getOrNull()?.let {
                        _selectedDetail.value = it
                    }
                    client.close()
                }
                // Match the channel.mjs heartbeat cadence so the live in-flight
                // assistant text feels responsive without busy-looping.
                delay(3_000)
            }
        }
    }

    fun closeSession() {
        _selectedCwd.value = null
        _selectedDetail.value = null
        detailPollJob?.cancel()
        detailPollJob = null
    }

    fun refreshSessions() {
        viewModelScope.launch {
            val current = config.value ?: return@launch
            _isRefreshing.value = true
            val client = BackendClient(current)
            _sessions.value = runCatching { client.listSessions() }.getOrDefault(emptyList())
            client.close()
            _isRefreshing.value = false
        }
    }

    /**
     * Enqueue a prompt for `cwd`. The PC's channel.mjs polls and injects it
     * as the next user turn. We optimistically refresh detail right after so
     * the UI feels snappy even before the next 3s tick.
     */
    fun sendPrompt(cwd: String, text: String) {
        val trimmed = text.trim()
        if (trimmed.isEmpty() || _isSendingPrompt.value) return
        viewModelScope.launch {
            val current = config.value ?: return@launch
            _isSendingPrompt.value = true
            try {
                val client = BackendClient(current)
                runCatching { client.postPrompt(cwd, trimmed) }
                runCatching { client.sessionDetail(cwd) }.getOrNull()?.let {
                    _selectedDetail.value = it
                }
                client.close()
            } finally {
                _isSendingPrompt.value = false
            }
        }
    }

    fun decideApproval(approvalId: String, decision: String, addToAllowlist: Boolean) {
        viewModelScope.launch {
            val current = config.value ?: return@launch
            val client = BackendClient(current)
            runCatching { client.respondApproval(approvalId, decision, addToAllowlist) }
            // Refresh detail so the resolved approval disappears from the
            // pending list immediately.
            val cwd = _selectedCwd.value
            if (cwd != null) {
                runCatching { client.sessionDetail(cwd) }.getOrNull()?.let {
                    _selectedDetail.value = it
                }
            }
            client.close()
        }
    }

    init {
        // Background poll for the home list. 30s is plenty for an at-a-glance
        // dashboard; pull-to-refresh covers urgency. Cancellation is automatic
        // when the ViewModel is cleared.
        viewModelScope.launch {
            while (true) {
                val current = config.value
                if (current != null) {
                    val client = BackendClient(current)
                    runCatching { client.listSessions() }.getOrNull()?.let { _sessions.value = it }
                    client.close()
                }
                delay(30_000)
            }
        }
    }

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
