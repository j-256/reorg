# reorg

Reorganize a messy directory by selecting or dragging entries into shape, then apply the plan with one command. Before moving anything, reorg writes an undo script.

```
npx reorg-cli@latest ~/Downloads
```

That scans the directory, opens a planner in your browser, and prints a URL. Select an entry to see its labeled actions, create folders at any level, move with or without drag and drop, rename things, and mark junk for trash. No planned rename, move, folder, or trash action touches the entries on disk until you say so.

![The planner mid-edit: a new folder, two moves, two entries marked for trash](docs/planner.png)

When a destination does not exist yet, create and select it without leaving Move. Repeat that step to build as much nested structure as the plan needs.

![The Move dialog creating a nested destination before moving a file](docs/move.png)

No runtime dependencies, no build step, no config file. One Node script and a page.

## Why

Cleaning up a directory has two distinct parts: deciding what its shape should be, and safely realizing that plan on disk. reorg keeps them separate. You arrange the whole tree in a planner where every change is reversible with a keystroke. When the shape looks right, reorg compiles the plan into ordered filesystem operations for applying and undoing the changes, with collisions caught before anything moves.

It is useful for a `~/Downloads` that got away from you, a repo whose layout no longer matches how you think about it, or a scratch directory you have been meaning to triage for a year.

## Install

Install globally to add the `reorg` command:

```bash
npm install -g reorg-cli
reorg ~/Downloads
```

For a one-off run, use the latest release without installing a persistent command:

```bash
npx reorg-cli@latest ~/Downloads
```

npm may cache the downloaded package, but `reorg` is not available as an installed command afterward. To run from a source checkout, clone and link it:

```bash
git clone https://github.com/j-256/reorg
cd reorg
npm link
reorg ~/Downloads
```

Requires Node 22 or newer – the oldest release still receiving security updates. There are no runtime dependencies: `package.json` has an empty `dependencies` block and that is deliberate.

## Tests

```bash
npm test        # no install needed -- runs on a bare checkout
npm run test:ui # browser tests; needs `npm ci` and a Chromium
npm run test:all
```

`npm test` needs nothing installed, deliberately: it covers the scanner, the plan resolver, the apply engine and its undo scripts, the triage signals, the server's access control, and the browser-side plan model, all under `node --test` with nothing fetched.

`npm run test:ui` drives the real page in a real Chromium, which is the only way to cover what a fake DOM cannot: drop-zone geometry is computed from the pointer's position against a row's box, and jsdom reports every box as zero-sized. Automated accessibility coverage combines axe-core rules with a dedicated text-contrast sweep at WCAG AAA enhanced thresholds across both themes, every side panel, and every dialog. Playwright and axe-core are confined to `devDependencies`:

```bash
npm ci && npx playwright install chromium
```

## Using it

| Command | What it does |
|---|---|
| `reorg [dir]` | scan, serve the planner, open a browser |
| `reorg [dir] --static` | write and open a self-contained planner with no server |
| `reorg plan [dir]` | print the current plan as operations |
| `reorg apply [dir]` | dry run: print what would happen, change nothing |
| `reorg apply [dir] --yes` | apply, writing an undo script first |
| `reorg apply --plan FILE` | dry-run a plan exported by a static planner |
| `reorg undo [dir]` | run the most recent undo script |
| `reorg status [dir]` | what is planned, applied, and undoable |
| `reorg inspect [dir] --json` | return the frozen scan, semantic plan, shared view, effective presentation, and resolved operations |
| `reorg rescan [dir] --json` | refresh the canonical frozen scan without changing source files |
| `reorg mutate [dir] --input FILE` | apply revision-checked semantic plan commands |
| `reorg view [dir] --input FILE` | update filters, collapse state, selection, and side-panel state |
| `reorg view [dir] --focus ID` | reveal and select one stable node id |
| `reorg schema` | print the machine-readable collaboration contract |
| `reorg state move DEST --data-dir SOURCE` | relocate a stopped workspace data directory |
| `reorg state rebind NEW_ROOT --data-dir DIR` | validate and bind state to a relocated source directory |
| `reorg summarize [dir]` | one-line AI description per file (see below) |
| `reorg triage [dir]` | rank likely-disposable entries and say why |
| `reorg --version` | print the installed reorg version |

Short aliases are `-s` for `--static`, `-o` for `--output`, `-p` for `--port`, `-y` for `--yes`, `-v` for `--version`, and `-h` for `--help`. `--plan` stays long-only so `-p` is unambiguously the port.

In the planner:

