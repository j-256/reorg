#!/bin/bash
# Refuse to cut a release from a state that would produce a misleading tag.
#
# Two checks, deliberately: on main, and in sync with origin/main. A clean-tree
# check is absent on purpose -- `npm version` enforces that itself and does so
# before preversion runs, so a check here would be dead code. npm permits an
# untracked-only tree, which is harmless: its version commit names only
# package.json and package-lock.json, so nothing else can ride along.

set -u

RELEASE_BRANCH=main
REMOTE_REF="refs/remotes/origin/$RELEASE_BRANCH"

fail() {
  echo "preversion: $1" >&2
  exit 1
}

branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "$RELEASE_BRANCH" ] ||
  fail "releases come from $RELEASE_BRANCH, but you are on $branch"

# Compare against a fresh remote ref, not whatever was last fetched
git fetch --quiet origin "$RELEASE_BRANCH" ||
  fail "could not fetch origin/$RELEASE_BRANCH"

git rev-parse --verify --quiet "$REMOTE_REF" >/dev/null ||
  fail "origin/$RELEASE_BRANCH not found -- is the remote configured?"

local_head="$(git rev-parse "$RELEASE_BRANCH")"
remote_head="$(git rev-parse "$REMOTE_REF")"

[ "$local_head" = "$remote_head" ] ||
  fail "$RELEASE_BRANCH and origin/$RELEASE_BRANCH differ ($local_head vs $remote_head) -- push or pull first"
