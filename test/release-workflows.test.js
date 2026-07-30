import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PUBLISH_WORKFLOW = readFileSync(
  new URL('../.github/workflows/release.yml', import.meta.url),
  'utf8',
);
const POST_RELEASE_WORKFLOW = readFileSync(
  new URL('../.github/workflows/post-release.yml', import.meta.url),
  'utf8',
);

test('publishing waits for every release gate and uses the verified tarball', () => {
  const preserveIndex = PUBLISH_WORKFLOW.indexOf('name: Preserve the verified package');
  const publishJobIndex = PUBLISH_WORKFLOW.indexOf('\n  publish:');
  const publishCommandIndex = PUBLISH_WORKFLOW.indexOf('npm publish "$1"');

  assert.match(PUBLISH_WORKFLOW, /^name: Publish npm package$/m);
  assert.match(PUBLISH_WORKFLOW, /needs: \[browser, package\]/);
  assert.match(
    PUBLISH_WORKFLOW,
    /if: \$\{\{ !inputs\.dry_run && startsWith\(github\.ref, 'refs\/tags\/v'\) \}\}/,
  );
  assert.ok(preserveIndex > -1, 'verified tarball is preserved');
  assert.ok(publishJobIndex > preserveIndex, 'publish job starts after packaging');
  assert.ok(publishCommandIndex > publishJobIndex, 'publish job uploads the downloaded tarball');
  assert.doesNotMatch(PUBLISH_WORKFLOW, /smoke-published|gh release/);
});

test('post-release checks cannot change the publish workflow result', () => {
  const smokeJobIndex = POST_RELEASE_WORKFLOW.indexOf('\n  smoke:');
  const releaseJobIndex = POST_RELEASE_WORKFLOW.indexOf('\n  release:');
  const contentsWriteIndex = POST_RELEASE_WORKFLOW.indexOf('contents: write');

  assert.match(POST_RELEASE_WORKFLOW, /^name: Post-release verification$/m);
  assert.match(POST_RELEASE_WORKFLOW, /workflows: \[Publish npm package\]/);
  assert.match(
    POST_RELEASE_WORKFLOW,
    /github\.event\.workflow_run\.conclusion == 'success'/,
  );
  assert.match(POST_RELEASE_WORKFLOW, /github\.event\.workflow_run\.event == 'push'/);
  assert.match(POST_RELEASE_WORKFLOW, /run-id: \$\{\{ env\.SOURCE_RUN_ID \}\}/);
  assert.match(POST_RELEASE_WORKFLOW, /await smokePublished/);
  assert.match(POST_RELEASE_WORKFLOW, /gh release (upload|create)/);
  assert.match(POST_RELEASE_WORKFLOW, /cmp -s/);
  assert.doesNotMatch(POST_RELEASE_WORKFLOW, /--clobber/);
  assert.ok(smokeJobIndex > -1, 'registry smoke has its own job');
  assert.ok(releaseJobIndex > smokeJobIndex, 'release metadata has its own job');
  assert.match(POST_RELEASE_WORKFLOW.slice(releaseJobIndex), /needs: artifact/);
  assert.doesNotMatch(POST_RELEASE_WORKFLOW.slice(releaseJobIndex), /needs: smoke/);
  assert.ok(contentsWriteIndex > releaseJobIndex, 'only the release job can write');
  assert.equal(POST_RELEASE_WORKFLOW.match(/contents: write/g)?.length, 1);
});

test('manual workflow runs are non-publishing and non-releasing by default', () => {
  assert.match(
    PUBLISH_WORKFLOW,
    /dry_run:\n\s+description: Dry run \(pack and verify, publish nothing\)\n\s+type: boolean\n\s+default: true/,
  );
  assert.match(
    POST_RELEASE_WORKFLOW,
    /create_release:\n\s+description: Create or update the GitHub release\n\s+type: boolean\n\s+default: false/,
  );
});
