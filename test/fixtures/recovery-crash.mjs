import fs from 'node:fs';
import { basename } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const CRASH_EXIT = 86;
const cutoff = Number(process.env.REORG_TEST_CRASH_AFTER);
const boundary = process.env.REORG_TEST_CRASH_BOUNDARY;
const rename = fs.renameSync;
let operations = 0;

fs.renameSync = (from, to) => {
  const workspaceSave = String(from).includes('/.reorg/') && String(from).endsWith('.json.tmp');
  const filesystemOperation = !workspaceSave && !basename(String(from)).startsWith('journal.json.tmp-');
  if (filesystemOperation) operations++;
  if (filesystemOperation && operations === cutoff && boundary === 'before') process.exit(CRASH_EXIT);
  if (filesystemOperation && operations === cutoff && boundary === 'throw-before') throw new Error('Simulated filesystem failure');
  const result = rename(from, to);
  if (filesystemOperation && operations === cutoff && boundary === 'after') process.exit(CRASH_EXIT);
  return result;
};
syncBuiltinESMExports();
