/**
 * Only same-origin absolute paths — never an attacker-supplied URL.
 *
 * Rejecting `//host` is not enough. Browsers normalise a backslash to a
 * forward slash in the authority position, so `/\evil.example.com/pwn`
 * passes a naive `startsWith('/') && !startsWith('//')` check and then
 * navigates off-site — the classic post-authentication phishing primitive,
 * and one this function shipped with. Control characters are stripped first
 * because a leading tab or newline is also ignored during URL parsing.
 */
export function safeRedirect(next: string | undefined): string | null {
  if (!next) return null;
  const cleaned = next.replace(/[\u0000-\u001f\u007f]/g, '');
  // Must start with a single slash followed by something that is neither a
  // slash nor a backslash: that is the only shape that cannot become an
  // authority.
  if (!/^\/(?![/\\])/.test(cleaned)) return null;
  return cleaned;
}
