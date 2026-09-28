/**
 * The one-block `--json` rule: a command asked for JSON prints exactly one JSON document on stdout and nothing else there, so a caller parses the whole of stdout at once. Its answer on success, its `<tool>-error/1` document on failure. Notes, progress and warnings go to stderr, in JSON mode and in text mode alike. `renderResult` and `renderFailure` build what to print; `emit` prints it.
 */
import { errorDocument, errorParts, formatError } from './error.mjs';
const lines = (notes) => (notes && notes.length ? `${notes.join('\n')}\n` : '');
/** The JSON text of one document, as every family tool prints it: two-space indent and a final newline. */
export function jsonBlock(value) {
    return `${JSON.stringify(value === undefined ? null : value, null, 2)}\n`;
}
/** A command's answer: the JSON document or the text on stdout, the notes on stderr. */
export function renderResult(result, options) {
    const stdout = options.json ? jsonBlock(result.value) : result.text ? `${result.text}\n` : '';
    return { stdout, stderr: lines(result.notes), exitCode: result.exitCode ?? 0 };
}
/** A refusal: the text on stderr always, and in JSON mode the `<tool>-error/1` document as the one block on stdout. */
export function renderFailure(tool, err, options) {
    const text = (options.format ?? formatError)(err);
    return {
        stdout: options.json ? jsonBlock(errorDocument(tool, err, options.programs)) : '',
        stderr: text ? `${text.replace(/\n$/, '')}\n` : '',
        exitCode: errorParts(err).exitCode,
    };
}
/** Whether `stdout` is exactly one JSON document and nothing else (surrounding whitespace aside). */
export function isSingleJsonBlock(stdout) {
    if (!stdout.trim())
        return false;
    try {
        JSON.parse(stdout);
        return true;
    }
    catch {
        return false;
    }
}
/** Writes what was rendered and returns its exit code; the caller sets `process.exitCode` or exits. */
export function emit(rendered, streams = process) {
    if (rendered.stdout)
        streams.stdout.write(rendered.stdout);
    if (rendered.stderr)
        streams.stderr.write(rendered.stderr);
    return rendered.exitCode;
}
