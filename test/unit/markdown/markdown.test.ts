import { describe, expect, it } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Markdown } from '@/components/markdown';

/**
 * `Markdown` is hook-free and browser-free by design, so it renders straight
 * through `react-dom/server` — no DOM, no testing library, no dependency
 * added for the sake of a test.
 *
 * The file is `.test.ts` rather than `.test.tsx` because `vitest.config.ts`
 * only collects `test/unit/**\/*.test.ts`; `React.createElement` costs one
 * line and keeps the suite discoverable.
 */
function render(content: string): string {
  return renderToStaticMarkup(React.createElement(Markdown, { content }));
}

/**
 * Every raw HTML tag in the output. Escaped input (`&lt;img …&gt;`) carries
 * no raw angle brackets, so anything this returns is markup the component
 * chose to emit — which is the only place an injected attribute could live.
 */
function tagsOf(html: string): string[] {
  return html.match(/<[^>]*>/g) ?? [];
}

/** No emitted tag may carry an inline event handler, whatever the input said. */
function expectNoEventHandlerAttributes(html: string): void {
  for (const tag of tagsOf(html)) {
    expect(tag).not.toMatch(/\son[a-z]+\s*=/i);
  }
}

/**
 * Question descriptions are admin-authored, but "trusted author" is not a
 * security model: the same renderer shows them to every candidate, and an
 * admin account is exactly what an attacker phishes for. The component builds
 * React elements and never touches `dangerouslySetInnerHTML`, so the property
 * to pin is that no input path produces live markup.
 */
describe('Markdown — untrusted content cannot become live markup', () => {
  it('escapes a script tag instead of emitting one', () => {
    const html = render('Look: <script>alert(1)</script>');

    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes an image with an onerror handler instead of emitting an element', () => {
    const html = render('<img src=x onerror=alert(1)>');

    expect(html).not.toMatch(/<img/i);
    expectNoEventHandlerAttributes(html);
    // The payload survives as visible text, which is the correct outcome.
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes an iframe and an svg/onload payload', () => {
    const html = render('<iframe src="javascript:alert(1)"></iframe>\n\n<svg onload=alert(1)>');

    expect(html).not.toMatch(/<(iframe|svg)/i);
    expectNoEventHandlerAttributes(html);
  });

  // `safeHref` allow-lists the scheme; anything else is demoted to plain text
  // rather than being emitted as an anchor a candidate could click.
  it.each([
    ['javascript:', '[x](javascript:alert(1))'],
    ['uppercase javascript:', '[x](JAVASCRIPT:alert(1))'],
    ['data:', '[x](data:text/html;base64,PHNjcmlwdD4=)'],
    ['vbscript:', '[x](vbscript:msgbox(1))'],
  ])('demotes a %s link target to plain text', (_label, source) => {
    const html = render(source);

    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href');
  });

  /**
   * A quote inside the href is the classic attribute-breakout attempt. React
   * escapes attribute values, so the quote can never terminate the attribute
   * — but the assertion is on the emitted tag, not on React's reputation.
   */
  it('cannot be broken out of an href attribute with a quote', () => {
    const html = render('[t](https://example.com"onmouseover="alert(1))');

    expectNoEventHandlerAttributes(html);
    expect(html).not.toContain('onmouseover="alert');
    expect(html).toContain('&quot;');
  });

  it('escapes an attribute-breaking attempt in a link title, which is not link syntax at all', () => {
    const html = render('[t](https://example.com" onmouseover="alert(1))');

    expectNoEventHandlerAttributes(html);
    expect(html).not.toContain('<a ');
  });

  it('escapes HTML that appears inside a fenced code block', () => {
    const html = render('```html\n<script>alert(1)</script>\n```');

    expect(html).not.toContain('<script');
    expect(html).toContain('<pre><code class="language-html">');
  });

  it('escapes HTML that appears inside emphasis', () => {
    const html = render('**<img src=x onerror=alert(1)>**');

    expect(html).not.toMatch(/<img/i);
    expectNoEventHandlerAttributes(html);
    expect(html).toContain('<strong>');
  });
});

