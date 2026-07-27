// Cleanup signals: reasons an entry might be disposable, derived mostly from names.
//
// Why name over age. The obvious instinct is to rank a scratch directory by
// mtime -- old means stale means junk. Measured against a real one, that is
// backwards. The clearly-disposable entries (a `-backup-20260425` directory, a
// `.zip` still sitting beside its unpacked copy, a downloaded `.dmg`) had ages
// spanning 12 to 586 days, so age separated them from nothing; several were only
// days old. What age surfaced instead was the opposite -- an example image kept
// deliberately for two years, a reference screenshot, a script still in use.
// Age is a weak, noisy proxy. The name is frequently a direct statement of
// intent: someone wrote "backup" or "dryrun" or "tmp" because that is what it
// was for.
//
// So every signal here is name-based or structural, and none is age-based. Age
// remains visible on a row for context, and is deliberately not scored.
//
// These are hints, never actions. Nothing here marks anything for trash; the
// point is to put the likely candidates in front of a person who knows.

// A signal: { id, label, why, weight }. `weight` orders the list -- higher means
// a stronger claim that this is disposable. Nothing above 0.9: the tool does not
// get to be certain about someone else's files.
const SIGNAL = Object.freeze({
  UNPACKED_TWIN: 'unpacked-twin',
  ARCHIVE: 'archive',
  DISPOSABLE_NAME: 'disposable-name',
  INSTALLER: 'installer',
  SCRATCH_EXT: 'scratch-ext',
  DATE_STAMPED: 'date-stamped',
  VCS_CLONE: 'vcs-clone',
  BULK: 'bulk',
});

const ARCHIVE_RE = /\.(zip|tgz|tar|tar\.gz|tar\.bz2|tar\.xz|7z|rar|gz|bz2|xz)$/i;
const INSTALLER_RE = /\.(dmg|pkg|msi|exe|deb|rpm|appimage)$/i;
const SCRATCH_EXT_RE = /\.(tmp|temp|bak|old|orig|swp|swo|log|cache|crdownload|part|download)$/i;

// Words people use when they mean "a copy I took in case something went wrong".
//
// Position is what separates a status marker from a subject. A marker is appended
// to a name that already existed -- `work-backup`, `state-presync.json`, `foo.tmp`
// -- optionally followed by a date or extension. A subject appears mid-name with
// more words after it, because the name is a sentence about a topic:
// `2026-07-23-sh-output-format-dryrun-enforcement.md` is a spec ABOUT dry-run
// enforcement, and `backup-strategy-notes.md` is a document about backups. Both
// were false positives on real directories, so the word has to sit at the end,
// with nothing after it but a timestamp, a counter, or the extension.
const INTENT_WORD_LIST =
  'backup|bak|dryrun|dry-run|prerewrite|pre-rewrite|presync|pre-sync|prepurge|pre-purge|scratch|tmp|temp|junk|deleteme|delete-me|obsolete|deprecated|superseded';

// <word>, then optionally a date/counter, then optionally an extension chain, then
// end. Extensions allow an inner hyphen so `.gitcrypt-key` counts as one -- a real
// name (`x-backup-prepurge.gitcrypt-key`) needed it, and a hyphenated extension is
// still an extension rather than another word of subject matter.
const INTENT_WORDS = new RegExp(
  `(^|[-_. ])(${INTENT_WORD_LIST})` +
    `([-_. ](\\d{6,8}|\\d{4}-\\d{2}-\\d{2})([-_. ]\\d{4,6})?)?` +
    `(\\.[A-Za-z0-9]+(-[A-Za-z0-9]+)*)*$`,
  'i'
);