- **Select** a row to expose Rename, Move, New folder, Add note, and Trash or Remove actions with plain-language labels.
- **Create folders** from the always-visible New folder button, then choose both the name and containing folder explicitly.
- **Move** an entry with the Move dialog. If the destination is missing, create and select it in place, then repeat to build nested destinations.
- **Drag** a row onto a folder's middle to move *into* it; onto the top or bottom edge to become a sibling. Drop below the tree to move to the top level.
- **Use Arrow keys, Home, and End** to navigate the tree, `Enter` or `Space` to select or preview, and `Shift+F10` to open the selected entry's action menu.
- **Double-click** or press `F2` to rename in place.
- **Press `Delete`** to mark an entry for trash. Folders take their contents with them.
- **Press `n`** to open New folder inside a selected folder, alongside a selected file, or at the top level when nothing is selected.
- **Press `N`** to attach a note.
- **Press `/`** to jump to the filter box; wrap the query in slashes for a regex (`/\.log$/`). Invalid expressions are explained without hiding the tree.
- **Press `?`** to list every key.

Toolbar toggles persist in shared view state, so the view you set up is the view the browser, CLI, and an AI agent can inspect: **git status** tints rows by git status, **sizes** draws a size bar on each row, and **theme** cycles `system` through forced `dark` and `light`.

Sibling order is *derived* (folders first, then natural sort), never stored. Dragging something out of a folder and back is a genuine no-op rather than a phantom "reordered" change.

The planner targets WCAG 2.2 AA overall and adds AAA enhancements where they improve the experience without changing the product's compact structure. Normal and large text meet the AAA enhanced contrast thresholds in both themes, while controls meet the AA minimum target size rather than the larger AAA target. The tree, menus, dialogs, panels, status messages, focus movement, narrow single-pane layout, and reduced-motion behavior are all covered by browser tests.

## Shared workspace and AI agents

The browser, CLI, and an AI agent use one authoritative workspace. The browser does not replace `plan.json`, and an agent should not edit any state file directly. Browser and agent edits submit semantic commands through the same revision-checked command layer, while filesystem paths remain unchanged until the separate `reorg apply --yes` command runs.

The workspace contains related state with different jobs:

| File | Role |
|---|---|
| `workspace.json` | stable workspace id and source-root binding |
| `scan.json` | the frozen directory scan all collaborators organize |
| `plan.json` | the revisioned semantic diff, notes, summaries, and idempotency records |
| `view.json` | the independently revisioned filters, collapsed folders, selection, theme, and side panel |
| `transactions.jsonl` | append-only attribution and command history for plan changes |

`reorg inspect --json` answers both "what is planned?" and "what is reorg displaying?". Its projection explains whether each node is visible, filtered, hidden under a collapsed ancestor, dimmed by a change filter, muted as git-ignored, selected, or shown with size tinting. It also returns recent attributed plan transactions and the exact ordered operations the canonical plan resolves to.

`reorg inspect` deliberately reads the frozen scan rather than silently replacing it with the live filesystem. Starting the browser also reuses an existing frozen scan unless explicit scan options request a new one. Use `reorg rescan --json` when a collaborator intentionally wants to refresh that shared baseline; a running browser adopts the new scan through the same workspace.

An agent can discover the accepted command shapes instead of relying on prompt prose:

```bash
reorg schema
reorg inspect ~/Downloads --json
```

Then it can submit one atomic, idempotent transaction. Supplying the revision returned by `inspect` makes stale intent fail instead of overwriting another collaborator:

```bash
reorg mutate ~/Downloads --input - --json <<'JSON'
{
  "expectedRevision": 4,
  "transactionId": "organize-writing-1",
  "actor": "codex",
  "commands": [
    { "type": "create-folder", "id": "new:writing", "parentId": ".", "name": "Writing" },
    { "type": "move", "id": "draft.md", "parentId": "new:writing" }
  ]
}
JSON
```

The transaction changes planning state only. Reusing its id with the same commands is safe; reusing it for different commands is rejected. A plan may temporarily contain a collision while a later command fixes it, but `reorg apply` refuses unresolved problems. Use `reorg view --focus draft.md` when the agent should reveal the same entry in the browser without changing the plan.

With `--json`, command failures are emitted as one JSON object on stderr. `revision-conflict` means the agent should inspect again before reconsidering its intent; `workspace-busy` is retryable with the same transaction id; `idempotency-conflict` means that id was reused for different commands.

By default the workspace lives in `<root>/.reorg`. Put it elsewhere when the planning data should travel independently:

```bash
reorg ~/Downloads --data-dir ~/reorg-data/downloads
reorg inspect --data-dir ~/reorg-data/downloads --json
```

An external data directory must be outside the reorganized root. Its own path is not embedded, so moving only that data does not require rebinding:

