package com.tachibanayu24.ccremote.data

import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/**
 * HTTP client wired to a single `Config`. Hold one instance per active
 * config (see `BackendClientHolder`) — each instance owns an OkHttp
 * connection pool, so re-creating per call destroys keep-alive and HTTP/2
 * multiplexing benefits.
 */
class BackendClient(private val config: Config) {
    private val http = HttpClient(OkHttp) {
        install(ContentNegotiation) {
            json(Json { ignoreUnknownKeys = true })
        }
        install(HttpTimeout) {
            requestTimeoutMillis = 15_000
            connectTimeoutMillis = 10_000
            socketTimeoutMillis = 15_000
        }
        defaultRequest {
            header(HttpHeaders.Authorization, "Bearer ${config.sharedSecret}")
            contentType(ContentType.Application.Json)
        }
        expectSuccess = false
    }

    suspend fun health(): Boolean = runCatching {
        val res: HttpResponse = http.get("${config.backendUrl}/health")
        res.status.isSuccess()
    }.getOrDefault(false)

    suspend fun registerDevice(fcmToken: String, name: String?): Boolean = runCatching {
        val res: HttpResponse = http.post("${config.backendUrl}/v1/devices/register") {
            setBody(DeviceRegisterRequest(config.deviceId, fcmToken, name))
        }
        res.status.isSuccess()
    }.getOrDefault(false)

    suspend fun respondApproval(
        requestId: String,
        decision: String,
        addToAllowlist: Boolean = false,
    ): Boolean = runCatching {
        val res: HttpResponse = http.post("${config.backendUrl}/v1/approvals/$requestId/respond") {
            setBody(
                ApprovalRespondRequest(
                    decision = decision,
                    device_id = config.deviceId,
                    add_to_allowlist = addToAllowlist,
                ),
            )
        }
        res.status.isSuccess()
    }.getOrDefault(false)

    suspend fun listSessions(): List<Session> = runCatching {
        val res: HttpResponse = http.get("${config.backendUrl}/v1/sessions")
        if (!res.status.isSuccess()) emptyList() else res.body<SessionsResponse>().sessions
    }.getOrDefault(emptyList())

    suspend fun sessionDetail(sessionId: String, limit: Int = 20): SessionDetailResponse? = runCatching {
        val res: HttpResponse = http.get(
            "${config.backendUrl}/v1/sessions/${encodePathSegment(sessionId)}/turns?limit=$limit",
        )
        if (!res.status.isSuccess()) null else res.body<SessionDetailResponse>()
    }.getOrNull()

    suspend fun postPrompt(sessionId: String, text: String): Boolean = runCatching {
        val res: HttpResponse = http.post("${config.backendUrl}/v1/sessions/${encodePathSegment(sessionId)}/prompts") {
            setBody(PromptCreateRequest(text))
        }
        res.status.isSuccess()
    }.getOrDefault(false)

    suspend fun fetchSettings(): NotificationSettings? = runCatching {
        val res: HttpResponse = http.get("${config.backendUrl}/v1/settings")
        if (!res.status.isSuccess()) null else res.body<NotificationSettings>()
    }.getOrNull()

    suspend fun updateSettings(askDelayMs: Long?, stopThresholdMs: Long?): NotificationSettings? = runCatching {
        val res: HttpResponse = http.put("${config.backendUrl}/v1/settings") {
            setBody(NotificationSettingsUpdate(askDelayMs, stopThresholdMs))
        }
        if (!res.status.isSuccess()) null else res.body<NotificationSettings>()
    }.getOrNull()

    suspend fun sendTestNotification(): Boolean = runCatching {
        val res: HttpResponse = http.post("${config.backendUrl}/v1/hook/stop") {
            setBody(
                HookStopRequest(
                    session_id = "android-test",
                    cwd = "/Users/test/android-test",
                    ai_title = "test (from Android)",
                    // Pass an elapsed value over any reasonable threshold so the
                    // backend always pushes the FCM for this manual test.
                    elapsed_ms = 24L * 60L * 60L * 1000L,
                    full_message = "test",
                ),
            )
        }
        res.status.isSuccess()
    }.getOrDefault(false)

    /** URLEncoder uses '+' for spaces (form encoding); path parsers expect %20. */
    private fun encodePathSegment(value: String): String =
        URLEncoder.encode(value, StandardCharsets.UTF_8.name()).replace("+", "%20")

    fun close() = http.close()
}
