package com.tachibanayu24.ccremote.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.tachibanayu24.ccremote.data.AskQuestion
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject

/**
 * AskUserQuestion 用の回答フォーム Composable。 QuestionActivity (通知タップ
 * 経由) と SessionDetailScreen のチャット内インライン (承認 relay と同じ流儀)
 * 両方から再利用される。
 *
 * 内部で選択状態を保持し、 Submit 時に backend に送る形の JsonObject に変換
 * してコールバック。 multiSelect=false → label の string、 multiSelect=true
 * → label の JsonArray。 spike で確定した CC 受理形式。
 */
@Composable
fun QuestionForm(
    questions: List<AskQuestion>,
    isSubmitting: Boolean,
    error: String?,
    submitLabel: String = "送信",
    onSubmit: (JsonObject) -> Unit,
) {
    val selections = remember { mutableStateOf<Map<Int, Set<String>>>(emptyMap()) }

    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        questions.forEachIndexed { idx, q ->
            QuestionCard(
                index = idx,
                question = q,
                selected = selections.value[idx] ?: emptySet(),
                onSelectionChange = { newSet ->
                    selections.value = selections.value.toMutableMap().apply { put(idx, newSet) }
                },
            )
        }

        if (error != null) {
            Text(error, color = MaterialTheme.colorScheme.error)
        }

        val canSubmit = !isSubmitting && questions.indices.all { (selections.value[it]?.isNotEmpty()) == true }
        Button(
            onClick = {
                onSubmit(buildAnswers(questions, selections.value))
            },
            enabled = canSubmit,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(if (isSubmitting) "送信中..." else submitLabel)
        }
    }
}

private fun buildAnswers(
    questions: List<AskQuestion>,
    selections: Map<Int, Set<String>>,
): JsonObject = buildJsonObject {
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
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f),
        ),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
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
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 2.dp),
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
