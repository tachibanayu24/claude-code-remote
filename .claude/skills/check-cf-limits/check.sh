#!/usr/bin/env bash
# Cloudflare 無料枠の利用状況を Workers Analytics + D1 Analytics 経由で取得。
# 出力: 人間向けサマリ (stdout) + JSON (--json 指定時)。
#
# 認証: wrangler の OAuth トークンを ~/Library/Preferences/.wrangler/config/default.toml から読む。
# トークン期限切れの場合は `npx wrangler whoami` を一度走らせて refresh させてから再実行。

set -euo pipefail

WORKER_NAME="${WORKER_NAME:-claude-code-remote}"
DB_NAME="${DB_NAME:-claude-code-remote}"
DB_ID="${DB_ID:-4c89f4b7-002c-4d4e-8a68-be23ea6a1f0f}"
ACCOUNT_ID="${ACCOUNT_ID:-2ed52fafd3387679d9b97beadf46abee}"

CONFIG="$HOME/Library/Preferences/.wrangler/config/default.toml"
if [[ ! -f "$CONFIG" ]]; then
  echo "ERROR: wrangler config not found at $CONFIG" >&2
  echo "Run: npx wrangler login" >&2
  exit 1
fi

TOKEN="$(awk -F'"' '/^oauth_token/ {print $2; exit}' "$CONFIG")"
if [[ -z "$TOKEN" ]]; then
  echo "ERROR: failed to extract oauth_token from $CONFIG" >&2
  exit 1
fi

OUTPUT_JSON=0
if [[ "${1:-}" == "--json" ]]; then
  OUTPUT_JSON=1
fi

# ------ Workers analytics (last 24h, rolling) ------
SINCE=$(date -u -v-1d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%SZ)
UNTIL=$(date -u +%Y-%m-%dT%H:%M:%SZ)

WORKERS_QUERY=$(cat <<EOF
{"query":"query { viewer { accounts(filter: {accountTag: \"$ACCOUNT_ID\"}) { workersInvocationsAdaptive(filter: {datetime_geq: \"$SINCE\", datetime_leq: \"$UNTIL\", scriptName: \"$WORKER_NAME\"}, limit: 10) { sum { requests subrequests errors } quantiles { cpuTimeP50 cpuTimeP99 durationP50 durationP99 } } } } }"}
EOF
)
WORKERS_RAW="$(curl -fsS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/graphql" -d "$WORKERS_QUERY")"

# ------ Workers analytics (last 7 days, daily) ------
SINCE7=$(date -u -v-7d +%Y-%m-%d 2>/dev/null || date -u -d '7 days ago' +%Y-%m-%d)
UNTIL7=$(date -u +%Y-%m-%d)
WORKERS7_QUERY=$(cat <<EOF
{"query":"query { viewer { accounts(filter: {accountTag: \"$ACCOUNT_ID\"}) { workersInvocationsAdaptive(filter: {date_geq: \"$SINCE7\", date_leq: \"$UNTIL7\", scriptName: \"$WORKER_NAME\"}, limit: 100, orderBy: [date_ASC]) { sum { requests errors } quantiles { cpuTimeP99 } dimensions { date } } } } }"}
EOF
)
WORKERS7_RAW="$(curl -fsS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/graphql" -d "$WORKERS7_QUERY")"

# ------ D1 analytics (last 7 days, daily for our DB) ------
D1_QUERY=$(cat <<EOF
{"query":"query { viewer { accounts(filter: {accountTag: \"$ACCOUNT_ID\"}) { d1AnalyticsAdaptiveGroups(filter: {date_geq: \"$SINCE7\", date_leq: \"$UNTIL7\", databaseId: \"$DB_ID\"}, limit: 100, orderBy: [date_ASC]) { sum { readQueries writeQueries rowsRead rowsWritten } dimensions { date } } } } }"}
EOF
)
D1_RAW="$(curl -fsS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/graphql" -d "$D1_QUERY")"

# ------ D1 info (storage size) ------
D1_INFO_JSON="$(cd "${BACKEND_DIR:-$HOME/Workspace/tachibanayu24/claude-code-remote/backend}" 2>/dev/null && npx --silent wrangler d1 info "$DB_NAME" --json 2>/dev/null || echo '{}')"

# ------ Aggregate via python ------
python3 - "$OUTPUT_JSON" <<PYEOF
import json, sys, datetime, os

output_json = int(sys.argv[1]) == 1

workers = json.loads('''$WORKERS_RAW''')
workers7 = json.loads('''$WORKERS7_RAW''')
d1 = json.loads('''$D1_RAW''')
d1info = json.loads('''$D1_INFO_JSON''')

def deep(obj, *path, default=None):
  cur = obj
  for p in path:
    if cur is None: return default
    if isinstance(cur, list):
      cur = cur[p] if p < len(cur) else default
    else:
      cur = cur.get(p, default)
  return cur if cur is not None else default

w24 = deep(workers, "data", "viewer", "accounts", 0, "workersInvocationsAdaptive", 0, default={})
w24_sum = w24.get("sum", {})
w24_q = w24.get("quantiles", {})

