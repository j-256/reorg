# Repository instructions

## Read first

Read `README.md` and `DESIGN.md` before changing behavior. Read `RELEASING.md` before touching package, version, tag, registry, or release-workflow code.

Reorg separates planning from filesystem execution. Preserve that boundary even when a direct file operation would make an implementation shorter.

## Safety invariants

- Planning, inspection, mutation, view updates, rescanning, static export, and dry runs must not move, rename, trash, overwrite, or delete source entries.
- Keep apply opt-in in both interfaces. The CLI requires `apply --yes`; the browser receives apply capability only when its server starts with `--allow-apply` and still requires confirmation.
- Resolve and validate the complete batch before the first filesystem mutation. Drift, collisions, unsafe paths, stale scans, and revision conflicts must abort without a partial apply.
- Write an executable, independently guarded undo script before executing operations. Trash means a recoverable move below the source root's `.reorg/trash/`, never deletion.
- Keep every operation confined to the selected root. Treat symlinks as directory entries with `lstat` semantics rather than following them to decide whether a path exists.
- Preserve dependency-aware move ordering, cycle staging, tracked-file `git mv`, and the plain-rename fallback. Do not replace the resolver with command-order execution.
- Keep `--force` and other safety controls explicit and narrowly scoped. Never infer destructive authorization from permission to plan, inspect, serve, or dry-run.

## Workspace and collaboration contracts

- Treat the frozen scan, semantic plan, shared view, transaction log, and apply recovery as distinct state with distinct lifecycles.
- Never edit workspace JSON directly. Browser and CLI changes must pass through the same revision-checked command and view layers.
- Preserve stable node ids, expected revisions, transaction idempotency, atomic semantic commands, and machine-readable conflict codes. A stale collaborator must re-inspect rather than overwrite newer intent.
- Do not silently replace the frozen scan with live filesystem state. Rescanning is an explicit shared-state transition.
- Portable planning data may use `--data-dir`; undo scripts, staging, trash, and other apply recovery remain beside the source root. Moving or rebinding state must respect the live-server lease and validate the complete scan.
- Keep the live server loopback-only, token-gated, path-confined, and bounded in what it previews. The static planner may embed and export state but must never acquire live inspection or apply authority.

## Keep integrations aligned

- The CLI and `reorg schema --json` define the deterministic collaboration contract. Do not move validation or state transitions into browser-only code, an agent prompt, or a second integration model.
- `.agents/skills/reorg/SKILL.md` is the canonical Agent Skill source. Update it with schema, command, conflict, safety, or workflow changes; `.claude/skills/reorg` is only its compatibility link.
- Preserve the distributed package's build-free, zero-runtime-dependency design. Development-only browser tooling belongs in `devDependencies` and must not enter the installed execution path.
- Keep file summaries bounded and explicit about any provider call. Static planners contain filenames, metadata, summaries, and previews, so changes must not weaken their disclosure warnings.

## Verification and release boundaries

- Run a focused built-in Node test while iterating, then `npm test`. Filesystem safety changes require real temporary-directory, Git, drift, partial-apply, and undo coverage.
- Run `npm run test:ui` for planner interaction, responsive behavior, keyboard or focus handling, accessibility, server-browser coordination, or CSS changes. Use `npm run test:all` for changes crossing CLI and browser boundaries.
- Add negative tests for every new mutation path or permission: planning remains inert, unauthorized apply fails, unsafe paths stay confined, and recovery still works after interruption.
- Treat `npm version` as a remote publication operation because its hooks commit, tag, and push. Do not run it without explicit release and push authorization.
- Treat `npm run retag` as a history-changing recovery operation. Follow `RELEASING.md`, verify registry state first, and obtain explicit force-push authorization.
