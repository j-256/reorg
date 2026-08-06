# Reorg design

This document records the architectural boundaries and tradeoffs behind Reorg. See [README.md](README.md) for installation and usage, and [RELEASING.md](RELEASING.md) for the publishing runbook.

## Design constraints

Directory organization has two separate phases: deciding what the tree should become and realizing that decision on disk. Reorg keeps those phases separate so a person, browser, or agent can revise a plan freely while filesystem changes remain explicit, reviewable, and recoverable.

The design follows these constraints:

- Planning never moves, renames, or trashes source entries
- Every collaborator works from one frozen scan until someone explicitly rescans
- Semantic commands target stable node ids rather than inferred live paths
- Concurrent changes fail visibly instead of silently overwriting newer intent
- Applying is dry-run by default, validates the whole batch before starting, and writes recovery instructions first
- Deterministic state transitions belong to Reorg rather than an agent prompt or browser-only model
- The distributed CLI stays small and auditable, with no third-party runtime package dependencies, build step, or configuration requirement

The model or person decides how a directory should be organized. Reorg owns inspection, validation, persistence, coordination, operation ordering, application, and recovery.

The last constraint deserves its own justification, because "no runtime package dependencies" is easy to assert as a virtue and easy to inherit as status-quo bias. It was not a founding axiom. It emerged from repeated local choices where the standard library already sufficed: Node's built-in test runner rather than a framework, its `http` server rather than a web framework, and `fetch` rather than a vendored API SDK. Each avoided a dependency at little cost, and the resulting property is worth preserving when the alternative does not buy comparable value.

One reason is security. Reorg moves and trashes files, so every JavaScript package loaded at runtime inherits the filesystem authority granted to the process. Keeping Reorg's application-level runtime code in one auditable repository narrows the supply-chain surface exposed to that authority. It does not put the entire trusted computing base in the repository: Node, the operating system, Git, and the browser remain trusted components.

Another reason is maintenance longevity. Avoiding third-party runtime packages removes their upgrades, advisories, and peer-version conflicts from the installed execution path. Development tools still require maintenance, but end users do not load them when running Reorg. Build-free distribution is a separate guarantee that reinforces the same goal: no transpile or bundle step sits between the shipped source and the code Node executes. These are not absolute guarantees against churn or compromise, but they remove recurring failure modes from a tool trusted with filesystem changes.

## Shared workspace model

The workspace separates related state according to its role:

| File | Role |
|---|---|
| `workspace.json` | Stable workspace id and source-root binding |
| `scan.json` | Frozen directory scan shared by every collaborator |
| `plan.json` | Revisioned semantic diff, notes, summaries, and idempotency records |
| `view.json` | Independently revisioned filters, collapsed folders, selection, theme, and side panel |
| `transactions.jsonl` | Append-only attribution and command history for plan changes |

The scan is a baseline, not a cache of whatever happens to be on disk when a command runs. `reorg inspect` and the browser reuse it until `reorg rescan` intentionally replaces it. This keeps two collaborators from reasoning about different trees and makes filesystem drift a condition to report rather than absorb silently.

Plan and view revisions are independent because changing a filter or selection should not conflict with an organizational edit. The effective projection combines the frozen scan, semantic plan, and view state to explain whether each node is visible, filtered, hidden under a collapsed ancestor, dimmed by a change filter, muted as git-ignored, selected, or shown with size tinting.

Portable planning state may live outside the source root through `--data-dir`. Its source binding can change only after structural validation against the complete frozen scan. A live browser holds a workspace lease, so moving or rebinding portable state while that server is running is refused rather than risking two sources of truth.

Apply recovery is intentionally not portable. Undo scripts, staging, and trashed entries stay under the source root's `.reorg` directory beside the filesystem they can restore, even when planning state lives elsewhere.

## Collaboration contract

The browser and agents use different transports but share one command layer. The browser submits semantic commands through the token-gated local API. An agent uses `reorg inspect`, `reorg mutate`, and `reorg view`. Neither edits workspace files directly.

`reorg schema --json` publishes the collaboration contract so an integration can verify the format and version before relying on command shapes or safety behavior. Stable ids come from the frozen scan, and caller-supplied `new:` ids allow later commands in one transaction to refer to folders created earlier in that transaction.

An agent plan mutation is one atomic transaction with an expected revision, idempotency key, actor, and semantic commands:

