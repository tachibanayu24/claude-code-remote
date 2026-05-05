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
  session_id?: string
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

export interface HookStopRequest {
  session_id: string
  cwd: string
  ai_title?: string
  elapsed_ms: number | null
  full_message?: string
  // Dev-only: skip the FCM push and D1 insert; return what would have been sent.
  // Used by smoke tests so the phone doesn't get buzzed.
  dry_run?: boolean
}

export interface HookPosttoolRequest {
  cwd: string
}

export interface ApprovalRow {
  id: string
  status: string
  resolved_at: number | null
  resolved_by: string | null
  add_to_allowlist: number
}
