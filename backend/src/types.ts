export type Bindings = {
  DB: D1Database
  SHARED_SECRET: string
  FCM_SERVICE_ACCOUNT_JSON: string
  FCM_PROJECT_ID: string
  STOP_THRESHOLD_MS?: string
}

export type FcmEnv = Pick<Bindings, 'FCM_SERVICE_ACCOUNT_JSON' | 'FCM_PROJECT_ID'>

export interface DeviceRegisterRequest {
  device_id: string
  fcm_token: string
  name?: string
}

export interface ApprovalCreateRequest {
  session_id: string  // required: which CC instance this prompt is for
  cwd?: string
  project_name: string
  session_label?: string
  tool_name: string
  description?: string
  input_preview?: string
  // channel.mjs が deriveAllowPattern で判定した「Always が有効か」フラグ。
  // backend 側は受け取って FCM / sessions レスポンスに転送するだけ。古い
  // channel.mjs が省略してきた場合は undefined → 互換のため true とみなす。
  supports_always?: boolean
}

export interface ApprovalRespondRequest {
  decision: 'allow' | 'deny'
  device_id?: string
  add_to_allowlist?: boolean
}

export interface ToolUsage {
  name: string
  count: number
}

/**
 * Ordered narration / tool-use blocks as they appear in CC's jsonl. Preserves
 * the interleave between text and tool calls so the phone can render them in
 * chronological order (matching the CLI), rather than batching all tools after
 * all text. `input` is the raw tool_use input from jsonl: Bash → {command},
 * Edit → {file_path, old_string, new_string}, MultiEdit → {edits: [...]}, etc.
 */
export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; name: string; input: Record<string, unknown> }

export interface HookStopRequest {
  session_id: string
  cwd: string
  ai_title?: string
  elapsed_ms: number | null
  blocks?: Block[]
  user_prompt?: string
  tool_summary?: ToolUsage[]
  // Dev-only: skip the FCM push and D1 insert; return what would have been sent.
  // Used by smoke tests so the phone doesn't get buzzed.
  dry_run?: boolean
}

export interface HookPosttoolRequest {
  session_id: string
  cwd: string
}

export interface SessionRow {
  session_id: string
  cwd: string
  project_name: string
  ai_title: string | null
  jsonl_mtime: number | null
  last_heartbeat: number
  current_prompt: string | null
  current_blocks: string | null  // JSON-encoded Block[]
}

export interface TurnRow {
  id: string
  user_prompt: string | null
  blocks: string | null  // JSON-encoded Block[]
  tool_summary: string | null  // JSON-encoded ToolUsage[]
  elapsed_ms: number | null
  ended_at: number
}

export interface PromptCreateRequest {
  text: string
}

export interface WaitRequest {
  session_id: string
  cwd: string
  ai_title?: string | null
  jsonl_mtime?: number | null
  current_prompt?: string | null
  current_blocks?: Block[] | null
  pending_request_ids?: string[]
}

export type WaitEvent =
  | { type: 'prompt'; id: string; text: string }
  | { type: 'verdict'; request_id: string; behavior: 'allow' | 'deny'; add_to_allowlist: boolean }

export interface SettingsRow {
  ask_delay_ms: number
  stop_threshold_ms: number
  updated_at: number
}

export interface SettingsUpdateRequest {
  ask_delay_ms?: number
  stop_threshold_ms?: number
}
