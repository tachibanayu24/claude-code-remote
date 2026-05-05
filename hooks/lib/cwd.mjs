// CC encodes a project's cwd into a directory name under
// `~/.claude/projects/` by replacing path separators (`/`) and dots (`.`)
// with hyphens. We mirror that exactly so the jsonl path lookup works.
//
// This collides for paths like `/foo.bar` vs `/foo/bar` (both → `-foo-bar`),
// but the collision exists in CC itself — diverging here would just make us
// fail to find files that CC creates. The hook's fallback `readdirSync` scan
// covers the rare clash.
export function encodeCwd(cwd) {
  return cwd.replace(/[\/.]/g, '-')
}
