package com.tachibanayu24.ccremote.ui

import android.app.Application
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.google.firebase.messaging.FirebaseMessaging
import com.tachibanayu24.ccremote.BuildConfig
import com.tachibanayu24.ccremote.data.BackendClientHolder
import com.tachibanayu24.ccremote.data.Config
import com.tachibanayu24.ccremote.data.ConfigStore
import com.tachibanayu24.ccremote.data.Session
import com.tachibanayu24.ccremote.data.SessionDetailResponse
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

/**
 * Single source of truth for the app UI. All Compose screens read from
 * [uiState]; nothing else is exposed. Mutations go through `_uiState.update`
 * so a snapshot is always coherent (no half-applied transitions).
 */
data class UiState(
    val screen: Screen = Screen.Home,
    val sessions: List<Session> = emptyList(),
    val isRefreshing: Boolean = false,
    val isSaving: Boolean = false,
    val isSendingPrompt: Boolean = false,
    val saveError: String? = null,
    val fcmToken: String? = null,
    val selectedDetail: SessionDetailResponse? = null,
)

class MainViewModel(private val app: Application) : AndroidViewModel(app) {
    val config: StateFlow<Config?> =
        ConfigStore.flow(app).stateIn(viewModelScope, SharingStarted.Eagerly, null)

    private val _uiState = MutableStateFlow(UiState())
    val uiState: StateFlow<UiState> = _uiState.asStateFlow()

    private var detailPollJob: Job? = null

    init {
        viewModelScope.launch {
            // 1. Auto-bootstrap from local.properties if DataStore is empty.
            //    Lets a fresh install pick up the dev-time secret without the
            //    user typing it; release builds with empty BuildConfig fall
            //    through to the SetupScreen path.
            if (ConfigStore.current(app) == null) {
                val url = BuildConfig.BACKEND_URL
                val secret = BuildConfig.SHARED_SECRET
                if (url.isNotBlank() && secret.isNotBlank()) {
                    ConfigStore.save(app, url, secret)
                }
            }

            // 2. Track config and keep BackendClientHolder in sync. Subsequent
            //    uses (here, in the Service, in the Receiver) share one OkHttp
            //    pool instead of opening a new one per request.
            launch {
                config.collect { cfg -> BackendClientHolder.update(cfg) }
            }

            // 3. Once bootstrap is done and a config exists, register the FCM
            //    token. Skip silently if Firebase isn't reachable — we'll
            //    retry on the next app start.
            val token = runCatching { FirebaseMessaging.getInstance().token.await() }.getOrNull()
            if (token != null) {
                _uiState.update { it.copy(fcmToken = token) }
                if (ConfigStore.current(app) != null) {
                    BackendClientHolder.ensure(app)?.registerDevice(token, Build.MODEL)
                }
            }

            // 4. Start the home-list background poll. 30s is plenty for an
            //    at-a-glance dashboard; pull-to-refresh covers urgency.
            launch {
                while (true) {
                    val client = BackendClientHolder.current()
                    if (client != null) {
                        val list = client.listSessions()
                        _uiState.update { it.copy(sessions = list) }
                    }
                    delay(30_000)
                }
            }
        }
    }

    // ---------- Navigation ----------

    fun openSession(cwd: String) {
        // Already on this session — leave the existing poll running so the
        // current detail data isn't briefly cleared.
        if ((_uiState.value.screen as? Screen.Detail)?.cwd == cwd) return
        _uiState.update { it.copy(screen = Screen.Detail(cwd), selectedDetail = null) }
        startDetailPolling(cwd)
    }

    fun closeSession() {
        if (_uiState.value.screen !is Screen.Detail) return
        _uiState.update { it.copy(screen = Screen.Home, selectedDetail = null) }
        detailPollJob?.cancel()
        detailPollJob = null
    }

    fun openSettings() {
        _uiState.update { it.copy(screen = Screen.Settings) }
    }

    fun closeSettings() {
        if (_uiState.value.screen !is Screen.Settings) return
        _uiState.update { it.copy(screen = Screen.Home, saveError = null) }
    }

    private fun startDetailPolling(cwd: String) {
        detailPollJob?.cancel()
        detailPollJob = viewModelScope.launch {
            while (true) {
                val current = _uiState.value.screen
                if (current !is Screen.Detail || current.cwd != cwd) break
                BackendClientHolder.current()?.sessionDetail(cwd)?.let { detail ->
                    _uiState.update { it.copy(selectedDetail = detail) }
                }
                // Match the channel.mjs heartbeat cadence so the live in-flight
                // assistant text feels responsive without busy-looping.
                delay(3_000)
            }
        }
    }

