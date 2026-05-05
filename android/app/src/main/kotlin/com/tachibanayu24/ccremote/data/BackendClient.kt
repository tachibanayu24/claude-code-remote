package com.tachibanayu24.ccremote.data

import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.defaultRequest
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