```bash
reorg state move ~/archive/reorg-downloads --data-dir ~/reorg-data/downloads
```

Stop the browser server before moving or copying workspace data; a live server lease makes `state move` and `state rebind` refuse rather than split the source of truth. If the source directory itself moves, rebind after the move. Rebind compares relative ids, entry kinds, sizes, collapsed-directory totals, and link targets against the frozen scan before changing the binding; a truncated scan is refused because it cannot validate the whole displayed baseline:

```bash
reorg state rebind /Volumes/Archive/Downloads --data-dir ~/archive/reorg-downloads
```

Apply recovery is deliberately not portable workspace data. Undo scripts, staging, and trashed entries always stay in `<root>/.reorg` beside the filesystem they can restore, even when `--data-dir` points elsewhere. Moving the default workspace splits out its portable files and leaves those recovery artifacts in place; moving it back merges the portable files without disturbing recovery.

After `reorg undo`, the CLI refreshes any workspace found at the selected `--data-dir`, and a running browser adopts that scan. Pass the external data directory when undoing a source whose portable workspace does not live at the default path.

## Static planner

Use `--static` when the planner needs to work without a local HTTP server:

```bash
reorg ~/Downloads -s
reorg ~/Downloads -s -o downloads-plan.html
```

Without `--output`, reorg writes a temporary HTML file and opens it. The page is self-contained: the tree, cleanup candidates, bounded file previews, styles, and browser code are all embedded, so it can be moved and opened directly with a `file://` URL. An explicit output path is never overwritten.

The tradeoff is that a static page cannot rescan the directory, autosave to the shared workspace, check the live filesystem, or apply anything. Edits stay in the page until **Review plan** exports `reorg-plan.json` by download or clipboard. Feed that export back to the CLI:

```bash
reorg apply --plan ~/Downloads/reorg-plan.json # drift-checked dry run
reorg apply --plan ~/Downloads/reorg-plan.json --yes # write undo script, then apply
```

The export carries the plan, the scan it was drawn against, and the effective view, including the source root. That lets the CLI preserve every intended operation and refuse the batch if a source disappeared or a destination became occupied. Pass an explicit directory after `apply` to use that directory instead of the embedded root. `--plan -` reads the same JSON from standard input.

A static page contains filenames, metadata, summaries, and the embedded file previews. Treat it like the directory data it captures when copying or sharing it.

## Safety

Applying a reorganization is the part that can ruin your afternoon, so the plan is always shown as the exact operations it resolves to, in order, before anything runs:

![Review panel listing the resolved operations in order, with a run safety check button](docs/review.png)

- **Dry run is the default.** `reorg apply` prints and exits. Only the explicit CLI command `reorg apply --yes` moves anything; the browser and its HTTP API cannot apply.
- **Nothing is deleted.** "Trash" moves into `.reorg/trash/<run>/`. Emptying that is a separate decision you make yourself.
- **Drift aborts the whole batch.** Every source path is checked to still exist and every destination to be free *before* the first move. If the tree changed since the scan, nothing is applied – not "nothing further", nothing at all.
- **An undo script is written before execution starts**, so even a crash mid-run leaves a way back. It is guarded per step, so running it after a partial apply undoes only what happened.
- **Collisions are caught at plan time**, not discovered at move time: two entries landing on one path, a folder marked for trash that still holds things you kept, a folder dragged inside itself.
- **`git mv` for tracked files**, so history follows the move. (Git refuses this on a fully-untracked directory; reorg falls back to a plain rename there.)
- **Rename cycles work.** Swapping two names is impossible with direct renames in any order, so reorg routes cycle members through a staging directory instead of failing.

The semantic plan remains a diff against the frozen scan rather than a second copy of the tree. The default `.reorg/` workspace git-ignores itself on creation, so planning a repo's layout never dirties that repo.

## File summaries

Half of triage is remembering what a file *is*. `reorg summarize` labels each one with a single line – "nightly S3 sync of /var/data", not "a shell script" – and the planner shows it inline next to the filename.

Two ways to get them, and the default needs no API key:

```bash
# Agent path: writes a prompt pack, your coding agent fills it in. Free.
reorg summarize ~/Downloads          # -> <data-dir>/summarize.md + summaries.json
#   ...point Claude Code (or any agent) at that markdown file...
reorg summarize --ingest ~/Downloads

# API path: calls the Messages API directly. Needs a key.
ANTHROPIC_API_KEY=sk-... reorg summarize ~/Downloads
```

The API path batches files (about a dozen per request), sends only the first few KB of each, skips binaries and empty files, and defaults to Haiku because this is a classification job. Override with `--model`. It uses `fetch` against the documented HTTP API – no SDK dependency.

