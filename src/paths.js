import { lstatSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// Inspect each directory entry without following links below the selected root
export function directoryProblem(root, path) {
  const rel = relative(resolve(root), resolve(root, path));
  let current = '';
  for (const component of rel.split(sep).filter(Boolean)) {
    current = join(current, component);
    let entry;
    try {
      entry = lstatSync(join(root, current));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      return `${current} cannot be inspected (${error.code || error.message}).`;
    }
    if (entry.isSymbolicLink()) return `${current} is a symbolic link; refusing to follow it.`;
    if (!entry.isDirectory()) return `${current} is not a directory.`;
  }
  return null;
}