```json
{
  "expectedRevision": 4,
  "transactionId": "organize-writing-1",
  "actor": "my-agent",
  "commands": [
    { "type": "create-folder", "id": "new:writing", "parentId": ".", "name": "Writing" },
    { "type": "move", "id": "draft.md", "parentId": "new:writing" }
  ]
}
```

Supplying the revision makes stale intent fail instead of overwriting another collaborator. Repeating an interrupted request with the same transaction id and identical commands is safe; reusing the id for different commands is rejected. A plan may temporarily contain a collision while later commands in the same transaction repair it, but unresolved problems prevent application.

Machine-readable failures preserve the same concurrency rules across integrations. A `revision-conflict` requires a fresh inspection and reconsideration, `workspace-busy` permits retrying the identical transaction, `idempotency-conflict` means the key was reused for different commands, and `scan-conflict` requires preparing the apply again from the refreshed baseline.

View changes use their own revision-checked patch. Focusing an entry reveals its collapsed ancestors and selects it without changing the organizational plan, which lets an agent and person discuss the same browser context.

## Plan representation and resolution

The plan is a semantic diff against the frozen scan rather than a second mutable copy of the tree. Every scanned entry has a stable id, an original position, and a planned position. Created folders, trash decisions, notes, and summaries extend that diff without modifying source entries.

Resolving a valid plan produces operations in dependency order:

1. `mkdir` operations for created folders, shallowest first
2. `mv` operations only for entries whose own position changed
3. `trash` operations at each entry's post-move location

Moving a directory relocates its unchanged descendants implicitly. Emitting separate moves for those descendants would refer to source paths that no longer exist. Destinations use final-tree paths so each changed entry moves once.

Move ordering is a topological sort over two constraints: vacate before occupy when one entry lands where another still sits, and parent before child when an entry lands inside a directory that is also moving. When those constraints form a cycle, Reorg routes the cycle through staging rather than pretending a direct order exists.

The resolver detects duplicate destinations, retained entries inside trashed directories, moves into descendants, and other structural contradictions before the apply engine sees them. Keeping resolution pure makes these rules testable without filesystem effects.

Notes and summaries are keyed by stable node id. After apply changes paths, Reorg remaps that metadata to the resulting ids before refreshing the frozen scan.

## Filesystem execution and recovery