// Only meaningful as the entire trailing token, and only after a short stem.
// "spam-and-trash.mbox" ends in "trash" but is describing its contents, so the
// word has to stand alone as the last segment AND not be part of a longer phrase
// -- `notes-old.md` yes, `all-mail-including-spam-and-trash.mbox` no. The
// hyphen-count guard is what separates the two: a name built from many words is
// prose about a subject, not a version marker appended to a filename.
const DESCRIPTIVE_SUFFIX = /[-_. ](copy|copy \d+|duplicate|old|discard|snapshot)(\s*\(\d+\))?(\.[a-z0-9]+)?$/i;
const MAX_STEM_SEGMENTS = 4;

function looksLikeVersionSuffix(name) {
  const m = DESCRIPTIVE_SUFFIX.exec(name);
  if (!m) return null;
  // Count the words before the suffix. Few words => a filename with a marker
  // tacked on. Many => a descriptive sentence that happens to end in the word.
  const stem = name.slice(0, m.index);
  const segments = stem.split(/[-_. ]+/).filter(Boolean).length;
  return segments > 0 && segments <= MAX_STEM_SEGMENTS ? m : null;
}

// A trailing date or build stamp: 20260425, 2026-04-25, 20260425-041006. Strong
// signal on its own only when paired with something else, because plenty of
// deliberately-kept notes are dated too.
const DATE_STAMP_RE = /(^|[-_.])(\d{8}|\d{4}-\d{2}-\d{2})([-_.]\d{4,6})?([-_.]|$)/;

const VCS_CLONE_RE = /\.git$/;

/** Strip one archive extension, so `foo.tar.gz` -> `foo` and `foo.zip` -> `foo`. */
export function archiveBase(name) {
  return name
    .replace(/\.tar\.(gz|bz2|xz)$/i, '')
    .replace(/\.(zip|tgz|tar|7z|rar|gz|bz2|xz)$/i, '');
}

/**
 * Score one node. `siblings` is a Set of sibling names, used for the structural
 * checks a name alone cannot make.
 *
 * Returns an array of signals, strongest first.
 */
export function signalsFor(node, siblings, opts = {}) {
  const bulkOver = opts.bulkOver ?? 400;
  const out = [];
  const name = node.name;
  const isDir = node.kind === 'dir';

  // --- structural: an archive whose unpacked contents sit right beside it ------
  // The single most actionable finding in a real scratch directory, and pure
  // duplication: one of the two is redundant whichever you keep.
  if (!isDir && ARCHIVE_RE.test(name)) {
    const base = archiveBase(name);
    if (base && base !== name && siblings.has(base)) {
      out.push({
        id: SIGNAL.UNPACKED_TWIN,
        label: 'unpacked copy sits beside it',
        why: `"${base}" is right here, so this archive and its contents are duplicated`,
        weight: 0.9,
      });
    } else {
      out.push({
        id: SIGNAL.ARCHIVE,
        label: 'archive',
        why: 'compressed archive: often re-downloadable, or already unpacked elsewhere',
        weight: 0.35,
      });
    }
  }

  // A directory whose archive is still present -- the same finding, other side.
  if (isDir) {
    for (const ext of ['.zip', '.tgz', '.tar.gz', '.tar', '.7z']) {
      if (siblings.has(name + ext)) {
        out.push({
          id: SIGNAL.UNPACKED_TWIN,
          label: `unpacked from ${name}${ext}`,
          why: `the archive "${name}${ext}" is still here, so this is a second copy of it`,
          weight: 0.75,
        });
        break;
      }
    }
  }

  // --- the name says what it was for ------------------------------------------
  const intent = INTENT_WORDS.exec(name);
  const descriptive = looksLikeVersionSuffix(name);
  if (intent) {
    out.push({
      id: SIGNAL.DISPOSABLE_NAME,
      label: `name says "${intent[2].toLowerCase()}"`,
      why: 'the name states its purpose was temporary or a safety copy',
      weight: 0.8,
    });
  } else if (descriptive) {
    out.push({
      id: SIGNAL.DISPOSABLE_NAME,
      label: `name ends in "${descriptive[1].toLowerCase()}"`,
      why: 'a trailing "copy"/"old"-style suffix usually marks a superseded version',
      weight: 0.55,
    });
  }

  if (!isDir && INSTALLER_RE.test(name)) {
    out.push({
      id: SIGNAL.INSTALLER,
      label: 'installer',
      why: 'installers are re-downloadable, and usually dead weight once installed',
      weight: 0.7,
    });
  }

  if (!isDir && SCRATCH_EXT_RE.test(name)) {
    out.push({
      id: SIGNAL.SCRATCH_EXT,
      label: 'scratch extension',
      why: 'the extension marks this as a byproduct rather than something authored',
      weight: 0.65,
    });
  }

  // A bare `.git` directory that is not a working copy: a mirror or bare clone
  // kept as a backup, which is exactly what people forget to remove.
  if (isDir && VCS_CLONE_RE.test(name)) {
    out.push({
      id: SIGNAL.VCS_CLONE,
      label: 'bare git clone',
      why: 'a bare or mirror clone, typically kept as a one-off safety copy',
      weight: 0.6,
    });
  }

  // Date stamps only count alongside another signal -- on their own, plenty of
  // deliberately-kept notes and specs are dated.
  if (DATE_STAMP_RE.test(name) && out.length) {
    out.push({
      id: SIGNAL.DATE_STAMPED,
      label: 'date-stamped',
      why: 'a timestamp in the name suggests a point-in-time copy, not a living file',
      weight: 0.3,
    });
  }

  // --- structural: weight and emptiness ---------------------------------------
  if (isDir && node.files != null && node.files > bulkOver) {
    out.push({
      id: SIGNAL.BULK,
      label: 'bulky',
      why: `${node.files} files: worth a decision purely because of what it costs to keep`,
      weight: 0.2,
    });
  }
  // Emptiness is deliberately NOT a signal. An empty directory is very often
  // intentional -- a mount point, a firmlink target, a placeholder kept so a path
  // resolves -- and it costs nothing to keep. Testing this against a real scratch
  // directory flagged a set of empty numbered dirs that turned out to be firmlink
  // targets declared in synthetic.conf: deleting them would have broken paths,
  // for no space saved. Cheap to keep plus frequently intentional is a bad
  // combination to suggest acting on.

  return out.sort((a, b) => b.weight - a.weight);
}

