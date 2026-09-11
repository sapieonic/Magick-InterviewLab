import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { CreatedCandidate } from '@/features/candidates/actions';

// The component imports its sibling Server Actions, which reach the Prisma
// singleton at module scope. Neither is exercised here — the component is
// pure — so both are stubbed to keep the render free of a database.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db/prisma', () => ({ prisma: {} }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { WelcomeEmailNote } = await import('@/components/admin/candidate-forms');

/**
 * `WelcomeEmailNote` is hook-free and browser-free, so it renders straight
 * through `react-dom/server` — the same approach as the Markdown suite, no
 * testing library added for the sake of a test.
 */
function render(status: CreatedCandidate['emailStatus']): string {
  return renderToStaticMarkup(
    React.createElement(WelcomeEmailNote, { status, email: 'ada@example.com' }),
  );
}

/**
 * The property under test is not the wording, it is *which outcomes are
 * allowed to be silent*. Only one is: the admin who cleared the checkbox
 * already knows. Every other outcome — including the two that look like
 * successes — has to say something, because the admin's next action (hand the
 * password over, or not) depends on it.
 */
describe('WelcomeEmailNote', () => {
  it('confirms a delivered invitation and names the recipient', () => {
    const html = render('sent');

    expect(html).toContain('emailed to');
    expect(html).toContain('ada@example.com');
  });

  // Accepted but deliberately not delivered. Reporting this as "sent" would
  // have staging look like it is mailing real candidates.
  it('distinguishes a sandboxed send from a real one', () => {
    const html = render('sandboxed');

    expect(html).toContain('sandbox');
    expect(html).not.toContain('were emailed to');
  });

  /**
   * Not an error banner: the candidate exists and the password is on screen.
   * It must also say the send cannot be retried, because it cannot — there is
   * no resend path short of resetting the password.
   */
  it('warns on a failed send and says the password cannot be emailed later', () => {
    const html = render('failed');

    expect(html).toContain('could not be sent');
    expect(html).toContain('without resetting the password');
  });

  /**
   * Only reachable when the admin ticked a box a different replica offered.
   * Grouping this with `not_requested` made it the one non-send with no
   * banner at all — on the case where the admin explicitly asked.
   */
  it('does not stay silent when the admin asked but the server cannot send', () => {
    const html = render('not_configured');

    expect(html).not.toBe('');
    expect(html).toContain('No email was sent');
  });

  it('renders nothing when no email was asked for', () => {
    expect(render('not_requested')).toBe('');
  });
});
