import { describe, expect, it } from 'vitest';

import { REVIEW_CSV_HEADER, toReviewCsv } from '@/components/admin/review-table';
import { EMPTY_ROLL_UP, type SubmissionRollUp } from '@/features/review/loop';
import type { ReviewAssessmentView, ReviewPanelView, ReviewRow } from '@/features/review/queries';

/**
 * The export, which is the queue's least supervised surface.
 *
 * Everything else this feature renders is read on a page that explains itself.
 * The CSV is read in a spreadsheet, by people who never saw the page, and it is
 * pasted next to columns somebody else added — so two things are pinned here.
 * That the header carries no ranking, because a spreadsheet is precisely where
 * a composite gets invented. And that a cell is escaped properly: a candidate
 * whose name contains a comma must not shift every column after it, and a
 * candidate whose name starts with `=` must not be executed.
 */

const ROLL_UP: SubmissionRollUp = {
  ...EMPTY_ROLL_UP,
  passedCount: 7,
  totalCount: 9,
  score: 78,
  attempts: 3,
  questionsAnswered: 2,
  autoSubmitted: 1,
  languages: ['JAVASCRIPT'],
};

function assessment(overrides: Partial<ReviewAssessmentView> = {}): ReviewAssessmentView {
  return {
    stageId: 'stage-1',
    interviewId: 'int-1',
    interviewTitle: 'Backend screen',
    interviewArchived: false,
    assignmentStatus: 'COMPLETED',
    startedAt: new Date('2026-03-10T09:00:00Z'),
    completedAt: new Date('2026-03-10T10:00:00Z'),
    elapsedMs: 60 * 60 * 1000,
    questionsTotal: 3,
    otherCodingStages: 0,
    lateCount: 0,
    rollUp: ROLL_UP,
    ...overrides,
  };
}

function panel(overrides: Partial<ReviewPanelView> = {}): ReviewPanelView {
  return { expected: 2, submitted: 1, outstanding: 1, disagrees: false, ...overrides };
}

/**
 * One queue row with sensible defaults. Nested objects are replaced wholesale
 * — `row({ panel: panel({ disagrees: null }) })` — so a test never has to state
 * more of the fixture than the rule it is about.
 */
function row(overrides: Partial<ReviewRow> = {}): ReviewRow {
  return {
    applicationId: 'app-1',
    status: 'ACTIVE',
    candidate: { id: 'c1', name: 'Ada Lovelace', email: 'ada@example.com', isActive: true },
    jobRole: { title: 'Backend Engineer', level: 'L4' },
    owner: { id: 'u1', name: 'Grace Hopper' },
    assessment: assessment(),
    codeRead: true,
    panel: panel(),
    stagesComplete: 2,
    stagesTotal: 4,
    waitingDays: 5,
    decision: null,
    loop: 'PANEL',
    ...overrides,
  };
}

/** RFC 4180 in reverse, so an assertion can name a column instead of an index. */
function parseLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

type ReviewCsvColumn = (typeof REVIEW_CSV_HEADER)[number];

/** The one data row of a single-row export, by column name. */
function cells(rows: readonly ReviewRow[]): Record<ReviewCsvColumn, string> {
  const csv = toReviewCsv(rows, 'latest');
  const lines = csv.split('\n');
  // Line 0 is the `# metric:` note, line 1 is the header, line 2 is the row.
  // A quoted newline inside a cell means the row spans lines, so the remainder
  // is rejoined before parsing.
  const parsed = parseLine(lines.slice(2).join('\n'));
  return Object.fromEntries(
    REVIEW_CSV_HEADER.map((name, index) => [name, parsed[index] ?? '']),
  ) as Record<ReviewCsvColumn, string>;
}

describe('REVIEW_CSV_HEADER', () => {
  it('offers no column a ranking could be read out of', () => {
    // The guard this whole file exists for. A spreadsheet is exactly where
    // somebody adds an "overall" column and starts sorting people by it, and
    // this export is what they would be pasting in. The system does not rank
    // candidates, so it must not ship a column that looks like it does.
    const banned = ['rank', 'overall', 'percentile', 'composite'];
    const offenders = REVIEW_CSV_HEADER.filter((column) =>
      banned.some((word) => column.toLowerCase().includes(word)),
    );

    expect(
      offenders,
      `The review CSV must not carry a ranking column. Found: ${offenders.join(', ')}. ` +
        `Scores are reported per question and per assessment; there is no composite, ` +
        `no percentile and no ordering the system picked. Name the new column for the ` +
        `fact it holds, or do not add it.`,
    ).toEqual([]);
  });

  it('names every column exactly once', () => {
    expect(new Set(REVIEW_CSV_HEADER).size).toBe(REVIEW_CSV_HEADER.length);
  });

  it('writes the header once, under a note saying which submission was counted', () => {
    const lines = toReviewCsv([row()], 'best').split('\n');
    expect(lines[0]).toContain('best');
    expect(lines[1]).toBe(REVIEW_CSV_HEADER.join(','));
    expect(lines).toHaveLength(3);
  });
});