describe('Markdown — safe links', () => {
  it('renders an https link that cannot be used to reverse-tabnab', () => {
    const html = render('[docs](https://example.com/a)');

    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it.each([
    ['mailto', '[mail](mailto:a@b.com)', 'href="mailto:a@b.com"'],
    ['same-document anchor', '[top](#top)', 'href="#top"'],
    ['root-relative path', '[home](/admin)', 'href="/admin"'],
  ])('allows a %s target', (_label, source, expected) => {
    expect(render(source)).toContain(expected);
  });
});

describe('Markdown — block grammar', () => {
  it('renders headings at the requested level, capped at six', () => {
    const html = render('# One\n\n### Three\n\n###### Six');

    expect(html).toContain('<h1>One</h1>');
    expect(html).toContain('<h3>Three</h3>');
    expect(html).toContain('<h6>Six</h6>');
  });

  it('renders bold, italic and inline code', () => {
    const html = render('**b** and *i* and `x = 1`');

    expect(html).toContain('<strong>b</strong>');
    expect(html).toContain('<em>i</em>');
    expect(html).toContain('<code>x = 1</code>');
  });

  // Code spans win the precedence contest, so markup inside backticks is
  // literal — which is what a question about `**kwargs` needs.
  it('leaves emphasis markers inside a code span literal', () => {
    expect(render('use `a**b**c`')).toContain('<code>a**b**c</code>');
  });

  it('renders a fenced block with its language class and no reflowing', () => {
    const html = render('```python\ndef f():\n    return 1\n```');

    expect(html).toContain(
      '<pre><code class="language-python">def f():\n    return 1</code></pre>',
    );
  });

  it('renders an unordered list, an ordered list and a nested list', () => {
    const html = render('- one\n- two\n  - nested\n\n1. first\n2. second');

    expect(html).toContain('<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>');
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>');
  });

  it('renders a blockquote containing inline markup', () => {
    expect(render('> quoted **bold**')).toContain(
      '<blockquote><p>quoted <strong>bold</strong></p></blockquote>',
    );
  });

  it('renders a horizontal rule', () => {
    expect(render('above\n\n---\n\nbelow')).toContain('<hr/>');
  });

  it('renders a table with a header row and body cells', () => {
    const html = render('| in | out |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |');

    expect(html).toContain('<th>in</th><th>out</th>');
    expect(html).toContain('<td>1</td><td>2</td>');
    expect(html).toContain('<td>3</td><td>4</td>');
  });

  it('joins a soft-wrapped paragraph rather than breaking it', () => {
    expect(render('one\ntwo')).toContain('<p>one two</p>');
  });

  it('renders an empty description as an empty container rather than throwing', () => {
    expect(render('')).toBe('<div class="markdown"></div>');
  });
});

/**
 * This is a coding-interview product: question descriptions are full of
 * identifiers. CommonMark forbids intraword `_` emphasis for exactly this
 * reason, and without the guard a description discussing `max_value` renders
 * with the identifier chopped up and the underscores eaten — wrong, and
 * confusing precisely when the identifier is the thing being asked about.
 */
describe('Markdown — identifiers survive intact', () => {
  it.each([
    ['snake_case', 'Return max_value from the list.', 'max_value'],
    ['a longer snake_case name', 'Call compute_running_total(xs).', 'compute_running_total'],
    ['SCREAMING_SNAKE_CASE', 'The limit is MY_CONST_LIMIT.', 'MY_CONST_LIMIT'],
    ['a dunder property access', 'Set window.__X_Y=1 first.', 'window.__X_Y=1'],
    ['a leading-underscore name', 'Ignore _private helpers and _other ones.', '_private'],
  ])('leaves %s literal', (_label, source, identifier) => {
    const html = render(source);

    expect(html).toContain(identifier);
    expect(html).not.toContain('<em>');
    expect(html).not.toContain('<strong>');
  });

  it('still renders underscore emphasis around whole words', () => {
    const html = render('_emphasis_ and __strong words__ here');

    expect(html).toContain('<em>emphasis</em>');
    expect(html).toContain('<strong>strong words</strong>');
  });

  /**
   * `__init__` escapes the intraword guard on its own: the underscores are
   * the outermost characters of the token, so both boundaries are satisfied
   * and CommonMark really does render it bold. The renderer therefore also
   * requires whitespace inside a `__…__` run — because `__init__`,
   * `__name__` and `__main__` are the identifiers a Python question is most
   * likely to name, and `**bold**` already expresses single-word bold
   * unambiguously.
   */
  it('leaves a dunder identifier such as __init__ literal', () => {
    const html = render('Override __init__ and __repr__ in your class.');

    expect(html).toContain('__init__');
    expect(html).toContain('__repr__');
    expect(html).not.toContain('<strong>');
  });

  it('leaves a single-word __token__ literal, since **bold** covers that case', () => {
    expect(render('the __sentinel__ value')).toContain('__sentinel__');
    expect(render('the **sentinel** value')).toContain('<strong>sentinel</strong>');
  });
});
