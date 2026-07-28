# reorg

Reorganize a messy directory by dragging it into shape, then apply the plan with one command – and an undo script.

```
npx reorg-cli ~/Downloads
```

That scans the directory, opens a planner in your browser, and prints a URL. Drag folders around, rename things, mark junk for trash. Nothing touches disk until you say so.

![The planner mid-edit: a new folder, two moves, two entries marked for trash](docs/planner.png)

No runtime dependencies, no build step, no config file. One Node script and a page.

## Why

Cleaning up a directory is two jobs that get tangled together: *deciding* what the shape should be, and *executing* a pile of `mv` commands without breaking anything. Doing both at once in a terminal means you lose the plan halfway through, or you discover the conflict after the third move.

reorg splits them. You do all the deciding in a view where the whole tree is visible and every change is reversible with a keystroke. When the shape looks right, the tool works out the operations – in a correct order, with collisions caught up front – and executes them as one checked batch that it can also undo.

It is useful for a `~/Downloads` that got away from you, a repo whose layout no longer matches how you think about it, or a scratch directory you have been meaning to triage for a year.

## Install

Nothing to install: `npx reorg-cli <dir>` runs it, and installs the command as `reorg`. Or clone and link it:

```bash
git clone https://github.com/j-256/reorg
cd reorg && npm link      # then: reorg <dir>
```

Requires Node 22 or newer – the oldest release still receiving security updates. There are no runtime dependencies: `package.json` has an empty `dependencies` block and that is deliberate.

## Tests

```bash
npm test        # no install needed -- runs on a bare checkout
npm run test:ui # browser tests; needs `npm ci` and a Chromium
npm run test:all
```

`npm test` needs nothing installed, deliberately: it covers the scanner, the plan resolver, the apply engine and its undo scripts, the triage signals, the server's access control, and the browser-side plan model, all under `node --test` with nothing fetched.

`npm run test:ui` drives the real page in a real Chromium, which is the only way to cover what a fake DOM cannot: drop-zone geometry is computed from the pointer's position against a row's box, and jsdom reports every box as zero-sized. It also runs a WCAG AA contrast sweep over both themes. Playwright is the one dependency in the repo and it is confined to `devDependencies`:

```bash
npm ci && npx playwright install chromium
```

## Using it

| Command | What it does |
|---|---|
| `reorg [dir]` | scan, serve the planner, open a browser |
| `reorg plan [dir]` | print the current plan as operations |
| `reorg apply [dir]` | dry run: print what would happen, change nothing |
| `reorg apply [dir] --yes` | apply, writing an undo script first |
| `reorg undo [dir]` | run the most recent undo script |
| `reorg status [dir]` | what is planned, applied, and undoable |
| `reorg summarize [dir]` | one-line AI description per file (see below) |
| `reorg triage [dir]` | rank likely-disposable entries and say why |

In the planner:

- **drag** a row onto a folder's middle to move *into* it; onto the top or bottom edge to become a sibling. Drop below the tree to move to the top level.
- **double-click** or `F2` to rename in place.
- **`Delete`** marks for trash. Folders take their contents with them.
- **`n`** makes a new folder inside the selection; **`N`** attaches a note.
- **`Space`** previews a file (first 100 lines, read on demand).
- **`/`** jumps to the filter box; wrap the query in slashes for a regex (`/\.log$/`).
- **`?`** lists every key.

Toolbar toggles persist in the plan, so the view you set up is the view you come back to: **git** tints rows by git status, **heat** draws a size bar on each row, and **theme** cycles `auto` (follow the system) through forced `dark` and `light`.

Sibling order is *derived* (folders first, then natural sort), never stored. Dragging something out of a folder and back is a genuine no-op rather than a phantom "reordered" change.

## Safety

Applying a reorganization is the part that can ruin your afternoon, so the plan is always shown as the exact operations it resolves to, in order, before anything runs:

![Review panel listing the resolved operations in order, with a dry-run button](docs/review.png)

- **Dry run is the default.** `reorg apply` prints and exits. Only `--yes` moves anything. The browser cannot apply at all unless you started it with `--allow-apply`.
- **Nothing is deleted.** "Trash" moves into `.reorg/trash/<run>/`. Emptying that is a separate decision you make yourself.
- **Drift aborts the whole batch.** Every source path is checked to still exist and every destination to be free *before* the first move. If the tree changed since the scan, nothing is applied – not "nothing further", nothing at all.
- **An undo script is written before execution starts**, so even a crash mid-run leaves a way back. It is guarded per step, so running it after a partial apply undoes only what happened.
- **Collisions are caught at plan time**, not discovered at move time: two entries landing on one path, a folder marked for trash that still holds things you kept, a folder dragged inside itself.
- **`git mv` for tracked files**, so history follows the move. (Git refuses this on a fully-untracked directory; reorg falls back to a plain rename there.)
- **Rename cycles work.** Swapping two names is impossible with direct renames in any order, so reorg routes cycle members through a staging directory instead of failing.

Your plan lives in `.reorg/plan.json`, which is a diff against the scan rather than a copy of the tree. `.reorg/` git-ignores itself on creation, so planning a repo's layout never dirties that repo.

