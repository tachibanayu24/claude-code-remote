#!/usr/bin/env node
// Spike: AskUserQuestion 用 PermissionRequest hook の挙動を実機検証する
// プローブ。
//
// 検証したいこと:
//   1. AskUserQuestion 発火時に PermissionRequest hook が本当に呼ばれるか
//   2. 受け取る JSON の構造 (tool_name, tool_input, permission_suggestions, ...)
//   3. updatedInput.answers を返した時、CC が回答として受理してターンが進むか
//   4. ローカルダイアログが閉じるか / 並列で出るか
//   5. PreToolUse / MCP channel notification と同時発火するか
//
// 環境変数:
//   CC_AQ_SPIKE_MODE      : log | answer  (デフォルト log)
//   CC_AQ_SPIKE_DELAY_MS  : 数値。設定されてれば start log 後に sleep してから
//                           (もしあれば) response を吐く。
// 組み合わせの意味:
//   log + delay 0      : CLI dialog がそのまま開く (= CC default)
//   answer + delay 0   : hook が即 answer を返し、CLI dialog 自体出ない
//   log + delay N      : N ms 待ってから何も返さず exit。CLI dialog は並行で
//                        開く (Phase B で確認済み)
//   answer + delay N   : N ms 待ってから answer を返す。dialog が並行で開いた
//                        後 hook が遅れて answer を返した時、dialog が閉じるか
//                        を観察するため (Phase C)
//
// ログ: /tmp/cc-aq-probe.jsonl に 1 行 1 イベント append
//   { ts, hook_event_name, tool_name, raw_input, response }

import { readFileSync, appendFileSync } from 'node:fs'

const LOG_PATH = '/tmp/cc-aq-probe.jsonl'
const MODE = process.env.CC_AQ_SPIKE_MODE || 'log'

function readStdinSync() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function logEvent(rec) {
  try {
    appendFileSync(LOG_PATH, JSON.stringify(rec) + '\n')
  } catch (e) {
    process.stderr.write(`[aq-probe] log write failed: ${e.message}\n`)
  }
}

const raw = readStdinSync()
let input = null
try { input = JSON.parse(raw) } catch {}

const hookEvent = input?.hook_event_name ?? '(unparsed)'
const toolName = input?.tool_name ?? '(unknown)'

// 第 1 問の 2 番目の選択肢 label を取り出す (answer モード用)
// 1 番目だと user が画面で押した結果と区別がつかないので、敢えて 2 番目を返す。
// もし user に見える結果が 2 番目なら hook 経由、1 番目なら hook 無視 (user の手押し)
// と確実に判定できる。
function buildAnswers(toolInput) {
  if (!toolInput?.questions?.length) return null
  const answers = {}
  for (const q of toolInput.questions) {
    if (q.multiSelect) {
      // 複数選択時は最初の 2 つを array で返す
      const labels = (q.options ?? []).slice(0, 2).map((o) => o.label).filter(Boolean)
      if (labels.length) answers[q.question] = labels
    } else {
      const target = q.options?.[1]?.label ?? q.options?.[0]?.label
      if (target != null) answers[q.question] = target
    }
  }
  return answers
}

let response = null

if (MODE === 'answer' && toolName === 'AskUserQuestion') {
  const answers = buildAnswers(input?.tool_input)
  const updatedInput = answers
    ? { ...input.tool_input, answers }
    : input?.tool_input

  if (hookEvent === 'PermissionRequest') {
    response = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput },
      },
    }
  } else if (hookEvent === 'PreToolUse') {
    // PreToolUse でも一応試す (Issue #15872 では効かないと報告)
    response = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput,
      },
    }
  }
}

const startTs = new Date().toISOString()
logEvent({
  ts: startTs,
  mode: MODE,
  phase: 'start',
  hook_event_name: hookEvent,
  tool_name: toolName,
  raw_input: input,
  response,
})

const delayMs = Number(process.env.CC_AQ_SPIKE_DELAY_MS ?? 0)
if (delayMs > 0) {
  await new Promise((r) => setTimeout(r, delayMs))
  logEvent({
    ts: new Date().toISOString(),
    mode: MODE,
    phase: 'wake',
    hook_event_name: hookEvent,
    tool_name: toolName,
    waited_ms: delayMs,
  })
}

if (response) {
  process.stdout.write(JSON.stringify(response))
}
process.exit(0)
