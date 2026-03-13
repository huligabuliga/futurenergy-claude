---
name: futureenergy-git
description: |
  Git workflow conventions for the FutureEnergy monorepo (Frontend + Backend).
  Covers branch naming, commit messages, PR creation, and merge targets.

  Use when: creating branches, writing commits, opening PRs, or reviewing
  git workflow in FutureEnergy-Frontend or FutureEnergy-Backend repos.
---

# FutureEnergy Git Workflow

## Repository Layout

Two independent git repos under one parent directory:

| Repo | Stack | Default Branch | PR Target |
|------|-------|----------------|-----------|
| `FutureEnergy-Frontend/` | Flutter/Dart | `dev` | `dev` |
| `FutureEnergy-Backend/` | NestJS/Prisma | `develop` | `develop` |

GitHub org: `huligabuliga`

IMPORTANT: The PR base branch differs between repos. Frontend merges to `dev`, backend merges to `develop`.

## Branch Naming

Format: `<type>/<short-description>`

```
feature/google-places-autocomplete
fix/onboarding-redirect
refactor/dialog-components
hotfix/finance-decimal-values
```

### Rules
- Lowercase with hyphens (no underscores, no spaces)
- Type prefix is required: `feature/`, `fix/`, `refactor/`, `hotfix/`, `chore/`
- Keep description to 3-5 words max
- No dates in branch names (use commit timestamps)
- For developer-specific branches: `<developer>/feature-name` (e.g., `adrianfeature/fixes-ui`)

### Avoid
- `Feature/` (capital F) -- use lowercase `feature/`
- Generic names like `fixes`, `updates`, `mega-update`
- Date suffixes like `feature/ui-improvements-2026-02-05-final`

## Commit Messages

Format: `<type>: <description>`

```
feat: implement Google Places autocomplete field
fix: correct onboarding redirect for incomplete addresses
refactor: consolidate preset wizard screens
revert: remove proposal document management feature
chore: clean up deprecated test scripts
```

### Types
- `feat:` -- new feature or capability
- `fix:` -- bug fix
- `refactor:` -- code restructuring without behavior change
- `revert:` -- reverting a previous change
- `chore:` -- maintenance, cleanup, dependencies
- `docs:` -- documentation only

### Optional scope
Use `(<scope>):` for targeted changes:
```
feat(pdf): add A3/A5 format support
fix(auth): handle expired refresh tokens
feat(templates): add clone endpoint for system templates
```

### Rules
- Lowercase after the colon
- Imperative mood ("add" not "added", "fix" not "fixes")
- No period at end
- First line under 72 characters
- Body (if needed) separated by blank line
- Co-author line when AI-assisted:
  ```
  Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
  ```

### Avoid
- Vague messages: "update", "fix bugs", "1st commit"
- Spanish-only messages in commit history (keep commits in English)
- Overly long single-line messages

## Pull Requests

### Creating a PR

Frontend (to `dev`):
```bash
cd FutureEnergy-Frontend
gh pr create --base dev --head <branch-name> \
  --title "<type>: <Short title under 70 chars>" \
  --body "$(cat <<'EOF'
## Summary
- <bullet points of what changed and why>

## Test plan
- [ ] <verification steps>

Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Backend (to `develop`):
```bash
cd FutureEnergy-Backend
gh pr create --base develop --head <branch-name> \
  --title "<type>: <Short title under 70 chars>" \
  --body "$(cat <<'EOF'
## Summary
- <bullet points of what changed and why>

## Test plan
- [ ] <verification steps>

Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

### PR Title
- Same format as commit messages: `<type>: <description>`
- Under 70 characters
- Examples:
  - `feat: Google Places autocomplete & address handling`
  - `fix: onboarding redirect for incomplete company addresses`
  - `refactor: consolidate preset wizard into single screen`

### PR Body
- `## Summary` with 1-3 bullet points covering the "why"
- `## Test plan` with checkboxes for manual verification
- Keep it concise -- reviewers read diffs, not essays

### Before Creating
1. Ensure branch is pushed: `git push -u origin <branch>`
2. Check no existing PR: `gh pr list --head <branch> --state open`
3. Verify correct base branch (`dev` for frontend, `develop` for backend)

## Typical Workflow

```bash
# 1. Start from the integration branch
git checkout dev          # frontend
git checkout develop      # backend
git pull origin <branch>

# 2. Create feature branch
git checkout -b feature/my-feature

# 3. Work, commit with conventional messages
git add <specific-files>
git commit -m "feat: add new capability"

# 4. Push and create PR
git push -u origin feature/my-feature
gh pr create --base dev --title "feat: add new capability" --body "..."
```

## Quick Reference

| Action | Frontend | Backend |
|--------|----------|---------|
| Base branch | `dev` | `develop` |
| PR target | `dev` | `develop` |
| Production branch | `main` | `main` |
| Branch format | `feature/name` | `feature/name` |
| Commit format | `feat: description` | `feat: description` |
