#!/usr/bin/env bash
# Interactive release cutter: bumps package.json's version, commits, tags,
# pushes, and publishes a GitHub release — the steps described in
# CLAUDE.md's "Versioning and updates" section, done by hand until now.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
die() { echo "${RED}error:${RESET} $*" >&2; exit 1; }

command -v gh >/dev/null 2>&1 || die "gh (GitHub CLI) is required but not found in PATH."
gh auth status >/dev/null 2>&1 || die "gh is not authenticated — run 'gh auth login' first."

[[ -z "$(git status --porcelain)" ]] || die "working tree is dirty — commit or stash your changes first."

branch="$(git branch --show-current)"
if [[ "$branch" != "main" ]]; then
  echo "${YELLOW}warning:${RESET} you are on '${branch}', not 'main'."
  read -r -p "Continue anyway? [y/N] " confirm_branch
  [[ "$confirm_branch" =~ ^[Yy]$ ]] || die "aborted."
fi

echo "Fetching latest tags..."
git fetch origin --tags --quiet
git fetch origin "$branch" --quiet
local_head="$(git rev-parse HEAD)"
remote_head="$(git rev-parse "origin/$branch" 2>/dev/null || echo "")"
[[ "$local_head" == "$remote_head" ]] || die "local '$branch' is not in sync with 'origin/$branch' — pull/push first."

current_version="$(node -p "require('./package.json').version")"
echo "Current version: ${BOLD}${current_version}${RESET}"

echo
echo "What kind of release is this?"
select bump in "major" "minor" "patch (fix)"; do
  case "$REPLY" in
    1) bump_type="major"; break ;;
    2) bump_type="minor"; break ;;
    3) bump_type="patch"; break ;;
    *) echo "Pick 1, 2, or 3." ;;
  esac
done

echo
echo "Enter a description of this release (used as the tag annotation and"
echo "GitHub release notes). Finish with an empty line:"
notes=""
while IFS= read -r line; do
  [[ -z "$line" ]] && break
  notes+="${line}"$'\n'
done
notes="$(printf '%s' "$notes" | sed -e '$a\')"
[[ -n "$(printf '%s' "$notes" | tr -d '[:space:]')" ]] || die "a description is required."

new_version="$(npm --no-git-tag-version version "$bump_type" | tail -1 | sed 's/^v//')"
tag="v${new_version}"

echo
echo "${BOLD}About to release:${RESET}"
echo "  ${current_version} -> ${new_version}  (${bump_type})"
echo "  tag:    ${tag}"
echo "  branch: ${branch}"
echo "  notes:"
printf '%s\n' "$notes" | sed 's/^/    /'
read -r -p "Proceed? [y/N] " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  git checkout -- package.json package-lock.json 2>/dev/null || true
  die "aborted — version bump reverted."
fi

git add package.json package-lock.json
git commit -m "Release ${new_version}"
git tag -a "$tag" -m "$notes"

echo "Pushing commit and tag..."
git push origin "$branch"
git push origin "$tag"

echo "Creating GitHub release..."
gh release create "$tag" --title "$tag" --notes "$notes"

echo
echo "${GREEN}Released ${tag}.${RESET}"
