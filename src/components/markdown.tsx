import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A small Markdown subset renderer for question descriptions.
 *
 * Hand-rolled rather than a dependency: the surface we need is fixed
 * (headings, emphasis, code, links, lists, quotes, rules, tables) and every
 * markdown library worth using drags in an HTML sanitiser we would then have
 * to configure correctly anyway.
 *
 * Safety: this builds React elements — it never assembles an HTML string and
 * there is no `dangerouslySetInnerHTML` anywhere in the file. React escapes
 * text children, so an admin-authored description containing `<script>` or an
 * `onerror=` attribute renders as literal characters. The one place raw input
 * could still become live is a link target, so hrefs go through `safeHref`
 * and anything that is not http/https/mailto or a same-document reference is
 * demoted to plain text.
 *
 * Runs identically on the server and the client (no hooks, no browser APIs),
 * so a Server Component can render it directly.
 */

type Blocks = React.ReactNode[];

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const UL_ITEM = /^([ \t]*)([-*+])[ \t]+(.*)$/;
const OL_ITEM = /^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/;
const TABLE_DELIMITER = /^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/;

/**
 * Inline grammar, one alternation so precedence is explicit and a single pass
 * covers the string. Group order is the precedence order: code spans win over
 * everything (so `**` inside backticks stays literal), then links, then bold,
 * then italic.
 */
const INLINE_SOURCE = [
  '`([^`\\n]+)`', // 1: code
  '\\[([^\\]\\n]*)\\]\\(([^()\\s]*)\\)', // 2: link text, 3: href
  '\\*\\*([\\s\\S]+?)\\*\\*', // 4: **bold**
  '__([^_]+?)__', // 5: __bold__
  '\\*([^*\\n]+?)\\*', // 6: *italic*
  '_([^_\\n]+?)_', // 7: _italic_
].join('|');

const SAFE_PROTOCOL = /^(?:https?:|mailto:)/i;

/** Anything not on this list renders as text — `javascript:` never gets an href. */
function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (href === '') return null;
  if (href.startsWith('#') || href.startsWith('/')) return href;
  return SAFE_PROTOCOL.test(href) ? href : null;
}

function leadingSpaces(line: string): number {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0].replace(/\t/g, '  ').length : 0;
}

interface ListItemMatch {
  indent: number;
  ordered: boolean;
  text: string;
  start: number;
}

function matchListItem(line: string): ListItemMatch | null {
  const ul = UL_ITEM.exec(line);
  if (ul) {
    return { indent: leadingSpaces(ul[1] ?? ''), ordered: false, text: ul[3] ?? '', start: 1 };
  }
  const ol = OL_ITEM.exec(line);
  if (ol) {
    return {
      indent: leadingSpaces(ol[1] ?? ''),
      ordered: true,
      text: ol[3] ?? '',
      start: Number.parseInt(ol[2] ?? '1', 10) || 1,
    };
  }
  return null;
}

function renderInline(text: string, key: string): React.ReactNode[] {
  // A fresh regex per call: this function recurses (bold containing a link,
  // say) and a shared /g regex would have its lastIndex trampled mid-scan.
  const re = new RegExp(INLINE_SOURCE, 'g');
  const out: React.ReactNode[] = [];
  let cursor = 0;
  let seq = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (match.index > cursor) out.push(text.slice(cursor, match.index));
    const k = `${key}i${seq++}`;
    const [full, code, linkText, linkHref, boldStar, boldUnderscore, emStar, emUnderscore] = match;

    if (code !== undefined) {
      out.push(<code key={k}>{code}</code>);
    } else if (linkText !== undefined && linkHref !== undefined) {
      const href = safeHref(linkHref);
      out.push(
        href ? (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer">
            {renderInline(linkText, k)}
          </a>
        ) : (
          <React.Fragment key={k}>{full}</React.Fragment>
        ),
      );
    } else if (boldStar !== undefined || boldUnderscore !== undefined) {
      out.push(<strong key={k}>{renderInline(boldStar ?? boldUnderscore ?? '', k)}</strong>);
    } else if (emStar !== undefined || emUnderscore !== undefined) {
      out.push(<em key={k}>{renderInline(emStar ?? emUnderscore ?? '', k)}</em>);
    }

    cursor = match.index + full.length;
  }

  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

