package com.tachibanayu24.ccremote.ui.code

import dev.snipme.highlights.model.SyntaxLanguage

/**
 * Map a code-block info string (` ```kotlin `) or a filename extension to a
 * Highlights `SyntaxLanguage`. Highlights only ships 17 languages, so common
 * ones like JSON / YAML / SQL / Markdown fall through to `null` (= plain
 * monospace, no coloring). The accepted aliases mirror what CC normally uses
 * in its narration, so a markdown ` ```ts ` block lights up the same as a
 * `.ts` file path coming through an Edit tool_call.
 */
fun resolveLanguage(hint: String?): SyntaxLanguage? {
    val key = hint?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
    return ALIAS_TO_LANGUAGE[key]
}

/** Pull the extension off `path/to/file.tsx` → `tsx`. */
fun extensionOf(filePath: String): String? = filePath
    .substringAfterLast('/', missingDelimiterValue = filePath)
    .substringAfterLast('.', missingDelimiterValue = "")
    .takeIf { it.isNotEmpty() }

private val ALIAS_TO_LANGUAGE: Map<String, SyntaxLanguage> = buildMap {
    fun put(lang: SyntaxLanguage, vararg aliases: String) {
        for (a in aliases) put(a, lang)
    }
    put(SyntaxLanguage.KOTLIN, "kotlin", "kt", "kts")
    put(SyntaxLanguage.JAVA, "java")
    put(SyntaxLanguage.TYPESCRIPT, "typescript", "ts", "tsx")
    put(SyntaxLanguage.JAVASCRIPT, "javascript", "js", "jsx", "mjs", "cjs")
    put(SyntaxLanguage.PYTHON, "python", "py")
    put(SyntaxLanguage.RUBY, "ruby", "rb")
    put(SyntaxLanguage.RUST, "rust", "rs")
    put(SyntaxLanguage.GO, "go")
    put(SyntaxLanguage.SWIFT, "swift")
    put(SyntaxLanguage.C, "c", "h")
    put(SyntaxLanguage.CPP, "cpp", "cc", "cxx", "hpp", "hxx", "c++")
    put(SyntaxLanguage.CSHARP, "csharp", "cs", "c#")
    put(SyntaxLanguage.DART, "dart")
    put(SyntaxLanguage.PHP, "php")
    put(SyntaxLanguage.PERL, "perl", "pl", "pm")
    put(SyntaxLanguage.COFFEESCRIPT, "coffee", "coffeescript")
    put(SyntaxLanguage.SHELL, "shell", "sh", "bash", "zsh")
}