describe('toReviewCsv', () => {
  it('emits the header alone when there is nothing to export', () => {
    const lines = toReviewCsv([], 'latest').split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(REVIEW_CSV_HEADER.join(','));
  });

  it('reports the row a reviewer would read off the page', () => {
    const fields = cells([row()]);
    expect(fields.candidate).toBe('Ada Lovelace');
    expect(fields.email).toBe('ada@example.com');
    expect(fields.role).toBe('Backend Engineer');
    expect(fields.mean_question_score).toBe('78');
    expect(fields.tests_passed).toBe('7');
    expect(fields.elapsed_minutes).toBe('60');
    expect(fields.code_read).toBe('yes');
    expect(fields.loop_step).toBe('PANEL');
  });

  it('leaves a cell blank rather than inventing a number for it', () => {
    // A candidate with no answers has no score, and an assessment with no
    // stamps has no elapsed time. Zero would be a claim.
    const fields = cells([
      row({
        assessment: assessment({ elapsedMs: null, rollUp: EMPTY_ROLL_UP }),
        waitingDays: null,
        jobRole: null,
        owner: null,
        decision: null,
      }),
    ]);

    expect(fields.mean_question_score).toBe('');
    expect(fields.elapsed_minutes).toBe('');
    expect(fields.waiting_days).toBe('');
    expect(fields.role).toBe('');
    expect(fields.owner).toBe('');
    expect(fields.decision).toBe('');
  });

  it('quotes a value containing a comma so it stays one column', () => {
    const csv = toReviewCsv(
      [row({ candidate: { id: 'c1', name: 'Lovelace, Ada', email: 'a@e.com', isActive: true } })],
      'latest',
    );

    expect(csv).toContain('"Lovelace, Ada"');
    expect(
      cells([
        row({ candidate: { id: 'c1', name: 'Lovelace, Ada', email: 'a@e.com', isActive: true } }),
      ]).candidate,
    ).toBe('Lovelace, Ada');
  });

  it('doubles a double quote inside a quoted value', () => {
    const name = 'Ada "The Countess" Lovelace';
    const csv = toReviewCsv(
      [row({ candidate: { id: 'c1', name, email: 'a@e.com', isActive: true } })],
      'latest',
    );

    expect(csv).toContain('"Ada ""The Countess"" Lovelace"');
    expect(
      cells([row({ candidate: { id: 'c1', name, email: 'a@e.com', isActive: true } })]).candidate,
    ).toBe(name);
  });

  it('quotes a value containing a newline so it stays one record', () => {
    const title = 'Backend screen\n(rewritten)';
    const csv = toReviewCsv([row({ assessment: assessment({ interviewTitle: title }) })], 'latest');

    expect(csv).toContain(`"${title}"`);
    expect(cells([row({ assessment: assessment({ interviewTitle: title }) })]).assessment).toBe(
      title,
    );
  });

  it('defuses a name a spreadsheet would execute', () => {
    // Formula injection. `=cmd|' /c calc'!A0` is a payload, not a name, and it
    // runs on open in more than one spreadsheet. The leading apostrophe makes
    // the cell text.
    const payload = "=cmd|' /c calc'!A0";
    const fields = cells([
      row({ candidate: { id: 'c1', name: payload, email: 'a@e.com', isActive: true } }),
    ]);

    expect(fields.candidate).toBe(`'${payload}`);
    expect(fields.candidate.startsWith('=')).toBe(false);
  });

  it('defuses every character a spreadsheet treats as the start of a formula', () => {
    for (const prefix of ['=', '+', '-', '@']) {
      const name = `${prefix}SUM(A1:A9)`;
      const fields = cells([
        row({ candidate: { id: 'c1', name, email: 'a@e.com', isActive: true } }),
      ]);
      expect(fields.candidate).toBe(`'${name}`);
    }
  });

  it('defuses a formula hiding behind leading whitespace', () => {
    // Several spreadsheets trim a cell before deciding whether it is a
    // formula, so a guard anchored hard at `=` waves ` =cmd()` straight
    // through and it executes on open exactly like the unpadded version.
    for (const name of [' =SUM(A1:A9)', '\t@SUM(A1:A9)', '  -2+3']) {
      const fields = cells([
        row({ candidate: { id: 'c1', name, email: 'a@e.com', isActive: true } }),
      ]);
      expect(fields.candidate).toBe(`'${name}`);
    }
  });

  it('escapes a payload that is also a quoting problem', () => {
    // The apostrophe goes on first, then the RFC 4180 quoting wraps the
    // result — getting that order wrong leaves an executable leading `=`.
    const name = '=HYPERLINK("http://x","click"), now';
    const fields = cells([
      row({ candidate: { id: 'c1', name, email: 'a@e.com', isActive: true } }),
    ]);

    expect(fields.candidate).toBe(`'${name}`);
  });

  it('says hidden, not no, when the panel split was withheld', () => {
    // Three states, and "hidden" is not "no". A blind round withheld a
    // scorecard from this viewer, so the split cannot be computed without
    // computing it over a subset — and a partial disagreement signal is worse
    // than none, because it reads as agreement.
    expect(cells([row({ panel: panel({ disagrees: null }) })]).panel_split).toBe('hidden');
    expect(cells([row({ panel: panel({ disagrees: false }) })]).panel_split).toBe('no');
    expect(cells([row({ panel: panel({ disagrees: true }) })]).panel_split).toBe('yes');
  });

  it('writes one record per row, in the order it was given them', () => {
    const csv = toReviewCsv(
      [
        row({ candidate: { id: 'c1', name: 'First', email: 'f@e.com', isActive: true } }),
        row({ candidate: { id: 'c2', name: 'Second', email: 's@e.com', isActive: true } }),
      ],
      'latest',
    );
    const lines = csv.split('\n');

    expect(lines).toHaveLength(4);
    expect(lines[2]?.startsWith('First,')).toBe(true);
    expect(lines[3]?.startsWith('Second,')).toBe(true);
  });
});
