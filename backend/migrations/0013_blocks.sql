-- Order-preserving block list per turn / in-flight snapshot.
-- Replaces the parallel pair (assistant_text, tool_calls) which lost the
-- interleave between narration and tool invocations. Stored as a JSON-encoded
-- array: [{"kind":"text","text":"..."}, {"kind":"tool_use","name":"Bash","input":{...}}, ...]
-- Legacy columns are left in place but no longer written / read by new code.

ALTER TABLE turns ADD COLUMN blocks TEXT;
ALTER TABLE sessions ADD COLUMN current_blocks TEXT;
