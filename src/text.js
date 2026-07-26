// Shared "is this readable text?" heuristic.
//
// Both the preview endpoint and the summarizer need this answer, and they must
// agree: if one calls a file text and the other calls it binary, the UI shows a
// preview for something the summarizer silently skipped (or worse, feeds a model
// a few kilobytes of noise). A null byte is the classic tell, but random binary
// often has none in its first block, so control-character density matters too.

const SAMPLE = 8000;
const CONTROL_RATIO = 0.08;

/** True when `buf` looks like text a person could read. */
export function looksTextual(buf) {
  const n = Math.min(buf.length, SAMPLE);
  if (n === 0) return true; // an empty file is trivially text
  let control = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 0) return false; // NUL: decisive
    // Anything below space that is not tab/LF/CR/FF/ESC is a control byte. UTF-8
    // continuation bytes (>= 0x80) are deliberately not counted -- they are normal
    // in any non-English text file.
    if (c < 9 || (c > 13 && c < 27) || (c > 27 && c < 32)) control++;
  }
  return control / n < CONTROL_RATIO;
}