    // ---------- Home actions ----------

    fun refreshSessions() {
        viewModelScope.launch {
            val client = BackendClientHolder.current() ?: return@launch
            _uiState.update { it.copy(isRefreshing = true) }
            try {
                val list = client.listSessions()
                _uiState.update { it.copy(sessions = list) }
            } finally {
                _uiState.update { it.copy(isRefreshing = false) }
            }
        }
    }

    // ---------- Detail actions ----------

    /**
     * Enqueue a prompt for `cwd`. The PC's channel.mjs polls and injects it
     * as the next user turn. We optimistically refresh detail right after so
     * the UI feels snappy even before the next 3s tick.
     */
    fun sendPrompt(cwd: String, text: String) {
        val trimmed = text.trim()
        if (trimmed.isEmpty() || _uiState.value.isSendingPrompt) return
        viewModelScope.launch {
            val client = BackendClientHolder.current() ?: return@launch
            _uiState.update { it.copy(isSendingPrompt = true) }
            try {
                client.postPrompt(cwd, trimmed)
                client.sessionDetail(cwd)?.let { detail ->
                    _uiState.update { it.copy(selectedDetail = detail) }
                }
            } finally {
                _uiState.update { it.copy(isSendingPrompt = false) }
            }
        }
    }

    fun decideApproval(approvalId: String, decision: String, addToAllowlist: Boolean) {
        viewModelScope.launch {
            val client = BackendClientHolder.current() ?: return@launch
            client.respondApproval(approvalId, decision, addToAllowlist)
            // Refresh detail so the resolved approval disappears from the
            // pending list immediately.
            val cwd = (_uiState.value.screen as? Screen.Detail)?.cwd ?: return@launch
            client.sessionDetail(cwd)?.let { detail ->
                _uiState.update { it.copy(selectedDetail = detail) }
            }
        }
    }

    // ---------- Setup / Settings ----------

    fun saveConfig(url: String, secret: String) {
        if (_uiState.value.isSaving) return
        viewModelScope.launch {
            _uiState.update { it.copy(isSaving = true, saveError = null) }
            try {
                val cleanUrl = url.trim().trimEnd('/')
                val cleanSecret = secret.trim()
                if (cleanUrl.isBlank() || cleanSecret.isBlank()) {
                    _uiState.update { it.copy(saveError = "URL とシークレットを入力してください") }
                    return@launch
                }
                if (!cleanUrl.startsWith("https://") && !cleanUrl.startsWith("http://")) {
                    _uiState.update { it.copy(saveError = "URL は http:// または https:// で始めてください") }
                    return@launch
                }
                val tempDeviceId = "probe"
                val probe = com.tachibanayu24.ccremote.data.BackendClient(
                    Config(cleanUrl, cleanSecret, tempDeviceId),
                )
                val healthy = try { probe.health() } finally { probe.close() }
                if (!healthy) {
                    _uiState.update { it.copy(saveError = "Backend に接続できません (URL を確認)") }
                    return@launch
                }

                ConfigStore.save(app, cleanUrl, cleanSecret)
                val saved = ConfigStore.flow(app).first { it != null } ?: return@launch
                BackendClientHolder.update(saved)
                val token = runCatching { FirebaseMessaging.getInstance().token.await() }.getOrNull()
                if (token != null) {
                    _uiState.update { it.copy(fcmToken = token) }
                    BackendClientHolder.current()?.registerDevice(token, Build.MODEL)
                } else {
                    _uiState.update { it.copy(saveError = "FCM トークン取得に失敗 (Firebase 設定を確認)") }
                }
            } catch (e: Exception) {
                _uiState.update { it.copy(saveError = e.message ?: "不明なエラー") }
            } finally {
                _uiState.update { it.copy(isSaving = false) }
            }
        }
    }

    fun resetConfig() {
        viewModelScope.launch {
            ConfigStore.clear(app)
            BackendClientHolder.update(null)
            _uiState.update { it.copy(saveError = null) }
        }
    }

    fun sendTestNotification() {
        viewModelScope.launch {
            BackendClientHolder.current()?.sendTestNotification()
        }
    }

    class Factory(private val app: Application) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T = MainViewModel(app) as T
    }
}