/**
 * Annotate a whole scan. Returns Map<id, {signals, score}>, where score is the
 * strongest signal's weight nudged up by corroborating ones -- two independent
 * reasons are a better bet than one, without letting a pile of weak hints
 * outrank a single decisive one.
 */
export function analyze(scanResult, opts = {}) {
  const siblingsByParent = new Map();
  for (const n of scanResult.nodes) {
    if (!siblingsByParent.has(n.parentId)) siblingsByParent.set(n.parentId, new Set());
    siblingsByParent.get(n.parentId).add(n.name);
  }

  const out = new Map();
  for (const n of scanResult.nodes) {
    const siblings = siblingsByParent.get(n.parentId) || new Set();
    const signals = signalsFor(n, siblings, opts);
    if (!signals.length) continue;
    const top = signals[0].weight;
    const rest = signals.slice(1).reduce((a, s) => a + s.weight, 0);
    const score = Math.min(0.95, top + rest * 0.15);
    out.set(n.id, { signals, score, bytes: n.bytes ?? 0 });
  }

  // Drop anything inside an already-flagged directory. Suggesting a `refs/` file
  // inside `cc-skills-mirror-backup-prerewrite.git` adds nothing: the decision is
  // about the clone, and listing its innards buries the handful of findings that
  // actually need a person's judgement.
  for (const id of [...out.keys()]) {
    let parent = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : null;
    while (parent) {
      if (out.has(parent)) {
        out.delete(id);
        break;
      }
      parent = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : null;
    }
  }
  return out;
}

/** The candidates worth showing, strongest first. Ties break on size. */
export function ranked(analysis, limit = 40) {
  return [...analysis.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.score - a.score || b.bytes - a.bytes)
    .slice(0, limit);
}

export { SIGNAL };
