import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RETRY_POLICY = Object.freeze({
  maxAttempts: 10,
  baseDelayMs: 10_000,
  maxDelayMs: 30_000,
});

const LOG_TAIL_LINES = 5;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(attempt, policy) {
  return Math.min(attempt * policy.baseDelayMs, policy.maxDelayMs);
}

export async function retryInstall({
  install,
  pause = wait,
  report = () => {},
  policy = RETRY_POLICY,
}) {
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    const result = await install(attempt);
    if (result.ok) return attempt;
    report({ attempt, result });
    if (attempt < policy.maxAttempts) {
      await pause(retryDelay(attempt, policy));
    }
  }
  throw new Error(`package did not become installable after ${policy.maxAttempts} attempts`);
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trimEnd();
  return {
    ok: result.status === 0,
    output: result.error ? result.error.message : output,
  };
}

function requireSuccess(result, label) {
  if (result.ok) return;
  const detail = result.output ? `\n${result.output}` : '';
  throw new Error(`${label} failed${detail}`);
}

function tail(text) {
  if (!text) return '(no npm output)';
  return text.split(/\r?\n/).slice(-LOG_TAIL_LINES).join('\n');
}

export async function smokePublished({
  npmCommand = 'npm',
  packageSpec,
  policy = RETRY_POLICY,
} = {}) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(scriptDir, '..', 'package.json'), 'utf8'));
  const spec = packageSpec ?? `${pkg.name}@${pkg.version}`;
  const work = mkdtempSync(join(tmpdir(), 'reorg-registry-smoke-'));

  try {
    requireSuccess(runCommand(npmCommand, ['init', '-y'], work), 'npm init');
    let attempt;
    try {
      attempt = await retryInstall({
        policy,
        install: () => runCommand(
          npmCommand,
          ['install', '--no-audit', '--no-fund', spec],
          work,
        ),
        report: ({ attempt: failedAttempt, result }) => {
          console.log(`Not resolvable yet (attempt ${failedAttempt}):`);
          console.log(tail(result.output));
        },
      });
    } catch (error) {
      throw new Error(
        `Error: ${spec} did not become installable from the registry\n`
        + 'If publication ran, this check cannot and does not undo it',
        { cause: error },
      );
    }

    const binaryName = process.platform === 'win32' ? 'reorg.cmd' : 'reorg';
    const binary = join(work, 'node_modules', '.bin', binaryName);
    const help = runCommand(binary, ['--help'], work);
    requireSuccess(help, `${binaryName} --help`);
    console.log(help.output.split(/\r?\n/, 1)[0]);
    console.log(`Installed ${spec} from the registry on attempt ${attempt}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  smokePublished().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
