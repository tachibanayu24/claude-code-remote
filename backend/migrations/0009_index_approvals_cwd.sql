-- dismissPendingApprovals queries `WHERE status='pending' AND cwd=?`. The
-- existing `(status, created_at)` index can answer the status filter but
-- still scans every pending row across all cwds. Adding `(cwd, status)`
-- narrows the lookup to the right project immediately.
CREATE INDEX IF NOT EXISTS idx_approvals_cwd_status ON approvals(cwd, status);
