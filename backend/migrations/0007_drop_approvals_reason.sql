-- `reason` was a placeholder column from 0001 that no code path ever read or
-- wrote. SQLite 3.35+ (D1 runs ≥ 3.43) supports DROP COLUMN, so reclaim the
-- space and let the type system stop tracking a dead field.
ALTER TABLE approvals DROP COLUMN reason;