Summaries are stored in the plan and keyed by stable node id, so they survive a rescan. After an apply renames or moves an entry, reorg remaps its summary and notes to the resulting path before refreshing the frozen scan.

## Triage: what looks disposable

`reorg triage` ranks entries that look like junk and says why, so a directory that has got away from you starts with a shortlist instead of a scroll. The same list is in the planner behind the **cleanup** button, where each row has a mark-for-trash button.

![Cleanup candidates panel: each candidate carries the signals that flagged it and a plain-language reason](docs/triage.png)

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

`reorg plan` prints exactly this list, and the planner's **review plan** panel shows the same thing before you apply.

## Layout

```
bin/reorg          CLI: scan, serve or build static, plan, apply, undo, summarize, status
src/scan.js        walk a directory, tag git status, summarize collapsed dirs
src/plan.js        pure resolver: plan -> ordered operations (no fs, no exec)
src/commands.js    revisioned semantic plan transactions and idempotency
src/view.js        effective presentation projection and shared view transactions
src/schema.js      machine-readable collaboration contract
src/apply.js       execute, with drift checks, git mv, trash, undo script
src/summarize.js   Messages API batching + the no-key agent prompt pack
src/signals.js     cleanup signals: what looks disposable, and why (name, not age)
src/server.js      stdlib http server, token-gated JSON API
src/static.js      build a self-contained planner with an embedded read-only API
src/state.js       portable workspace persistence, locks, leases, and recovery paths
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

`reorg` serves on loopback with a per-run token in the URL. That is not theatre: the API can read file contents and mutate the shared plan and view, although it cannot move source files. A token means another process on the machine, or a stray browser tab, cannot drive it. Path parameters are confined to the scan root, so `../../.ssh/id_rsa` is rejected rather than served.

## Releasing

```bash
npm version patch   # or minor, major
```

That runs a guard (on `main`, in sync with `origin/main`), runs the dependency-free suite, bumps the version, commits, tags, and pushes. The tag push starts the `Publish npm package` workflow. Its browser and package jobs validate the tagged tree, pack it once, install and exercise that exact tarball, and preserve it as a workflow artifact. The publish job starts only after both gates pass, downloads the same verified tarball, and publishes it to npm with a provenance attestation as its final meaningful action.

A successful tag-triggered publish starts the separately named `Post-release verification` workflow. That workflow installs the exact version from the registry and creates or updates the GitHub release with the preserved tarball. A failure there reports post-release verification or metadata trouble without relabeling a successful npm publish as a failed deployment.

To exercise the pipeline without publishing, dispatch it manually – `dry_run` defaults to true:

```bash
gh workflow run release.yml
```

A dry run proves that the package builds, packs, installs, passes its tests, and is preserved as the release artifact. It skips the artifact download and registry-facing publish job. Credentials, provenance, registry acceptance, and the download side of the artifact handoff are only exercised by a real release.

Manual dispatches from a branch cannot publish even when `dry_run` is unchecked: the publish job also requires a `v*` tag. Release by pushing a tag.

The post-release workflow can also be exercised without changing a GitHub release. Give it the successful publish-workflow run that contains the preserved artifact and an existing published tag; `create_release` defaults to false:

```bash
publish_run="$(gh run list --workflow release.yml --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId')"
gh workflow run post-release.yml -f source_run_id="$publish_run" -f tag=v0.3.1
```

If the publish workflow fails before npm accepts the upload – a bad tag, a failed test, or an authentication error – that registry version remains available and you can move the tag onto the fix:

```bash
npm run retag
```

That moves the tag to whatever `main` currently points at, so push the fix first. `retag` runs the same guard as `npm version` and refuses from a feature branch or an unpushed `main`, since either would tag a commit the release then could not verify.

`retag` only works when the tag actually moves. If the tag already points at the commit you want – a run that failed for a reason outside the repo, say a registry outage – the force-push is a no-op, git prints `Everything up-to-date`, and **no workflow runs**: Actions fires on a ref change, and nothing changed. Re-run the same commit by dispatching against the tag instead:

```bash
gh workflow run release.yml --ref v0.1.0 -f dry_run=false
```

The `dry_run=false` is required – dispatch defaults to a dry run, which publishes nothing. Unlike a dispatch from a branch, this one has a tag, so both tag checks run and publication is allowed. A manually dispatched recovery does not start post-release automation; after publication succeeds, dispatch `post-release.yml` with the publish run id, the tag, and `create_release=true`.

Once a version is on the registry it is spent; npm does not allow republishing it. Before retrying any red publish run, check the registry because a lost response can leave npm with the package even when the runner did not observe success. If the version exists, do not retag or republish it: run post-release verification and use the next patch for any package change.

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
