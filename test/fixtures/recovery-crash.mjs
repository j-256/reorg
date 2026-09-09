import fs from 'node:fs';
import { basename, dirname } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const CRASH_EXIT = 86;
const WORKSPACE_TEMP_FILES = new Set(['plan.json.tmp', 'scan.json.tmp', 'view.json.tmp', 'workspace.json.tmp']);
const JOURNAL_TEMP_FILE = /^journal\.json\.tmp-[0-9a-f-]+$/;
const cutoff = Number(process.env.REORG_TEST_CRASH_AFTER);
const boundary = process.env.REORG_TEST_CRASH_BOUNDARY;
const rename = fs.renameSync;
let operations = 0;

fs.renameSync = (from, to) => {
  const source = String(from);
  const name = basename(source);
  const parent = dirname(source);
  const workspaceSave = basename(parent) === '.reorg' && WORKSPACE_TEMP_FILES.has(name);
  const journalSave = basename(dirname(parent)) === 'runs' && basename(dirname(dirname(parent))) === '.reorg' && JOURNAL_TEMP_FILE.test(name);
  const filesystemOperation = !workspaceSave && !journalSave;
  if (filesystemOperation) operations++;
  if (filesystemOperation && operations === cutoff && boundary === 'before') process.exit(CRASH_EXIT);
  if (filesystemOperation && operations === cutoff && boundary === 'throw-before') throw new Error('Simulated filesystem failure');
  const result = rename(from, to);
  if (filesystemOperation && operations === cutoff && boundary === 'after') process.exit(CRASH_EXIT);
  return result;
};
syncBuiltinESMExports();
