import type { Bindings, SettingsRow } from './types'

const DEFAULTS = { ask_delay_ms: 10_000, stop_threshold_ms: 180_000 } as const

/**
 * Read the single-row settings table. Falls back to defaults when the row is
 * missing — the migration seeds it, but a fresh DB without migration applied
 * shouldn't 500 on every notification path.
 */
export async function readSettings(env: Bindings): Promise<SettingsRow> {
  try {
    const row = await env.DB
      .prepare('SELECT ask_delay_ms, stop_threshold_ms, updated_at FROM settings WHERE id = 1')
      .first<SettingsRow>()
    if (row) return row
  } catch (_) {
    // table missing in dev: fall through to defaults
  }
  // Legacy fallback: respect the env-based threshold if it's set, so existing
  // deployments keep their tuned value until the row is created.
  const envThreshold = Number.parseInt(env.STOP_THRESHOLD_MS ?? '', 10)
  return {
    ask_delay_ms: DEFAULTS.ask_delay_ms,
    stop_threshold_ms: Number.isFinite(envThreshold) ? envThreshold : DEFAULTS.stop_threshold_ms,
    updated_at: 0,
  }
}
