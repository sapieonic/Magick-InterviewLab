/**
 * One clock, so a duration measured in the bridge and a duration measured in
 * the test loop are comparable. `performance.now()` is monotonic and immune to
 * the wall clock stepping mid-run (NTP, a laptop waking from sleep); `Date.now()`
 * is the fallback for a bare Node context such as the unit tests.
 */
export function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
