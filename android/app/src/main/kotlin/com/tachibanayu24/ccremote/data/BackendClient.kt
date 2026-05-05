package com.tachibanayu24.ccremote.data

import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json

class BackendClient(private val config: Config) {
    private val http = HttpClient(OkHttp) {
        install(ContentNegotiation) {
            json(Json { ignoreUnknownKeys = true })
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

    suspend fun registerDevice(fcmToken: String, name: String?) {
        http.post("${config.backendUrl}/v1/devices/register") {
            setBody(DeviceRegisterRequest(config.deviceId, fcmToken, name))
        }
    }

    suspend fun respondApproval(
        requestId: String,
        decision: String,
        addToAllowlist: Boolean = false,
    ) {
        http.post("${config.backendUrl}/v1/approvals/$requestId/respond") {
            setBody(
                ApprovalRespondRequest(
                    decision = decision,
                    device_id = config.deviceId,
                    add_to_allowlist = addToAllowlist,
                )
            )
        }
    }

    suspend fun listSessions(): List<Session> = runCatching {
        val res: HttpResponse = http.get("${config.backendUrl}/v1/sessions")
        if (!res.status.isSuccess()) emptyList() else res.body<SessionsResponse>().sessions
    }.getOrDefault(emptyList())

    suspend fun sessionDetail(cwd: String, limit: Int = 20): SessionDetailResponse? = runCatching {
        val res: HttpResponse = http.get("${config.backendUrl}/v1/sessions/${encodeCwd(cwd)}/turns?limit=$limit")
        if (!res.status.isSuccess()) null else res.body<SessionDetailResponse>()
    }.getOrNull()

    suspend fun postPrompt(cwd: String, text: String): Boolean = runCatching {
        val res: HttpResponse = http.post("${config.backendUrl}/v1/sessions/${encodeCwd(cwd)}/prompts") {
            setBody(PromptCreateRequest(text))
        }
        res.status.isSuccess()
    }.getOrDefault(false)

    private fun encodeCwd(cwd: String): String =
        // URLEncoder uses '+' for spaces (form encoding); path parsers expect %20.
        java.net.URLEncoder.encode(cwd, "UTF-8").replace("+", "%20")

    suspend fun sendTestNotification() {
        http.post("${config.backendUrl}/v1/hook/stop") {
            setBody(
                HookStopRequest(
                    session_id = "android-test",
                    cwd = "/Users/test/android-test",
                    ai_title = "test (from Android)",
                    // Pass an elapsed value over any reasonable threshold so the
                    // backend always pushes the FCM for this manual test.
                    elapsed_ms = 24L * 60L * 60L * 1000L,
                    full_message = "test",
                )
            )
        }
    }

    fun close() = http.close()
}
