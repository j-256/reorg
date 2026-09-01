---
name: reorg
description: Collaborate with a user on directory reorganization through Reorg's shared, revisioned CLI workspace. Use when a user asks an AI agent to organize files with Reorg, continue or revise a Reorg plan, explain what Reorg or its browser is displaying, coordinate in real time with another collaborator, manage portable Reorg state, dry-run or explicitly apply a plan, or undo an applied reorganization. Do not use for unrelated direct filesystem cleanup that is not using Reorg.
---

# Reorg

Use Reorg's CLI as the only integration boundary. Let the model choose an organization, but let Reorg inspect, validate, persist, coordinate, apply, and undo it.

## Establish the workspace

1. Select the CLI by its contract, not by the command name alone. Try these available candidates in order: `node <repo-root>/bin/reorg` when working anywhere inside a Reorg source checkout, `reorg`, then `npx --yes reorg-cli@latest`. Run `<reorg> schema --json` for each candidate and accept the first one whose `format` is `reorg-collaboration-schema` and whose `version` is `2`. The `npx` fallback may populate npm's cache but does not install a global command. If no candidate provides the contract, stop and report the incompatibility instead of guessing. Keep the accepted executable prefix for the whole workflow.
2. Resolve the source root and optional external data directory from the request. A bound external data directory can identify its source root, so do not require both. If neither is clear, ask for either the source root plus its external data directory when one is in use, or the already-bound data directory by itself. Ask before initializing a workspace. Preserve the same `--data-dir` in every command for that workspace.
3. Read the accepted schema before relying on command shapes or safety behavior.
4. Run `<reorg> inspect <root> --json [--data-dir <dir>]` before reasoning about state or making a change. Do not start the browser server merely to inspect.

Never edit workspace files directly. Never treat the live filesystem or raw state files as an answer to what Reorg is displaying.

Treat `planTransaction.inputSchema` and `viewUpdate.inputSchema` as the authoritative structural definitions for JSON input, and use their adjacent concise guidance for quick command selection. JSON Schema cannot establish whether a workspace node exists, a revision is current, or a plan resolves without collisions, so Reorg's inspection and runtime validation remain authoritative for those conditions.

## Interpret inspection

- Treat `scan` as the frozen baseline shared by every collaborator
- Treat stable node `id` values, not inferred filesystem paths, as mutation targets
- Read `plan` and `transactions` to understand pending intent and attributed changes
- Read `view` and `projection` to answer what the browser is displaying, including filters, collapsed ancestors, git-muted rows, dimming, selection, and side-panel context
- Read `resolved.ops` and `resolved.problems` to understand the exact prospective filesystem operations and whether the plan is valid
- Read source files only when their content helps decide the organization; do not infer Reorg state from those reads

Do not silently replace the frozen baseline. Run `<reorg> rescan ... --json` only when the user asks to refresh it or agrees that live filesystem changes should become the new shared scan.

## Change the plan

For a direct request to plan or revise an organization, submit semantic commands rather than editing files. For an exploratory request, explain the recommendation before changing shared state.

1. Build one atomic transaction from command types reported by `schema`.
2. Set `expectedRevision` to the inspected plan revision.
3. Give the transaction a unique `transactionId` and retain it until the outcome is known.
4. Set `actor` to a short agent identifier such as `codex` or `claude`.
5. Send JSON through `<reorg> mutate <root> --input - --json [--data-dir <dir>]`.
6. Inspect again and verify the new revision, transaction record, resolved operations, and problems.

Use a caller-supplied `new:` id when later commands in the same transaction need to refer to a folder being created. Group dependent creates, moves, renames, trash decisions, and notes into the same transaction when they represent one intent.

Reusing the same transaction id with identical commands is safe. After an interrupted or ambiguous response, retry the identical transaction with the same id rather than inventing a new one.

## Share browser context

Use `<reorg> view <root> --focus <id> --json [--data-dir <dir>]` to reveal and select an entry for the browser. For broader presentation changes, inspect the current view revision and submit a revision-checked patch using the shape reported by `schema`.

Changing the plan or view changes workspace state only. It does not move, rename, or delete source entries.

## Handle conflicts

- On `workspace-busy`, retry the identical request with the same transaction id after a short delay
- On `revision-conflict`, inspect again, reconsider the intent against the new state, and reuse the id only if the commands remain identical
- On `idempotency-conflict`, inspect the recorded transaction and choose a new id only for genuinely different commands
- On `invalid-command`, correct the command before retrying
- On `scan-conflict`, inspect the latest workspace and prepare the apply again

Never overwrite another collaborator's revision or bypass a conflict by editing workspace JSON.

## Move portable state

Use the `state move` and `state rebind` commands reported by `schema`; do not relocate or rewrite workspace files manually. Stop any browser server first so its workspace lease cannot split the source of truth. Keep apply recovery beside the source root rather than treating it as portable planning data.

## Apply or undo

Keep planning as the default outcome.

1. Run `<reorg> apply <root> [--data-dir <dir>]` without `--yes` to perform a dry run and surface drift or collisions.
2. Run `<reorg> apply <root> --yes [--data-dir <dir>]` only when the user explicitly requests filesystem application.
3. Use `<reorg> undo <root> [--data-dir <dir>]` only when the user explicitly requests undo.
4. Inspect after apply or undo and report the refreshed shared state and recovery command.

Never enact the plan with `mv`, `rm`, `cp`, `git mv`, direct editor operations, or raw state edits. Enable browser apply with `--allow-apply` only when the user explicitly asks for an apply-enabled browser session.

## Report the result

Summarize the organizational decisions, plan and view revisions, unresolved problems, and whether source files changed. Include the dry-run or undo command when it is the useful next step. Avoid dumping full inspection JSON unless the user asks for it.
