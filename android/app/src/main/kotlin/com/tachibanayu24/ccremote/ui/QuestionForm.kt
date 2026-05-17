package com.tachibanayu24.ccremote.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.tachibanayu24.ccremote.data.AskQuestion
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject

/**
 * AskUserQuestion 用の回答フォーム。 SessionDetailScreen の PendingQuestionBlock
 * に inline で埋め込まれる。 デザインは PendingApprovalBlock と揃えてあって、
 * Card で二重に浮かさず、 質問本文 + radio/checkbox + Submit ボタンだけの
 * フラットな見た目。 各 option 行全体が clickable なので、 label 直タップで
 * 選択が変わる。
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
            QuestionEntry(
                index = idx,
                question = q,
                selected = selections.value[idx] ?: emptySet(),
                onSelectionChange = { newSet ->
                    selections.value = selections.value.toMutableMap().apply { put(idx, newSet) }
                },
            )
        }

        if (error != null) {
            Text(
                error,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.error,
            )
        }

        val canSubmit = !isSubmitting && questions.indices.all { (selections.value[it]?.isNotEmpty()) == true }
        Button(
            onClick = { onSubmit(buildAnswers(questions, selections.value)) },
            enabled = canSubmit,
            shape = RoundedCornerShape(8.dp),
            contentPadding = PaddingValues(vertical = 6.dp, horizontal = 16.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(
                text = if (isSubmitting) "送信中..." else submitLabel,
                style = MaterialTheme.typography.labelLarge,
            )
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
private fun QuestionEntry(
    index: Int,
    question: AskQuestion,
    selected: Set<String>,
    onSelectionChange: (Set<String>) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        // header (chip 的役割) と質問本文を 1 行にまとめてコンパクトに。
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (question.header.isNotBlank()) {
                Text(
                    text = question.header,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                )
                androidx.compose.foundation.layout.Spacer(Modifier.size(6.dp))
            }
            Text(
                text = "Q${index + 1}. ${question.question}",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }

        question.options.forEach { opt ->
            OptionRow(
                option = opt,
                isSelected = selected.contains(opt.label),
                multiSelect = question.multiSelect,
                onClick = {
                    val newSet = if (question.multiSelect) {
                        if (selected.contains(opt.label)) selected - opt.label else selected + opt.label
                    } else {
                        setOf(opt.label)
                    }
                    onSelectionChange(newSet)
                },
            )
        }
    }
}

@Composable
private fun OptionRow(
    option: com.tachibanayu24.ccremote.data.AskQuestionOption,
    isSelected: Boolean,
    multiSelect: Boolean,
    onClick: () -> Unit,
) {
    // Row 全体に selectable/toggleable を当てて、 label tap でも radio/checkbox
    // が反応するようにする。 selectable は Role.RadioButton を持ち、
    // accessibility 表記とリップル挙動が単独 RadioButton と揃う。
    val rowModifier = if (multiSelect) {
        Modifier.toggleable(
            value = isSelected,
            onValueChange = { onClick() },
            role = Role.Checkbox,
        )
    } else {
        Modifier.selectable(
            selected = isSelected,
            onClick = onClick,
            role = Role.RadioButton,
        )
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(rowModifier)
            .padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (multiSelect) {
            Checkbox(checked = isSelected, onCheckedChange = null)
        } else {
            RadioButton(selected = isSelected, onClick = null)
        }
        Column(modifier = Modifier.padding(start = 4.dp)) {
            Text(
                option.label,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface,
            )
            if (option.description.isNotBlank()) {
                Text(
                    option.description,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
