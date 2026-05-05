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

export interface HookStopRequest {
  session_id: string
  cwd: string
  ai_title?: string
  elapsed_ms: number | null
  full_message?: string
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

export interface SessionHeartbeatRequest {
  session_id: string  // required — keying changed from cwd to session_id
  cwd: string
  ai_title?: string
  jsonl_mtime?: number  // ms epoch
  current_prompt?: string | null  // null clears, undefined leaves untouched
  current_assistant_text?: string | null  // partial assistant output for in-flight turn
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
  elapsed_ms: number | null
  ended_at: number
}

export interface PromptCreateRequest {
  text: string
}

export interface PromptRow {
  id: string
  session_id: string
  cwd: string
  text: string
  status: 'queued' | 'delivered'
  created_at: number
}

export interface ApprovalRow {
  id: string
  status: string
  resolved_at: number | null
  resolved_by: string | null
  add_to_allowlist: number | boolean
}
