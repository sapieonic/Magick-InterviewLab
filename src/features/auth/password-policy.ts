/**
 * Password rules, deliberately free of any server-only import.
 *
 * The hashing module pulls in a native Argon2 binding; when a Client
 * Component imported the policy constant from there, the whole binding was
 * dragged into the browser bundle and the build failed. Keeping the policy
 * pure means both sides can state the same rule to the user.
 */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

export function passwordProblem(value: string): string | null {
  if (value.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  }
  if (!/[a-zA-Z]/.test(value)) return 'Password must contain a letter.';
  if (!/[0-9]/.test(value)) return 'Password must contain a digit.';
  return null;
}