## File summaries

Half of triage is remembering what a file *is*. `reorg summarize` labels each one with a single line – "nightly S3 sync of /var/data", not "a shell script" – and the planner shows it inline next to the filename.

Two ways to get them, and the default needs no API key:

```bash
# Agent path: writes a prompt pack, your coding agent fills it in. Free.
reorg summarize ~/Downloads          # -> .reorg/summarize.md + summaries.json
#   ...point Claude Code (or any agent) at that markdown file...
reorg summarize --ingest ~/Downloads

# API path: calls the Messages API directly. Needs a key.
ANTHROPIC_API_KEY=sk-... reorg summarize ~/Downloads
```

The API path batches files (about a dozen per request), sends only the first few KB of each, skips binaries and empty files, and defaults to Haiku because this is a classification job. Override with `--model`. It uses `fetch` against the documented HTTP API – no SDK dependency.

Summaries are stored in the plan and keyed by path, so they survive a rescan.

## Triage: what looks disposable

`reorg triage` ranks entries that look like junk and says why, so a directory that has got away from you starts with a shortlist instead of a scroll. The same list is in the planner behind the **triage** button, where each row has a mark-for-trash button.

![Triage panel: each candidate carries the signals that flagged it and a plain-language reason](docs/triage.png)

**It ranks names and structure, not age.** That is the opposite of the obvious design, and it is deliberate: a name is frequently a direct statement of intent – someone wrote "backup" or "dryrun" because that is what the thing was for – where mtime turns out to predict almost nothing. The signals are:

| Signal | Why |
|---|---|
| an archive beside its unpacked copy | pure duplication; one of the two is redundant |
| a name ending in `backup`/`dryrun`/`tmp`/`presync`/... | the name states it was a safety copy |
| installer (`.dmg`, `.pkg`, `.msi`) | re-downloadable, dead weight once installed |
| scratch extension (`.log`, `.bak`, `.crdownload`) | a byproduct, not something authored |
| a bare `.git` clone | a mirror kept as a one-off safety copy |
| bulky | worth a decision purely for what it costs to keep |

Position matters, because the same word can name a subject rather than a status. Only trailing markers count, and the screenshot above shows both sides of that: `project-backup-20260415` is flagged, while `backup-strategy-notes.md` and `all-mail-including-spam-and-trash.mbox` sit in the same tree untouched – one is a document *about* backups, the other is 2.9 GB of actual mail. Both of those were real false positives before the position rule went in, and flagging 3 GB of someone's mail as trash is how a suggestion list loses its reader.

Emptiness is deliberately not a signal: empty directories are often intentional (mount points, placeholders) and cost nothing to keep.

### Why age is not a signal

Look at the ages the triage panel prints above: every flagged candidate is *recent* – 3, 12, 34 days. Nothing there is old, because in a directory that got away from you the junk is usually the newest thing in it. Sorting by mtime would push all six candidates to the bottom.

That inversion is why the ranking works the way it does, and it is not invented for the screenshot. Measured against a real long-neglected scratch directory:

- The clearly-disposable entries – a `-backup-20260425` directory, a `.zip` still sitting beside its unpacked copy, a downloaded `.dmg` – had ages spanning 12 to 586 days, so age separated them from nothing. Seven of eight `-backup-`/`-dryrun-` directories were all *12 days old*: an age sort would have called them active work.
- What age surfaced at the top instead were keepers – an example image kept on purpose for two years, a reference screenshot, a script still in use.

Age is still shown on every row, for context. It is just never what sorts them.

## How the plan becomes operations

Worth knowing, because it explains why the output looks the way it does.

Every entry has a stable id (its path at scan time) and two positions: the frozen original and the live one you edit. The diff between them is the plan. Resolving it produces operations in dependency order:

1. **`mkdir`** for folders you invented, shallowest first.
2. **`mv`**, but only for entries whose *own* position changed. Moving `a/` to `b/a/` relocates everything inside it implicitly – emitting a second move for `a/x` would fail, because by then its source is gone. Destinations are final-tree paths, so each entry moves once.
3. **`trash`** last, at each entry's post-move location.

Move ordering is a topological sort over two constraints: vacate before occupy (if X lands where Y still is, Y goes first), and parent before child (if X lands inside where Y is going, Y arrives first). A cycle between them means no order works, which is when staging kicks in.

`reorg plan` prints exactly this list, and the planner's **review** panel shows the same thing before you apply.

## Layout

```
bin/reorg          CLI: scan, serve, plan, apply, undo, summarize, status
src/scan.js        walk a directory, tag git status, summarize collapsed dirs
src/plan.js        pure resolver: plan -> ordered operations (no fs, no exec)
src/apply.js       execute, with drift checks, git mv, trash, undo script
src/summarize.js   Messages API batching + the no-key agent prompt pack
src/signals.js     cleanup signals: what looks disposable, and why (name, not age)
src/server.js      stdlib http server, token-gated JSON API
src/state.js       .reorg/plan.json load, save, self-ignore
web/               the planner: tree, drag and drop, preview, review
test/              unit tests for the resolver, integration tests on real temp dirs
```

