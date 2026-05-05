package com.tachibanayu24.ccremote.data

import android.content.Context

/**
 * Process-wide owner of the live `BackendClient`. Re-creates only when the
 * `Config` actually changes; callers (ViewModel, Service, BroadcastReceiver)
 * call `current()` to share one OkHttp connection pool. The ViewModel keeps
 * this in sync by collecting `ConfigStore.flow(...)`; service/receiver paths
 * use `ensure(context)` to lazy-load the cached config from DataStore.
 */
object BackendClientHolder {
    @Volatile
    private var client: BackendClient? = null
    private var lastConfig: Config? = null

    /** Returns the current client (or null if config is unset). */
    fun current(): BackendClient? = client

    /**
     * Replace the active client to match [config]. Closes the previous one
     * first. Idempotent if the config is unchanged.
     */
    @Synchronized
    fun update(config: Config?) {
        if (config == lastConfig) return
        client?.close()
        client = config?.let { BackendClient(it) }
        lastConfig = config
    }

    /**
     * Lazy-load the current config from DataStore and cache the resulting
     * client. Useful from BroadcastReceivers that don't have the ViewModel.
     */
    suspend fun ensure(context: Context): BackendClient? {
        val cfg = ConfigStore.current(context.applicationContext)
        update(cfg)
        return client
    }
}
