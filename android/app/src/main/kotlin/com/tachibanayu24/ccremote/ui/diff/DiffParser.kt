package com.tachibanayu24.ccremote.ui.diff

/**
 * One row of a unified diff. `oldLine` / `newLine` are 1-based line numbers
 * (null when this side has no number — i.e. an addition has no oldLine).
 */
sealed class DiffLine {
    abstract val text: String
    abstract val oldLine: Int?
    abstract val newLine: Int?

    data class Context(
        override val text: String,
        override val oldLine: Int,
        override val newLine: Int,
    ) : DiffLine()

    data class Add(
        override val text: String,
        override val newLine: Int,
    ) : DiffLine() {
        override val oldLine: Int? = null
    }

    data class Del(
        override val text: String,
        override val oldLine: Int,
    ) : DiffLine() {
        override val newLine: Int? = null
    }
}

/**
 * Line-level LCS diff. O(m*n) time and space — fine for the typical Edit
 * input (a few dozen lines). For pathological inputs we bail out to a
 * "delete everything old, then add everything new" rendering instead of
 * burning seconds on quadratic DP.
 */
private const val LCS_BUDGET = 300_000  // ~550×550 lines worth

fun computeDiff(oldString: String, newString: String): List<DiffLine> {
    val oldLines = if (oldString.isEmpty()) emptyList() else oldString.split('\n')
    val newLines = if (newString.isEmpty()) emptyList() else newString.split('\n')
    val m = oldLines.size
    val n = newLines.size
    if (m == 0 && n == 0) return emptyList()
    if (m == 0) return newLines.mapIndexed { i, t -> DiffLine.Add(t, i + 1) }
    if (n == 0) return oldLines.mapIndexed { i, t -> DiffLine.Del(t, i + 1) }
    if (m.toLong() * n > LCS_BUDGET) return bulkReplace(oldLines, newLines)

    // dp[i][j] = LCS length of oldLines[i..] vs newLines[j..]
    val dp = Array(m + 1) { IntArray(n + 1) }
    for (i in m - 1 downTo 0) {
        for (j in n - 1 downTo 0) {
            dp[i][j] = if (oldLines[i] == newLines[j]) {
                dp[i + 1][j + 1] + 1
            } else {
                maxOf(dp[i + 1][j], dp[i][j + 1])
            }
        }
    }

    val out = ArrayList<DiffLine>(m + n)
    var i = 0
    var j = 0
    var oldNum = 1
    var newNum = 1
    while (i < m && j < n) {
        when {
            oldLines[i] == newLines[j] -> {
                out += DiffLine.Context(oldLines[i], oldNum++, newNum++)
                i++; j++
            }
            // Tie-break: prefer DEL first when equal so the visual order is
            // "remove then add" — matches how humans read patches.
            dp[i + 1][j] >= dp[i][j + 1] -> {
                out += DiffLine.Del(oldLines[i], oldNum++)
                i++
            }
            else -> {
                out += DiffLine.Add(newLines[j], newNum++)
                j++
            }
        }
    }
    while (i < m) { out += DiffLine.Del(oldLines[i], oldNum++); i++ }
    while (j < n) { out += DiffLine.Add(newLines[j], newNum++); j++ }
    return out
}

private fun bulkReplace(oldLines: List<String>, newLines: List<String>): List<DiffLine> {
    val out = ArrayList<DiffLine>(oldLines.size + newLines.size)
    oldLines.forEachIndexed { idx, t -> out += DiffLine.Del(t, idx + 1) }
    newLines.forEachIndexed { idx, t -> out += DiffLine.Add(t, idx + 1) }
    return out
}