`src/plan.js` is deliberately pure so the risky decisions are testable without a filesystem. The integration tests do the opposite – real directories, real git repos, real `bash undo-*.sh` round trips – because a resolver that is right on paper and wrong on disk is worthless.

```bash
npm test
```

## The server

<!-- Keep the traversal example off `../../etc/`. npm sends this README to the
     registry as plaintext, and the WAF in front of registry.npmjs.org rejects
     that path as an attack signature -- npm then reports the block as a generic
     E403 that names no cause. See ## Releasing. -->

`reorg` serves on loopback with a per-run token in the URL. That is not theatre: the API can read file contents and, with `--allow-apply`, move files. A token means another process on the machine, or a stray browser tab, cannot drive it. Path parameters are confined to the scan root, so `../../.ssh/id_rsa` is rejected rather than served.

## Releasing

```bash
npm version patch   # or minor, major
```

That runs a guard (on `main`, in sync with `origin/main`), runs the dependency-free suite, bumps the version, commits, tags, and pushes. The tag push is what triggers the release: CI re-checks that the tag sits on `main` and matches `package.json`, re-runs the tests and the packed-install check, publishes to npm with a provenance attestation, installs the result from the registry to confirm it is really there, and opens a GitHub release with the tarball attached.

To exercise the pipeline without publishing, dispatch it manually – `dry_run` defaults to true:

```bash
gh workflow run release.yml
```

A dry run proves that the package builds, packs, installs, and passes its tests. It does not prove the publish itself: npm skips the entire publish path under `--dry-run`, so credentials, provenance, and registry acceptance are only exercised by a real release.

Unchecking `dry_run` on a manual dispatch is a real publish, and not the way to cut a release: dispatching has no tag, so both tag checks are skipped and no GitHub release is created – npm gets the version, the repo does not. Release by pushing a tag.

If CI fails *before* the registry accepts the upload – a bad tag, a failed test, a provenance error – the version number is untouched and you can move the tag onto the fix:

```bash
npm run retag
```

That moves the tag to whatever `main` currently points at, so push the fix first. `retag` runs the same guard as `npm version` and refuses from a feature branch or an unpushed `main`, since either would tag a commit the release then could not verify.

`retag` only works when the tag actually moves. If the tag already points at the commit you want – a run that failed for a reason outside the repo, say a registry outage – the force-push is a no-op, git prints `Everything up-to-date`, and **no workflow runs**: Actions fires on a ref change, and nothing changed. Re-run the same commit by dispatching against the tag instead, which takes the tag's tree and skips nothing:

```bash
gh workflow run release.yml --ref v0.1.0 -f dry_run=false
```

The `dry_run=false` is required – dispatch defaults to a dry run, which publishes nothing. Unlike a dispatch from a branch, this one has a tag, so both tag checks run and the GitHub release is still cut.

Once a version is on the registry it is spent; npm does not allow republishing it. A failure after that point means the package is live and the fix is the next patch, not a retag. The GitHub release is therefore cut whenever the publish succeeded, even if the registry smoke test then fails – a slow-propagating registry should not also cost you the release.

A publish sends this README to the registry as plaintext, on every release rather than only the first, and a WAF sits in front of `registry.npmjs.org` that rejects request bodies matching attack signatures. So prose here can fail a release: a path-traversal example was once enough. npm reports the block as `E403` with boilerplate about "your security policy", naming neither the WAF nor the cause, so it reads like a credential problem. To tell them apart, PUT the same document with *no* credentials – the WAF answers before npm authenticates, so an HTML 403 indicts the payload while JSON clears it, and an unauthenticated request cannot publish.

Publishing carries no credential at all. npm knows this repository, `release.yml`, and the `prd` environment as a trusted publisher, so it exchanges the workflow's OIDC token for a short-lived publish token – nothing long-lived to leak, rotate, or forget. A fork cannot publish, because the claim names this repository.

Those three values have to agree with the package's settings on npmjs.com exactly, and all three are easy to break by accident: renaming this workflow file, or renaming the job's `environment:`, or dropping it. GitHub only puts an `environment` claim in the token when the job declares one, so `environment: prd` in `release.yml` is load-bearing for authentication rather than deployment bookkeeping. npm does not validate a trusted publisher when you save it, and a mismatch fails silently at publish time: the exchange is skipped, `npm publish` runs unauthenticated, and the registry answers `E404 ... you do not have permission`, which reads like a missing package. Ask the exchange endpoint directly for the real message:

```bash
curl -X POST -H "Authorization: Bearer $ID_TOKEN" \
  https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/reorg-cli
```

Trusted publishing cannot perform a package's *first* publish, though – npmjs.com only exposes the setting for a package that already exists – so `0.1.0` went out with a short-lived granular token, which was then revoked. Anyone bootstrapping a *new* package from this workflow has to do the same: publish once with an `NPM_TOKEN` secret and `NODE_AUTH_TOKEN` set on the publish step, then register the publisher and remove both.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