The user-visible guarantees are summarized in [README.md](README.md#safety). Their implementation is deliberately layered:

- Resolution proves that the intended final tree is internally consistent
- Dry run renders the exact ordered operations without changing source entries
- Apply verifies every source and destination against the live filesystem before the first operation
- An undo script is written before execution begins and guards each step independently
- Trashed entries move into a recoverable run directory rather than being deleted
- Tracked files use `git mv` when possible, with a plain rename fallback where Git cannot represent the move
- Rename cycles use staging so swaps and longer cycles remain reversible

Whole-batch drift validation matters because stopping after a partial collision would leave the directory in a shape that neither the frozen scan nor the intended plan describes. The preflight therefore aborts before any operation when the live filesystem no longer matches the prepared sources and destinations.

## Planner boundaries

### Live planner

The live server binds to loopback (localhost) and puts a per-run token in the browser URL because its API can read bounded file previews and mutate shared plan and view state. Every path accepted by the API is confined to the scan root.

The browser starts without filesystem-apply capability. Starting the server with `--allow-apply` adds a confirmation-protected apply path for that process, while the CLI still requires the separate `reorg apply --yes` command. Capability is granted at server startup rather than inferred from a browser request.

The browser observes workspace revisions and adopts changes made through the CLI. It does not own a second plan model or write raw state.

### Static planner

The static planner embeds the frozen tree, bounded previews, effective view, styles, and browser code into one HTML document. With no server, it can edit and export a plan but cannot rescan, autosave to the shared workspace, inspect the live filesystem, or apply operations.

Its export includes both the semantic plan and the scan it was created against. Feeding that export to the CLI restores the normal drift checks and apply boundary instead of trusting paths produced by a detached page.

## Summaries and triage

### File summaries

Summaries describe what a file is for rather than merely identifying its type. The default path writes a prompt pack for a coding agent and then ingests its structured result. The optional API path sends bounded text samples directly through `fetch`, avoiding an SDK dependency and keeping the same persistence model.

Binary and empty files are skipped, and source text is bounded before it leaves the machine. Summaries live in the semantic plan so they survive rescans and follow entries through an applied rename or move.

### Triage signals

Triage ranks names and structural relationships rather than age. A name such as a trailing backup marker often states why an artifact exists, and an archive beside its unpacked copy reveals duplication. Modification time says only when metadata last changed and routinely elevates intentionally retained reference material while hiding recent disposable artifacts.

Position matters because a marker can name a subject instead of a status. Reorg recognizes status-like markers only in trailing positions, avoiding documents whose subjects happen to include words such as `backup` or `trash`. Emptiness is also excluded because empty directories are often intentional placeholders or mount points and cost little to retain.

Age remains visible as context but never determines the ranking. Checks against a long-neglected scratch directory found disposable entries across a wide age range, several safety copies with the same recent timestamp, and intentionally retained items among the oldest entries. That evidence favored explicit intent signals over an age heuristic.

## Agent integration

The Agent Skill carries the reasoning workflow while Reorg's CLI remains the only integration boundary. The Skill locates a compatible CLI by checking `reorg schema --json`, inspects before reasoning, submits revision-checked semantic transactions, handles conflicts according to their machine-readable codes, and keeps apply behind an explicit user request.

Keeping the Skill instruction-only means deterministic behavior stays in the revisioned CLI. A browser, Codex, Claude Code, or another shell-capable agent reaches the same state and safety checks rather than depending on agent-specific filesystem logic.

### Why Reorg does not ship an MCP server

This assessment uses MCP protocol revision [`2026-07-28`](https://modelcontextprotocol.io/specification/2026-07-28/changelog). It is a decision against shipping an adapter, not a claim that MCP lacks value. That revision removed protocol-level sessions and the initialization handshake, made request metadata self-contained, expanded tool inputs to full JSON Schema 2020-12, and moved specialized capabilities into optional extensions. Those changes make a thin Reorg adapter more practical than earlier MCP designs, but they do not make it free.

#### The case for MCP

MCP offers a standard interaction model that users and agent hosts can recognize without learning Reorg's shell choreography. For integrations that already speak MCP, a server could make Reorg feel native rather than merely callable.

- Tools would accept structured objects and return structured results without an agent constructing JSON for `reorg mutate --input`. Reorg's `schema` command is a versioned, machine-readable contract, but its field descriptions are not formal JSON Schema and are not equivalent to MCP tool schemas.
- Tool discovery would put names, descriptions, and input schemas where the host can present them to the model and user. Hosts may also offer per-tool approval policies and use read-only or destructive annotations when presenting calls, although those controls are host behavior rather than protocol enforcement.
- Stateless requests fit Reorg's architecture. A tool call can carry the source root or data directory, expected revision, transaction id, actor, and semantic commands while durable state remains in the workspace. The adapter would not need a second in-memory session model.
- A local MCP server would reach hosts that support local tools but do not permit arbitrary shell commands. That is a genuine expansion beyond the Skill, not merely a different spelling of the same invocation.
- [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) could embed an interactive planner inside a supporting conversation host. An inline tree with bidirectional tool calls would preserve conversational context and add a capability the standalone browser cannot provide.
- The [Skills over MCP](https://modelcontextprotocol.io/community/working-groups/skills-over-mcp) work could eventually standardize discovery and distribution of Reorg's reasoning workflow. The working group's 2026 charter records its extension as under review, so that proposal is a reason to watch the ecosystem rather than a basis for this decision.

Ergonomics can become product value when they remove enough installation, prompting, and recovery friction. If users already configure MCP servers across their agents, asking them to install a Skill and then drive a CLI may be the less natural integration even when both routes are functionally complete.

#### The case against MCP

For the shell-capable agents Reorg targets, MCP does not add a missing core operation. `inspect`, `mutate`, `view`, `rescan`, `apply`, and `undo` already cross a structured, revisioned CLI boundary and reach the same validation and persistence code as the browser. A tools-only adapter would improve discovery and argument passing, but it would not make planning, conflict handling, application, or recovery more correct.

Stateless protocol semantics do not eliminate the server process or its distribution. Reorg operates on a user's local filesystem, so a useful MCP server must still run locally with access to the target directory. A remote server cannot organize local files without a separate upload, mount, or filesystem bridge, each of which would change Reorg's trust model. For the common local case, MCP replaces shell invocation with host configuration rather than removing setup.

An MCP tools surface would not automatically replace the Agent Skill. Tool schemas can describe valid calls, but they do not guarantee that a host will load and follow Reorg's inspection, conflict, rescan, and apply policies as one workflow. Until skill distribution is stable across target hosts, users could end up configuring an MCP server and installing the Skill rather than replacing one setup path with another.

The adapter would also be another public contract. It would need to map tool schemas, results, errors, cancellation, protocol revisions, and transport behavior onto `reorg-collaboration-schema` without creating a second source of business rules. Shipping it inside `reorg-cli` would avoid package version skew, but using an SDK would widen the installed runtime dependency tree while implementing the wire protocol directly would make Reorg responsible for compatibility code. Shipping it separately would preserve the CLI's dependency boundary at the cost of another package, release path, and compatibility matrix. Stateless MCP makes the adapter thinner; it does not remove these choices.

Filesystem application is a sharper safety boundary than ordinary tool execution. MCP annotations can describe `inspect` as read-only and `apply` as destructive, but they are hints and host approval behavior varies. Preserving Reorg's rule that application follows an explicit user request would require either limiting MCP to planning and handing application back to the CLI, or designing an equivalent two-step confirmation mechanism and testing it across hosts. A shell agent faces the same underlying risk, but the CLI already separates dry run from `--yes` and the Skill states when the second step is allowed.

MCP Apps offer the clearest differentiated value and the largest additional surface. Reusing the planner would still require a `ui://` resource, sandbox-aware communication, host capability negotiation, and tests that keep the inline and standalone planners behaviorally aligned. Building that integration before a target host and user need are established would turn a hypothetical benefit into permanent maintenance.

Sampling is not a reason to add a new server. MCP [`2026-07-28` deprecates Sampling](https://modelcontextprotocol.io/specification/2026-07-28/client/sampling), directs new implementations toward provider APIs, and represents model requests as a multi-round-trip exchange rather than a server callback. Reorg already supports both a direct provider call through `fetch` and a no-key prompt pack handled by the calling agent.

#### Decision and reconsideration criteria

Reorg does not ship an MCP server. The decisive point is not that MCP adds only cost, but that the demonstrated value for Reorg's target users does not justify another supported integration contract. A tools-only mirror is technically practical, especially with stateless MCP, but native-looking argument passing alone is not enough to adopt and maintain it without evidence that the CLI and Skill are blocking real use.

Reconsider the decision when at least one product condition is established:

- A meaningful target host can run local MCP tools but cannot invoke Reorg's CLI
- Users demonstrate that MCP discovery and structured calls remove material adoption or reliability friction
- Target hosts support MCP Apps and an inline planner is materially better than opening the existing browser
- Skills over MCP stabilizes and can replace enough installation and discovery work to simplify the overall product

Any implementation must also preserve the architectural boundary:

- Tool schemas, validation, state transitions, and error codes derive from the same core definitions as the CLI
- The server holds no independent workspace truth and accepts explicit workspace identity on each operation
- Planning remains the default, while filesystem application and undo retain an explicit, testable authorization boundary
- Packaging names its tradeoff directly, whether that is a larger main package or a separately versioned adapter
- Compatibility tests cover the protocol revisions and target hosts Reorg claims to support

If those conditions are met, the preferred first step is a planning-only adapter exposing schema, inspection, mutation, view coordination, explicit rescanning, and apply dry runs while leaving filesystem application and undo at the CLI boundary. It would test whether MCP improves adoption without expanding the destructive surface. An MCP App would be the stronger follow-on because it adds a genuinely new interface rather than only mirroring commands.

## Source layout

```text
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
web/               planner: tree, drag and drop, preview, review
test/              resolver unit tests and integration tests on real temporary directories
```

## Testing strategy

The dependency-free test suite runs with Node's built-in test runner on a bare checkout. Pure resolver tests exercise plan validity and ordering without touching the filesystem, while integration tests use real directories, Git repositories, and undo scripts because correct abstract operations are not enough if execution behaves differently on disk.

Browser tests cover behavior a synthetic DOM cannot represent reliably, including pointer geometry, focus movement, dialogs, responsive layout, and reduced motion. Accessibility coverage combines automated rules with explicit contrast checks across themes and interface states. Browser-only dependencies remain confined to development and do not become part of the distributed CLI.