w7_rows = deep(workers7, "data", "viewer", "accounts", 0, "workersInvocationsAdaptive", default=[])
d1_rows = deep(d1, "data", "viewer", "accounts", 0, "d1AnalyticsAdaptiveGroups", default=[])

# free tier limits
LIMITS = {
  "workers_req_per_day": 100_000,
  "workers_cpu_ms_per_req": 10,
  "d1_rows_read_per_day": 5_000_000,
  "d1_rows_written_per_day": 100_000,
  "d1_storage_gb": 5,
}

def pct(value, limit):
  if not limit: return 0
  return value / limit * 100

def warn(p):
  if p >= 100: return "OVER"
  if p >= 80: return "WARN"
  if p >= 50: return "WATCH"
  return "OK"

# Today is the last entry typically; use it as "today so far"
today_workers = w7_rows[-1] if w7_rows else {}
today_d1 = d1_rows[-1] if d1_rows else {}

result = {
  "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
  "worker_name": "$WORKER_NAME",
  "database_id": "$DB_ID",
  "rolling_24h": {
    "workers_requests": w24_sum.get("requests", 0),
    "workers_errors": w24_sum.get("errors", 0),
    "workers_subrequests": w24_sum.get("subrequests", 0),
    "workers_cpu_p50_us": w24_q.get("cpuTimeP50"),
    "workers_cpu_p99_us": w24_q.get("cpuTimeP99"),
    "workers_duration_p99_s": w24_q.get("durationP99"),
  },
  "daily_history": {
    "workers": [
      {"date": deep(r, "dimensions", "date"),
       "requests": deep(r, "sum", "requests", default=0),
       "errors": deep(r, "sum", "errors", default=0),
       "cpu_p99_us": deep(r, "quantiles", "cpuTimeP99")}
      for r in w7_rows
    ],
    "d1": [
      {"date": deep(r, "dimensions", "date"),
       "read_queries": deep(r, "sum", "readQueries", default=0),
       "write_queries": deep(r, "sum", "writeQueries", default=0),
       "rows_read": deep(r, "sum", "rowsRead", default=0),
       "rows_written": deep(r, "sum", "rowsWritten", default=0)}
      for r in d1_rows
    ],
  },
  "d1_storage": d1info,
  "limits": LIMITS,
}

if output_json:
  print(json.dumps(result, indent=2))
  sys.exit(0)

# Human-readable
def line(label, value, limit, unit=""):
  p = pct(value, limit)
  status = warn(p)
  return f"  {label:30s} {value:>12,}{unit} / {limit:>11,}{unit} ({p:5.1f}%) [{status}]"

print(f"# Cloudflare 無料枠チェック  ({result['checked_at']})")
print()
print(f"## Workers ({result['worker_name']}) — 直近 24h")
print(line("Requests", result["rolling_24h"]["workers_requests"], LIMITS["workers_req_per_day"]))
print(f"  CPU time P50/P99             {result['rolling_24h']['workers_cpu_p50_us']:>6} / {result['rolling_24h']['workers_cpu_p99_us']:>6} μs (limit: {LIMITS['workers_cpu_ms_per_req']}ms/req)")
print(f"  Errors                       {result['rolling_24h']['workers_errors']:>12,}")
print(f"  Duration P99                 {result['rolling_24h']['workers_duration_p99_s']:>12.3f} s")

print()
print(f"## D1 — 直近 24h (from wrangler d1 info)")
if d1info:
  for k in ("read_queries_24h", "write_queries_24h", "rows_read_24h", "rows_written_24h", "database_size"):
    if k in d1info:
      print(f"  {k:30s} {d1info[k]}")

print()
print(f"## 過去 7 日 (worker daily)")
print(f"  {'date':12s} {'requests':>10s} {'errors':>7s} {'cpu_p99(μs)':>12s} {'%/day':>7s}")
for r in result["daily_history"]["workers"]:
  p = pct(r["requests"], LIMITS["workers_req_per_day"])
  mark = "⚠" if p > 100 else (" " if p < 50 else "·")
  print(f"  {r['date']:12s} {r['requests']:>10,} {r['errors']:>7,} {str(r['cpu_p99_us']):>12s} {p:>6.1f}% {mark}")

print()
print(f"## 過去 7 日 (D1 daily, db={result['database_id'][:8]}…)")
print(f"  {'date':12s} {'rRead':>8s} {'rWrite':>8s} {'rowsRead':>10s} {'rowsWrt':>10s} {'%write/day':>11s}")
for r in result["daily_history"]["d1"]:
  p = pct(r["rows_written"], LIMITS["d1_rows_written_per_day"])
  mark = "⚠" if p > 100 else (" " if p < 50 else "·")
  print(f"  {r['date']:12s} {r['read_queries']:>8,} {r['write_queries']:>8,} {r['rows_read']:>10,} {r['rows_written']:>10,} {p:>10.1f}% {mark}")

print()
print(f"## 凡例")
print(f"  OK <50% / WATCH 50-80% / WARN 80-100% / OVER >100%")
PYEOF
