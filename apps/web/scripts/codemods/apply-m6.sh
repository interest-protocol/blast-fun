#!/usr/bin/env bash
# OA-28 M6 on a newer tree: merge the branch's hand-written commits (the codemod
# itself, the cx mappers, the client-side zustand stores, the guide), then run the clsx
# codemod afresh instead of merging its old output, and check the result.
#
#   git checkout sfd/integration            # a clean checkout of the tree to land on
#   bash scripts/codemods/apply-m6.sh       # or: … --check-only   (merge test only, nothing kept)
#                                           #     … --branch <ref> (default oa28/m6-state-classnames)
#                                           #     … --full         (also npm test)
#
# The branch's tip is the codemod's output on the tree it was built on (its
# message carries "M6-Codemod: clsx output"); this script merges everything
# below it and regenerates that commit here, so the ~190 rewritten className
# lines never conflict with branches that landed since. A conflict in the
# hand-written commits stops the script, naming each file and the M6 commit
# that changed it. Then: npm run typecheck, lint, test and the database gates.
set -euo pipefail

branch="oa28/m6-state-classnames"
check_only=false
full=false
work="${TMPDIR:-/tmp}/m6-apply"
mkdir -p "$work"
while [ $# -gt 0 ]; do
  case "$1" in
    --branch) branch="$2"; shift 2 ;;
    --check-only) check_only=true; shift ;;
    --full) full=true; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

root="$(git rev-parse --show-toplevel)"
cd "$root"
say() { printf '\n== %s\n' "$*"; }

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "the working tree has changes; commit or set them aside first" >&2
  exit 2
fi
git rev-parse --verify --quiet "$branch^{commit}" > /dev/null || { echo "no such ref: $branch" >&2; exit 2; }
if ! git log -1 --format=%B "$branch" | grep -q '^M6-Codemod: clsx output'; then
  echo "$branch's tip is not the codemod output commit (no 'M6-Codemod: clsx output' line); refusing to guess" >&2
  exit 2
fi
hand="$(git rev-parse "$branch^")"
lock_before="$(sha1sum package-lock.json | cut -d' ' -f1)"

if git merge-base --is-ancestor "$hand" HEAD; then
  say "the hand-written M6 commits are already in this tree ($(git rev-parse --short "$hand"))"
  $check_only && exit 0
else
  say "merging the hand-written M6 commits ($(git rev-parse --short "$hand"), $(git rev-list --count HEAD.."$hand") commit(s) not yet here)"
  git log --reverse --format='  %h %s' HEAD.."$hand"
  if ! git merge --no-ff --no-commit "$hand" > /dev/null 2>&1; then
    echo
    echo "CONFLICTS — resolve and commit the merge, then run this script again (it carries on from there), or 'git merge --abort':"
    for file in $(git diff --name-only --diff-filter=U); do
      echo "  $file  — changed by: $(git log --format='%h %s' HEAD.."$hand" -- "$file" | head -3 | tr '\n' ';')"
    done
    exit 1
  fi
  if $check_only; then
    echo "merges cleanly; $(git diff --cached --name-only | wc -l) file(s) change"
    git merge --abort
    say "check only: nothing kept"
    exit 0
  fi
  git commit -q --no-edit -m "Integrate $branch (hand-written part): the clsx codemod, the cx mappers on clsx, the client-side zustand stores (OA-28 M6)"
  echo "merged as $(git rev-parse --short HEAD)"
fi


say "running the clsx codemod on this tree"
node --no-warnings --experimental-strip-types scripts/codemods/clsx.ts --write --report "$work/clsx-report.json" | tee "$work/clsx.log" | sed -n '1p;/^skipped/,$p'
say "running it again: it must find nothing left (idempotent)"
if ! node --no-warnings --experimental-strip-types scripts/codemods/clsx.ts --check > "$work/check.log"; then
  cat "$work/check.log"
  echo "a second run still converts sites: stop" >&2
  exit 1
fi
head -1 "$work/check.log"

say "the equivalence, codemod and store tests"
node --no-warnings --import ./scripts/test-tsx-hooks.mjs --test --experimental-strip-types \
  src/components/ui-libraries/clsx-equivalence.test.ts src/components/ui-libraries/clsx-codemod.test.ts src/components/ui-libraries/zustand-stores.test.tsx 2>&1 | grep -E '^(ℹ (tests|pass|fail)|✖)'

say "typecheck and lint"
npm run --silent typecheck
npm run --silent lint
if $full; then
  say "npm test"
  npm test 2>&1 | tail -12
fi

[ "$(sha1sum package-lock.json | cut -d' ' -f1)" = "$lock_before" ] || { echo "package-lock.json changed: stop" >&2; exit 1; }

converted="$(head -1 "$work/clsx.log")"
if git diff --quiet -- src scripts/codemods/clsx-shapes.json; then
  say "nothing left to convert on this tree: no commit"
  exit 0
fi
git add -u src scripts/codemods/clsx-shapes.json
git commit -q -m "OA-28 M6: run the clsx codemod on the merged tree

${converted}
Every converted shape is replayed by clsx-equivalence.test.ts (same classes,
same order; the same string wherever the old one had no stray spaces). Skipped
sites, with the reason, are in the codemod's report.

M6-Codemod: clsx output (regenerate with scripts/codemods/apply-m6.sh)"
say "done: $(git log -1 --format='%h %s')"
echo "report: $work/clsx-report.json (every site, converted or skipped with the reason)"
echo "next: npm test (unless --full), npm run test:integration, build"