function isFenceClose(line: string, marker: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith(marker[0] ?? '`') &&
    trimmed.length >= marker.length &&
    /^[`~]+$/.test(trimmed)
  );
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isTableStart(lines: string[], index: number): boolean {
  const head = lines[index] ?? '';
  const delim = lines[index + 1];
  return (
    head.includes('|') && delim !== undefined && TABLE_DELIMITER.test(delim) && delim.includes('-')
  );
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? '';
  if (line.trim() === '') return true;
  if (FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line)) return true;
  if (matchListItem(line) !== null) return true;
  return isTableStart(lines, index);
}

function parseBlocks(lines: string[], key: string): Blocks {
  const out: Blocks = [];
  let i = 0;
  let seq = 0;
  const nextKey = () => `${key}b${seq++}`;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? '```';
      const lang = fence[2] ?? '';
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !isFenceClose(lines[i] ?? '', marker)) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // the closing fence, or past the end for an unterminated block
      out.push(
        <pre key={nextKey()}>
          <code className={lang ? `language-${lang}` : undefined}>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min((heading[1] ?? '#').length, 6);
      const tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      const k = nextKey();
      out.push(React.createElement(tag, { key: k }, renderInline(heading[2] ?? '', k)));
      i += 1;
      continue;
    }

    if (HR.test(line)) {
      out.push(<hr key={nextKey()} />);
      i += 1;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      const inner: string[] = [quote[1] ?? ''];
      i += 1;
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i] ?? '');
        if (!q) break;
        inner.push(q[1] ?? '');
        i += 1;
      }
      const k = nextKey();
      out.push(<blockquote key={k}>{parseBlocks(inner, k)}</blockquote>);
      continue;
    }

    if (isTableStart(lines, i)) {
      const header = splitTableRow(line);
      i += 2; // header + delimiter
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim() !== '') {
        rows.push(splitTableRow(lines[i] ?? ''));
        i += 1;
      }
      const k = nextKey();
      out.push(
        <div key={k} className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                {header.map((cell, c) => (
                  <th key={`${k}h${c}`}>{renderInline(cell, `${k}h${c}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={`${k}r${r}`}>
                  {header.map((_, c) => (
                    <td key={`${k}r${r}c${c}`}>{renderInline(row[c] ?? '', `${k}r${r}c${c}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const item = matchListItem(line);
    if (item) {
      const k = nextKey();
      const { node, next } = parseList(lines, i, item, k);
      out.push(node);
      i = next;
      continue;
    }

    // Paragraph: run to the next blank line or block opener. Lines are joined
    // with a space because a single newline is not a break in Markdown.
    const paragraph: string[] = [line];
    i += 1;
    while (i < lines.length && !startsBlock(lines, i)) {
      paragraph.push(lines[i] ?? '');
      i += 1;
    }
    const k = nextKey();
    out.push(<p key={k}>{renderInline(paragraph.join(' ').trim(), k)}</p>);
  }

  return out;
}

function parseList(
  lines: string[],
  start: number,
  first: ListItemMatch,
  key: string,
): { node: React.ReactNode; next: number } {
  const ordered = first.ordered;
  const baseIndent = first.indent;
  const items: string[][] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const item = matchListItem(line);

    if (item && item.indent <= baseIndent + 1) {
      if (item.ordered !== ordered) break;
      items.push([item.text]);
      i += 1;
      continue;
    }

    const current = items[items.length - 1];
    if (!current) break;

    if (line.trim() === '') {
      // A blank line only stays inside the list if something indented follows.
      const ahead = lines[i + 1] ?? '';
      const aheadItem = matchListItem(ahead);
      const continues =
        (aheadItem !== null &&
          aheadItem.indent <= baseIndent + 1 &&
          aheadItem.ordered === ordered) ||
        (ahead.trim() !== '' && leadingSpaces(ahead) >= baseIndent + 2);
      if (!continues) break;
      current.push('');
      i += 1;
      continue;
    }

    if (leadingSpaces(line) >= baseIndent + 2) {
      current.push(line.slice(Math.min(leadingSpaces(line), baseIndent + 2)));
      i += 1;
      continue;
    }

    break;
  }

  const rendered = items.map((itemLines, index) => {
    const k = `${key}li${index}`;
    // Leading plain lines are the item's own text; anything after them (a
    // nested list, a fenced block) is parsed as blocks so nesting works.
    const lead: string[] = [];
    let j = 0;
    while (j < itemLines.length) {
      const l = itemLines[j] ?? '';
      if (
        l.trim() === '' ||
        matchListItem(l) ||
        FENCE.test(l) ||
        QUOTE.test(l) ||
        HEADING.test(l)
      ) {
        break;
      }
      lead.push(l.trim());
      j += 1;
    }
    const rest = itemLines.slice(j);
    return (
      <li key={k}>
        {lead.length > 0 ? renderInline(lead.join(' '), k) : null}
        {rest.some((l) => l.trim() !== '') ? parseBlocks(rest, k) : null}
      </li>
    );
  });

  const node = ordered ? (
    <ol key={key} start={first.start === 1 ? undefined : first.start}>
      {rendered}
    </ol>
  ) : (
    <ul key={key}>{rendered}</ul>
  );

  return { node, next: i };
}

export function Markdown({ content, className }: { content: string; className?: string }) {
  // No memo: this has to run in a Server Component too, and the parse is a
  // few hundred microseconds on a question description.
  const blocks = parseBlocks(content.replace(/\r\n?/g, '\n').split('\n'), 'md');
  return <div className={cn('markdown', className)}>{blocks}</div>;
}
