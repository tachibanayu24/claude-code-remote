package com.tachibanayu24.ccremote.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import java.util.UUID

private val Context.dataStore by preferencesDataStore("cc_remote_config")

object ConfigStore {
    private val K_BACKEND = stringPreferencesKey("backend_url")
    private val K_SECRET = stringPreferencesKey("shared_secret")
    private val K_DEVICE_ID = stringPreferencesKey("device_id")

    fun flow(context: Context): Flow<Config?> = context.dataStore.data.map { prefs ->
        val url = prefs[K_BACKEND].orEmpty()
        val secret = prefs[K_SECRET].orEmpty()
        val deviceId = prefs[K_DEVICE_ID].orEmpty()
        if (url.isBlank() || secret.isBlank() || deviceId.isBlank()) null
        else Config(url, secret, deviceId)
    }

    suspend fun current(context: Context): Config? = flow(context).first()

    suspend fun save(context: Context, url: String, secret: String) {
        context.dataStore.edit { prefs ->
            prefs[K_BACKEND] = url.trimEnd('/')
            prefs[K_SECRET] = secret
            if (prefs[K_DEVICE_ID].isNullOrBlank()) {
                prefs[K_DEVICE_ID] = UUID.randomUUID().toString()
            }
        }
    }

    suspend fun clear(context: Context) {
        context.dataStore.edit { it.clear() }
    }
}
