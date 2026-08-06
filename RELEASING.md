# Releasing Reorg

Releases publish one verified `reorg-cli` tarball to npm and then attach that same artifact to the corresponding GitHub release. The workflow filename, package version, tag, trusted-publisher environment, and preserved artifact are all part of the release contract.

## Normal release

Run the version command from `main` after it is synchronized with `origin/main`:

```bash
npm version patch
```

Use `minor` or `major` instead when appropriate. The version lifecycle runs the release guard and dependency-free test suite, updates the package version, creates the version commit and tag, and pushes `main` and the tag atomically.

The tag push starts the `Publish npm package` workflow. Its browser and package jobs validate the tagged tree, pack it once, install and exercise that exact tarball, and preserve it as a workflow artifact. The publish job starts only after both gates pass, downloads the same verified tarball, and publishes it to npm with a provenance attestation as its final meaningful action.

A successful tag-triggered publish starts the separately named `Post-release verification` workflow. That workflow installs the exact version from the registry and creates or updates the GitHub release with the preserved tarball. A failure there reports post-release verification or metadata trouble without relabeling a successful npm publish as a failed deployment.

## Dry-run the pipeline

Dispatch the publish workflow manually to exercise packaging without publishing. `dry_run` defaults to true:

```bash
gh workflow run release.yml
```

A dry run proves that the package packs, installs, passes its tests, and is preserved as the release artifact. It skips the artifact download and registry-facing publish job. Credentials, provenance, registry acceptance, and the download side of the artifact handoff are exercised only by a real release.

Manual dispatches from a branch cannot publish even when `dry_run` is unchecked because the publish job also requires a `v*` tag. Release by pushing a tag.

The post-release workflow can also be exercised without changing a GitHub release. Give it the successful publish-workflow run that contains the preserved artifact and an existing published tag; `create_release` defaults to false:

```bash
release_tag="v$(node -p 'require("./package.json").version')"
publish_run="$(gh run list --workflow release.yml --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId')"
gh workflow run post-release.yml -f source_run_id="$publish_run" -f tag="$release_tag"
```

## Recover a failed publish

If the publish workflow fails before npm accepts the upload, such as from a bad tag, failed test, or authentication error, that registry version remains unused and the tag can move onto the fix:

```bash
npm run retag
```

`retag` moves the tag to whatever `main` points at, so push the fix first. It runs the same guard as `npm version` and refuses from a feature branch or an unpushed `main`, since either would tag a commit the release could not verify.

`retag` works only when the tag actually moves. If the tag already points at the desired commit, a force-push is a no-op and no workflow runs because GitHub Actions sees no ref change. Re-run the same commit by dispatching against the tag:

```bash
gh workflow run release.yml --ref "v$(node -p 'require("./package.json").version')" -f dry_run=false
```

The explicit `dry_run=false` is required. Unlike a dispatch from a branch, this invocation has a tag, so both tag checks run and publication is allowed. A manually dispatched recovery does not start post-release automation; after publication succeeds, dispatch `post-release.yml` with the publish run id, tag, and `create_release=true`.

Once a version exists on the registry it is spent because npm does not allow republishing it. Before retrying a red publish run, check the registry in case a lost response left npm with the package even though the runner did not observe success. If the version exists, do not retag or republish it; run post-release verification and use the next patch for any package change.

## Distinguish payload rejection from authentication failure

npm receives `README.md` as plaintext with every release, and a web application firewall in front of the registry rejects request bodies that match attack signatures. A path-traversal example in prose was enough to trigger an HTML `403`, while npm reported only generic security-policy boilerplate that resembled a credential failure.

To distinguish the two cases, send the same document in an unauthenticated request. The firewall evaluates the body before npm authenticates: an HTML `403` points to payload filtering, while a normal JSON authentication response clears the payload. An unauthenticated probe cannot publish.

## Trusted publishing

The publish job carries no long-lived npm credential. npm knows this repository, `.github/workflows/release.yml`, and the `prd` environment as a trusted publisher, then exchanges the workflow's OIDC token for a short-lived publish token. A fork cannot publish because the token claim identifies this repository.

Those values must agree exactly with the package settings on npmjs.com. Renaming the workflow file, changing or removing the job's `environment: prd`, or changing the configured repository breaks the exchange. GitHub includes an environment claim only when the job declares one, so `environment: prd` is authentication configuration rather than deployment bookkeeping.

npm does not validate the trusted-publisher configuration when it is saved. A mismatch fails at publish time: the exchange is skipped, `npm publish` runs unauthenticated, and the registry returns an `E404` permission error that resembles a missing package. Ask the exchange endpoint directly for the underlying message:

```bash
curl -X POST -H "Authorization: Bearer $ID_TOKEN" \
  https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/reorg-cli
```

Trusted publishing cannot perform a package's first publish because npmjs.com exposes the configuration only after the package exists. Reorg `0.1.0` used a short-lived granular token that was revoked after publication. Bootstrapping another package from this workflow requires the same sequence: publish once with an `NPM_TOKEN` secret supplied as `NODE_AUTH_TOKEN`, register the trusted publisher, then remove both the secret and token configuration.
