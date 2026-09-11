import { describe, expect, it } from 'vitest';

import { candidateWelcomeEmail, escapeHtml } from '@/lib/email/templates';
import { publicEnv } from '@/lib/env';

const INPUT = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  temporaryPassword: 'Temp0rary1',
};

describe('escapeHtml', () => {
  it('escapes every character that could break out of markup or an attribute', () => {
    expect(escapeHtml(`<script>"a" & 'b'</script>`)).toBe(
      '&lt;script&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/script&gt;',
    );
  });

  // `&` first, or the entities produced by the later replacements get
  // double-escaped into visible `&amp;lt;` in the candidate's inbox.
  it('does not double-escape an ampersand it has just written', () => {
    expect(escapeHtml('Tom & <Jerry>')).toBe('Tom &amp; &lt;Jerry&gt;');
  });
});

describe('candidateWelcomeEmail', () => {
  it('addresses the candidate and carries the credentials in both parts', () => {
    const message = candidateWelcomeEmail(INPUT);

    expect(message.to).toBe('ada@example.com');
    expect(message.toName).toBe('Ada Lovelace');
    expect(message.subject).toContain('InterviewLab');
    for (const part of [message.text, message.html]) {
      expect(part).toContain('Ada Lovelace');
      expect(part).toContain('ada@example.com');
      expect(part).toContain('Temp0rary1');
    }
  });

  /**
   * A plain-text alternative is not decoration: a client that refuses HTML
   * would otherwise show the candidate an empty email and no way to sign in.
   */
  it('sends a usable text part alongside the HTML one', () => {
    const message = candidateWelcomeEmail(INPUT);

    expect(message.text).toContain(`${publicEnv.appUrl}/login`);
    expect(message.text).not.toContain('<');
  });

  it('links to the deployment sign-in page without doubling the slash', () => {
    const message = candidateWelcomeEmail(INPUT);

    expect(message.html).toContain(`${publicEnv.appUrl.replace(/\/+$/, '')}/login`);
    expect(message.html).not.toMatch(/[^:]\/\/login/);
  });

  it('names the assigned interview when there is one, and says so when there is not', () => {
    expect(candidateWelcomeEmail({ ...INPUT, interviewTitle: 'Backend screen' }).text).toContain(
      'Backend screen',
    );
    expect(candidateWelcomeEmail(INPUT).text).toContain('once it has been assigned');
  });

  /**
   * The name is admin-supplied free text that lands in someone's mail client.
   * The password alphabet happens to exclude these characters today, but
   * "today" is not a control and an unescaped `&` in a name is enough to
   * mangle the password rendered next to it.
   */
  it('escapes interpolated values in the HTML part', () => {
    const message = candidateWelcomeEmail({
      ...INPUT,
      name: '<img src=x onerror=alert(1)>',
      interviewTitle: 'Security & <Ops>',
    });

    expect(message.html).not.toContain('<img src=x');
    expect(message.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(message.html).toContain('Security &amp; &lt;Ops&gt;');
  });

  it('tells the candidate the password is single-use', () => {
    const message = candidateWelcomeEmail(INPUT);

    for (const part of [message.text, message.html]) {
      expect(part).toContain('choose your own password');
    }
  });
});
