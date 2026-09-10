import { cn } from '@/lib/utils';

/**
 * A deliberately small Markdown renderer for the question editor's preview
 * tab. It exists because the candidate-facing renderer belongs to another
 * part of the app, and pulling a Markdown library in for one textarea is not
 * worth the bundle.
 *
 * Security: every span of user text goes through `escapeHtml` *before* any
 * tag is inserted, and the only tags in the output are ones this file writes.
 * Block structure is therefore detected on the raw line (so `>` still reads
 * as a blockquote) while the text inside it is always escaped.
 */

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

// No `javascript:`, no `data:` — an admin pasting a hostile link into a
// question description would otherwise ship it to every candidate.
const SAFE_HREF = /^(https?:\/\/|mailto:|\/|#)/i;

/** Private-use codepoint; stripped from the input so it cannot be forged. */
const SENTINEL = '\uE000';
const SENTINEL_RE = new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, 'g');

const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;

function renderInline(raw: string): string {
  const codes: string[] = [];
  // Code spans are lifted out first so `**` inside them stays literal.
  let text = escapeHtml(raw).replace(/`([^`]+)`/g, (_match, code: string) => {
    codes.push(code);
    return `${SENTINEL}${codes.length - 1}${SENTINEL}`;
  });

  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label: string, href: string) =>
    SAFE_HREF.test(href)
      ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : match,
  );
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');

  return text.replace(SENTINEL_RE, (_match, index: string) => `<code>${codes[Number(index)] ?? ''}</code>`);
}

export function renderMarkdown(source: string): string {
  const lines = source
    .split(SENTINEL)
    .join('')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (FENCE.test(line)) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // closing fence, or the end of input
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      out.push('<hr />');
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(3, (heading[1] ?? '#').length);
      out.push(`<h${level}>${renderInline(heading[2] ?? '')}</h${level}>`);
      i += 1;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      const body: string[] = [quote[1] ?? ''];
      i += 1;
      for (let next = QUOTE.exec(lines[i] ?? ''); next; next = QUOTE.exec(lines[i] ?? '')) {
        body.push(next[1] ?? '');
        i += 1;
      }
      out.push(`<blockquote><p>${renderInline(body.join(' '))}</p></blockquote>`);
      continue;
    }

    const listTag = BULLET.test(line) ? 'ul' : ORDERED.test(line) ? 'ol' : null;
    if (listTag) {
      const pattern = listTag === 'ul' ? BULLET : ORDERED;
      const items: string[] = [];
      for (let item = pattern.exec(lines[i] ?? ''); item; item = pattern.exec(lines[i] ?? '')) {
        items.push(`<li>${renderInline(item[1] ?? '')}</li>`);
        i += 1;
      }
      out.push(`<${listTag}>${items.join('')}</${listTag}>`);
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? '';
      if (
        !current.trim() ||
        FENCE.test(current) ||
        RULE.test(current) ||
        HEADING.test(current) ||
        QUOTE.test(current) ||
        BULLET.test(current) ||
        ORDERED.test(current)
      ) {
        break;
      }
      paragraph.push(current);
      i += 1;
    }
    out.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
  }

  return out.join('\n');
}

export function MarkdownPreview({ source, className }: { source: string; className?: string }) {
  const trimmed = source.trim();
  if (!trimmed) {
    return (
      <p className={cn('text-muted-foreground text-[13px] italic', className)}>
        Nothing to preview yet.
      </p>
    );
  }
  return (
    // Safe by construction: `renderMarkdown` escapes every span of user text
    // and emits only the tags written above.
    <div
      className={cn('markdown', className)}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(trimmed) }}
    />
  );
}
