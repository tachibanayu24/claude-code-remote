export type Bindings = {
  DB: D1Database
  SHARED_SECRET: string
  FCM_SERVICE_ACCOUNT_JSON: string
  FCM_PROJECT_ID: string
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
  cc_request_id?: string
}

export interface ApprovalRespondRequest {
  decision: 'allow' | 'deny'
  reason?: string
  device_id?: string
  add_to_allowlist?: boolean
}

export interface NotificationCreateRequest {
  session_id: string
  cwd: string
  project_name: string
  session_label?: string
  kind: 'completed' | string
  elapsed_ms?: number | null
  full_message?: string
}

export interface ApprovalRow {
  id: string
  status: string
  reason: string | null
  resolved_at: number | null
  resolved_by: string | null
  add_to_allowlist: number
}
