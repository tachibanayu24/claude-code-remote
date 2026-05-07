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

export interface ToolCall {
  name: string
  // Free-form: passed through from CC's jsonl. Bash → {command}, Edit →
  // {file_path, old_string, new_string}, MultiEdit → {file_path, edits: [...]},
  // Read/Glob → {file_path or pattern}, etc. Stored as JSON in turns.tool_calls.
  input: Record<string, unknown>
}

export interface HookStopRequest {
  session_id: string
  cwd: string
  ai_title?: string
  elapsed_ms: number | null
  full_message?: string
  user_prompt?: string
  tool_summary?: ToolUsage[]
  tool_calls?: ToolCall[]
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
  current_assistant_text: string | null
}

export interface TurnRow {
  id: string
  user_prompt: string | null
  assistant_text: string | null
  tool_summary: string | null  // JSON-encoded ToolUsage[]
  tool_calls: string | null  // JSON-encoded ToolCall[]
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
  current_assistant_text?: string | null
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
