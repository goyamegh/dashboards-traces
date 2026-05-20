---
name: create-pr
description: >
  Create a pull request for Agent Health following all compliance requirements.
  Use after implementing a feature or fix. Handles SPDX headers, DCO signoff,
  CHANGELOG, and the PR template.
---

# Create Pull Request for Agent Health

You are helping the user create a compliant PR for the Agent Health project.

## Pre-flight Checks

Run these before creating the PR:

### 1. Build & Tests
```bash
npm run build:all && npm run test:all
```
Must pass. Never use `--no-verify`.

### 2. SPDX License Headers
Every new `.ts`, `.tsx`, `.js` source file needs:
```
/* Copyright OpenSearch Contributors
 SPDX-License-Identifier: Apache-2.0 */
```

Check for missing headers:
```bash
grep -rL 'SPDX-License-Identifier' src/ cli/ server/ services/ --include='*.ts' --include='*.tsx'
```

### 3. DCO Signoff
Every commit needs `Signed-off-by:` line:
```bash
git log --format='%H %s' origin/main..HEAD | while read hash msg; do
  git log -1 --format='%b' $hash | grep -q 'Signed-off-by:' || echo "MISSING: $hash $msg"
done
```

Fix missing signoff (for last commit):
```bash
git commit --amend -s --no-edit
```

### 4. CHANGELOG.md
Add entry under `## [Unreleased]` in the appropriate section:
- `### Added` — new features
- `### Fixed` — bug fixes
- `### Changed` — modifications to existing features
- `### Removed` — removed features

Format: `- Description of change ([#PR](link))`

## Create the PR

```bash
gh pr create --title "<type>: <concise description>" --body "$(cat <<'EOF'
## Summary
- <bullet 1>
- <bullet 2>

## Test plan
- [ ] Unit tests added/updated
- [ ] `npm run build:all && npm run test:all` passes
- [ ] Manual verification: <describe what to check>

EOF
)"
```

### Title Conventions
- `feat:` — new feature
- `fix:` — bug fix
- `refactor:` — code restructuring (no behavior change)
- `docs:` — documentation only
- `test:` — test additions/changes
- `chore:` — maintenance tasks

Keep title under 70 characters.

## After PR Creation

- CI will run: tests, coverage, DCO check, changelog check, link checker
- Address review feedback with new commits (don't force-push unless asked)
- Ensure all CI checks pass before requesting re-review
