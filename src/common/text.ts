/**
 * Small text helpers shared by the host and the webview.
 *
 * They live in `src/common` because both bundles use them, so nothing here may
 * import Node.js built-ins.
 */

const TRAILING_PUNCTUATION = new Set([".", ",", ";"]);

/**
 * Trims trailing sentence punctuation from a string, without a regular
 * expression: a quantified class anchored at the end of a long string is a
 * super-linear match, and advisory URLs are stripped on every failure card.
 */
export function StripTrailingPunctuation(value: string): string {
    let end = value.length;
    while (end > 0 && TRAILING_PUNCTUATION.has(value[end - 1] ?? "")) {
        end -= 1;
    }
    return end === value.length ? value : value.slice(0, end);
}
