package com.tachibanayu24.ccremote.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.tachibanayu24.ccremote.data.AskQuestion
import com.tachibanayu24.ccremote.data.BackendClientHolder
import com.tachibanayu24.ccremote.ui.theme.BgGradientBottom
import com.tachibanayu24.ccremote.ui.theme.BgGradientTop
import com.tachibanayu24.ccremote.ui.theme.CcRemoteTheme
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject

/**
 * AskUserQuestion 用の回答画面。 FCM の data に詰めた `questions` JSON を
 * 受け取って Compose で展開する。 multiSelect=false は RadioButton、
 * multiSelect=true は Checkbox。 Submit で /v1/questions/:id/respond に POST。
 *
 * 承認 (approval) のように notification action button だけで完結しないので、
 * 専用 Activity を立てる。 PermissionRequest hook の long-poll が並行で走って
 * いて、 backend に response が届いた瞬間に CLI dialog も閉じる流儀。
 */
class QuestionActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        val requestId = intent.getStringExtra("request_id").orEmpty()
        val sessionLabel = intent.getStringExtra("session_label").orEmpty()
        val project = intent.getStringExtra("project").orEmpty()
        val questionsRaw = intent.getStringExtra("questions").orEmpty()

        val questions: List<AskQuestion> = runCatching {
            Json { ignoreUnknownKeys = true }.decodeFromString<List<AskQuestion>>(questionsRaw)
        }.getOrDefault(emptyList())

        setContent {
            CcRemoteTheme {
                Surface(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(
                            Brush.verticalGradient(listOf(BgGradientTop, BgGradientBottom)),
                        ),
                    color = Color.Transparent,
                    contentColor = MaterialTheme.colorScheme.onBackground,
                ) {
                    if (requestId.isBlank() || questions.isEmpty()) {
                        // payload 不正: そのまま閉じる
                        LaunchedEffect(Unit) { finish() }
                        return@Surface
                    }

                    val vm: QuestionViewModel = viewModel(
                        factory = QuestionViewModel.Factory(application, requestId)
                    )
                    val state by vm.uiState.collectAsState()

                    LaunchedEffect(state.submitted) {
                        if (state.submitted) {
                            // 通知も消す (hook 側で resolve push が来るが念のため)
                            NotificationManagerCompat.from(this@QuestionActivity)
                                .cancel(requestId.hashCode())
                            finish()
                        }
                    }

                    QuestionScreen(
                        sessionLabel = sessionLabel,
                        project = project,
                        questions = questions,
                        isSubmitting = state.isSubmitting,
                        error = state.error,
                        onSubmit = { selections -> vm.submit(questions, selections) },
                        onCancel = { finish() },
                    )
                }
            }
        }
    }
}

private data class QuestionUiState(
    val isSubmitting: Boolean = false,
    val submitted: Boolean = false,
    val error: String? = null,
)

private class QuestionViewModel(
    private val app: android.app.Application,
    private val requestId: String,
) : ViewModel() {
    private val _state = MutableStateFlow(QuestionUiState())
    val uiState: StateFlow<QuestionUiState> = _state.asStateFlow()

    /**
     * selections: question_index -> selected label set。 multiSelect=false は
     * 1 要素 set として持つ。 これを backend の answers 形式
     * { question: label | label[] } に変換して送る。
     */
    fun submit(questions: List<AskQuestion>, selections: Map<Int, Set<String>>) {
        if (_state.value.isSubmitting) return
        _state.value = _state.value.copy(isSubmitting = true, error = null)

        val answers = buildJsonObject {
            questions.forEachIndexed { idx, q ->
                val picks = selections[idx] ?: emptySet()
                if (picks.isEmpty()) return@forEachIndexed
                if (q.multiSelect) {
                    put(q.question, buildJsonArray { picks.forEach { add(JsonPrimitive(it)) } })
                } else {
                    put(q.question, JsonPrimitive(picks.first()))
                }
            }
        }

        viewModelScope.launch {
            val client = BackendClientHolder.ensure(app)
            if (client == null) {
                _state.value = _state.value.copy(isSubmitting = false, error = "config missing")
                return@launch
            }
            val ok = client.respondQuestion(requestId, answers)
            if (ok) {
                _state.value = _state.value.copy(isSubmitting = false, submitted = true)
            } else {
                _state.value = _state.value.copy(
                    isSubmitting = false,
                    error = "送信に失敗しました (もう CLI で回答済みかも)",
                )
            }
        }
    }

    class Factory(
        private val app: android.app.Application,
        private val requestId: String,
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            return QuestionViewModel(app, requestId) as T
        }
    }
}

@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun QuestionScreen(
    sessionLabel: String,
    project: String,
    questions: List<AskQuestion>,
    isSubmitting: Boolean,
    error: String?,
    onSubmit: (Map<Int, Set<String>>) -> Unit,
    onCancel: () -> Unit,
) {
    // 各質問の現在の選択状態。multiSelect=false は 1 要素 set、
    // multiSelect=true は複数 set。
    val selections = remember { mutableStateOf<Map<Int, Set<String>>>(emptyMap()) }

    val titleHead = sessionLabel.ifBlank { project.ifBlank { "Claude" } }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("❓ $titleHead") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Color.Transparent,
                ),
            )
        },
        containerColor = Color.Transparent,
    ) { pad ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(pad)
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            LazyColumn(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f, fill = true),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                contentPadding = PaddingValues(vertical = 8.dp),
            ) {
                items(questions.size) { idx ->
                    val q = questions[idx]
                    QuestionCard(
                        index = idx,
                        question = q,
                        selected = selections.value[idx] ?: emptySet(),
                        onSelectionChange = { newSet ->
                            selections.value = selections.value.toMutableMap().apply { put(idx, newSet) }
                        },
                    )
                }
            }

            if (error != null) {
                Text(error, color = MaterialTheme.colorScheme.error)
            }

            val canSubmit = !isSubmitting && questions.indices.all { (selections.value[it]?.isNotEmpty()) == true }
            Button(
                onClick = { onSubmit(selections.value) },
                enabled = canSubmit,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(if (isSubmitting) "送信中..." else "送信")
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}

@Composable
private fun QuestionCard(
    index: Int,
    question: AskQuestion,
    selected: Set<String>,
    onSelectionChange: (Set<String>) -> Unit,
) {
    Card(
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f),
        ),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            // ヘッダー (chip 的役割) と質問本文を上下に並べる
            if (question.header.isNotBlank()) {
                Text(
                    text = question.header,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
            Text(
                text = "Q${index + 1}. ${question.question}",
                style = MaterialTheme.typography.titleSmall,
            )

            question.options.forEach { opt ->
                val isSelected = selected.contains(opt.label)
                val newSet: () -> Set<String> = {
                    if (question.multiSelect) {
                        if (isSelected) selected - opt.label else selected + opt.label
                    } else {
                        setOf(opt.label)
                    }
                }
                androidx.compose.foundation.layout.Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (question.multiSelect) {
                        Checkbox(
                            checked = isSelected,
                            onCheckedChange = { onSelectionChange(newSet()) },
                        )
                    } else {
                        RadioButton(
                            selected = isSelected,
                            onClick = { onSelectionChange(newSet()) },
                        )
                    }
                    Column(modifier = Modifier.padding(start = 4.dp)) {
                        Text(opt.label, style = MaterialTheme.typography.bodyLarge)
                        if (opt.description.isNotBlank()) {
                            Text(
                                opt.description,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }
    }
}
