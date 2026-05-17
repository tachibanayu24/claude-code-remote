#!/usr/bin/env node
// claude-code-remote: AskUserQuestion 用 PermissionRequest hook。
//
// CC が AskUserQuestion を発火すると PermissionRequest hook (= このスクリプト)
// が起動する。CC は hook の return を待たずに CLI dialog も並行で開く流儀
// なので、hook はその場で long-poll してスマホの answer を取りに行く。
//
// First responder wins:
//   - phone 先勝ち: /v1/questions/:id/wait が answers を返す → hook は
//                   decision.updatedInput.answers を JSON 出力。CC が CLI
//                   dialog を閉じて answers を採用。
//   - CLI 先勝ち : channel.mjs が JSONL 監視で tool_result を検出 →
//                   /v1/questions/:id/dismiss → wait が type:'dismissed' で
//                   抜ける。hook は何も出力せず exit (CC は CLI 応答を採用)。
//   - timeout    : 何も出力せず exit。CC は CLI dialog のまま残る。
//
// Spike で確定した CC の挙動:
//   - hook が `hookSpecificOutput.decision.updatedInput.answers` を返すと CLI
//     dialog は自動クローズして hook の answers が tool_result になる
//   - hook の return を待たずに CLI dialog は並行表示される
//   - hook が遅れて answers を返しても、CLI が早勝ちしていれば無視 (副作用なし)

import { readFileSync } from 'node:fs'
import { loadEnv } from './lib/env.mjs'
import { apiPost, isConfigured } from '../channel/lib/api.mjs'
import { getSessionLabel, readPpidSession } from '../channel/lib/session.mjs'
import { findPendingToolUseInJsonl, jsonlPath } from './lib/jsonl.mjs'

const log = (msg) => process.stderr.write(`cc-remote-aq: ${msg}\n`)

// hook 全体の budget。 settings.json の hook timeout より小さくする必要がある
// (CC が kill する前に自分で exit したい)。CC 側 timeout = 120s を想定。
const BUDGET_MS = 110_000
// /v1/questions/:id/wait 1 回あたりの max_ms。 backend は 25s で打ち切る。
const WAIT_CHUNK_MS = 20_000
const NETWORK_BUFFER_MS = 5_000

const startMs = Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (e) {
    log(`invalid stdin JSON: ${e.message}`)
    return {}
  }
}

// hook が何も返さず exit する path。CC は CLI dialog の user 応答に委ねる。
function exitSilent(reason) {
  if (reason) log(`silent exit: ${reason}`)
  process.exit(0)
}

const env = loadEnv(log)
if (!env || !isConfigured()) {
  exitSilent('config missing — relying on local dialog')
}

const input = await readStdin()
if (input?.tool_name !== 'AskUserQuestion') {
  // matcher が間違って他ツールを通した場合の保険。 何もせず通す。
  exitSilent(`unexpected tool_name=${input?.tool_name}`)
}

const questions = input?.tool_input?.questions
if (!Array.isArray(questions) || questions.length === 0) {
  exitSilent('no questions in tool_input')
}

// PermissionRequest hook input には tool_use_id が含まれないので、JSONL から
// 自前で引く (channel.mjs の早期 dismiss path と同じ流儀)。null のままでも
// long-poll は機能する — channel.mjs 側が JSONL 監視で tool_result を検出
// するための tool_use_id は backend に保存していないため、channel.mjs は
// session の pending questions を毎 wait loop で取り直す方式で運用する。
const sess = readPpidSession()
const sessionId = sess?.sessionId
const cwd = sess?.cwd ?? process.cwd()
if (!sessionId) {
  exitSilent('no sessionId (older CC?) — relying on local dialog')
}

// 質問のプレビュー文字列。channel.mjs の input_preview と対応する位置付け。
// JSONL の findPendingToolUse は input_preview をキーに引いてくるので、
// 質問の question 文字列を結合した形を渡す (channel.mjs 側は今回触らない
// が将来 tool_use_id 連動するならここを揃える)。
const inputPreview = questions.map((q) => q.question).join('\n')

const projectName = (cwd.split('/').pop() || 'unknown')

let questionId
try {
  const res = await apiPost('/v1/questions', {
    session_id: sessionId,
    cwd,
    project_name: projectName,
    session_label: getSessionLabel(),
    questions,
  })
  if (!res.ok) {
    log(`backend POST /v1/questions failed: HTTP ${res.status}`)
    exitSilent('backend create failed')
  }
  const json = await res.json()
  questionId = json.id
  const notifyAfterMs = Number(json.notify_after_ms) || 0
  // ask_delay > 0 のときは backend が即時 push をスキップ。 hook 側で
  // 遅延 /notify を仕掛ける (channel.mjs の approval と同じ流儀)。
  if (notifyAfterMs > 0) {
    setTimeout(() => {
      apiPost(`/v1/questions/${questionId}/notify`, {})
        .then((r) => { if (!r.ok) log(`/notify HTTP ${r.status}`) })
        .catch((e) => log(`/notify error: ${e.message ?? e}`))
    }, notifyAfterMs).unref?.()
  }
} catch (e) {
  log(`backend POST error: ${e.message ?? e}`)
  exitSilent('backend create error')
}

// `inputPreview` は将来 tool_use_id 連動のために残してあるが、現状は
// channel.mjs が session ベースで pending を引くので使わない。ESLint 用に参照。
void inputPreview

// Long-poll ループ。 hook の budget を超えない範囲で繰り返す。
while (true) {
  const elapsed = Date.now() - startMs
  const remaining = BUDGET_MS - elapsed
  if (remaining <= NETWORK_BUFFER_MS) {
    exitSilent('budget exhausted — relying on local dialog')
  }
  const maxMs = Math.min(WAIT_CHUNK_MS, remaining - NETWORK_BUFFER_MS)
  let data
  try {
    const r = await apiPost(
      `/v1/questions/${questionId}/wait?max_ms=${maxMs}`,
      {},
      AbortSignal.timeout(maxMs + NETWORK_BUFFER_MS),
    )
    if (!r.ok) {
      log(`/wait HTTP ${r.status}`)
      await sleep(1_000)
      continue
    }
    data = await r.json()
  } catch (e) {
    log(`/wait error: ${e.message ?? e}`)
    await sleep(1_000)
    continue
  }
  const ev = data.event
  if (!ev) continue  // timeout chunk — 次のループへ
  if (ev.type === 'dismissed') {
    exitSilent('dismissed (CLI early-resolve)')
  }
  if (ev.type === 'answers') {
    // CC は updatedInput を tool_input まるごとに上書きするので、 元の
    // tool_input フィールドを保持しつつ answers だけを足す。
    const updatedInput = { ...input.tool_input, answers: ev.answers }
    const response = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput },
      },
    }
    process.stdout.write(JSON.stringify(response))
    process.exit(0)
  }
  // 想定外 event type → silent exit
  log(`unexpected event type=${ev.type}`)
  exitSilent()
}
