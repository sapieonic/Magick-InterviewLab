import Link from 'next/link';
import { EyeOff, Split, TriangleAlert } from 'lucide-react';
import type { Recommendation } from '@/generated/prisma/enums';
import {
  RECOMMENDATION_LABELS,
  ConfidenceBadge,
  FeedbackStatusBadge,
  RecommendationBadge,
  ScoreBadge,
} from '@/components/admin/badges';
import { Markdown } from '@/components/markdown';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import type { CriterionView, FeedbackView } from '@/features/feedback/queries';
import type { ScorecardAutomatedRun } from '@/features/scorecard/queries';
import {
  normaliseScore,
  scorecardOverall,
  toPercent,
  type ApplicationSignal,
  type StageSignal,
} from '@/features/scorecard/aggregate';
import { formatDate } from '@/lib/utils';
import { cn } from '@/lib/utils';

/**
 * Presentation for the debrief.
 *
 * The one rule this file exists to hold: the aggregate is labelled as
 * evidence, never as an answer. There is no "recommended outcome" anywhere in
 * it, the distribution is drawn as a distribution rather than collapsed to a
 * number, and where a mean is shown it is shown next to the spread that makes
 * it meaningless on its own.
 */

/** Strong hire first: a debrief reads top-down from the best case. */
const DISPLAY_ORDER: readonly Recommendation[] = [
  'STRONG_HIRE',
  'HIRE',
  'LEAN_HIRE',
  'LEAN_NO',
  'NO',
  'STRONG_NO',
];

export function EvidenceNotice() {
  return (
    <Alert tone="info" title="This is evidence, not a verdict">
      Nothing here recommends an outcome. It counts what the panel said and averages the scores they
      gave, so a decision can be argued from the same page it is recorded on — the decision itself
      is written by a person, with a reason.
    </Alert>
  );
}

function DistributionBar({
  buckets,
  total,
}: {
  buckets: Array<{ recommendation: Recommendation; count: number }>;
  total: number;
}) {
  const byRecommendation = new Map(buckets.map((b) => [b.recommendation, b.count]));

  return (
    <ul className="space-y-1.5">
      {DISPLAY_ORDER.map((recommendation) => {
        const count = byRecommendation.get(recommendation) ?? 0;
        const share = total === 0 ? 0 : Math.round((count / total) * 100);
        return (
          <li key={recommendation} className="flex items-center gap-2">
            <span className="text-muted-foreground w-24 shrink-0 text-[12px]">
              {RECOMMENDATION_LABELS[recommendation]}
            </span>
            <span className="bg-muted h-2 min-w-0 flex-1 overflow-hidden rounded-full">
              <span
                className={cn(
                  'block h-full rounded-full',
                  count === 0 ? '' : share >= 50 ? 'bg-primary' : 'bg-primary/60',
                )}
                style={{ width: `${share}%` }}
              />
            </span>
            <span className="w-6 shrink-0 text-right text-[12px] tabular-nums">{count}</span>
          </li>
        );
      })}
      <li className="text-muted-foreground pt-0.5 text-[12px]">
        {total} {total === 1 ? 'scorecard' : 'scorecards'} counted.
      </li>
    </ul>
  );
}

function DisagreementNotice({ signal }: { signal: StageSignal | ApplicationSignal }) {
  const { disagreement } = signal;
  if (!disagreement.disagrees) return null;

  return (
    <Alert tone="warning" title="The panel does not agree">
      <span className="flex items-start gap-1.5">
        <Split className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>
          {disagreement.straddlesHireLine
            ? 'Some of the panel would hire and some would not'
            : 'The recommendations are spread across the scale'}
          {disagreement.lowest && disagreement.highest
            ? ` — from ${RECOMMENDATION_LABELS[disagreement.lowest]} to ${RECOMMENDATION_LABELS[disagreement.highest]}.`
            : '.'}{' '}
          This is the part of the debrief worth the meeting; an average would have hidden it.
        </span>
      </span>
    </Alert>
  );
}

/** Counts and averages for one round, or for the whole application. */
export function SignalPanel({
  signal,
  heading,
}: {
  signal: StageSignal | ApplicationSignal;
  heading?: string;
}) {
  const criteria = 'criteria' in signal ? signal.criteria : [];
  const overall = 'overallNormalised' in signal ? signal.overallNormalised : null;

  return (
    <div className="space-y-4">
      {heading ? <h3 className="text-sm font-semibold tracking-tight">{heading}</h3> : null}

      {signal.partial ? (
        <Alert tone="info" title="Part of this is hidden from you">
          Scorecards you may not read yet are excluded from these numbers as well as from the prose
          — an average anchors just as effectively as an opinion does. Submit yours to see the whole
          picture.
        </Alert>
      ) : null}

      <DisagreementNotice signal={signal} />

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
            Recommendations
          </p>
          <DistributionBar
            buckets={signal.distribution.buckets}
            total={signal.distribution.total}
          />
        </div>

        <div className="space-y-2">
          <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
            Coverage
          </p>
          <dl className="space-y-1.5 text-[13px]">
            <Row label="Panel" value={`${signal.panelSize}`} />
            <Row label="Submitted" value={`${signal.submittedCount}`} />
            <Row
              label="Outstanding"
              value={`${signal.outstandingCount}`}
              tone={signal.outstandingCount > 0 ? 'warn' : undefined}
            />
            {overall === null ? null : (
              <Row label="Weighted rubric average" value={`${toPercent(overall)}%`} />
            )}
            {signal.distribution.meanPosition === null ? null : (
              <Row
                label="Mean scale position"
                value={`${signal.distribution.meanPosition.toFixed(1)} / 6`}
              />
            )}
          </dl>
          <p className="text-muted-foreground text-[12px]">
            The scale is ordinal: the gap between “no” and “lean no” is not the same size as the gap
            between “hire” and “strong hire”, so the mean position is a summary of spread, not a
            score.
          </p>
        </div>
      </div>

      {criteria.length > 0 ? (
        <div className="space-y-2">
          <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
            Criteria
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] border-collapse text-[13px]">
              <thead>
                <tr className="text-muted-foreground border-b text-left text-[12px]">
                  <th className="py-1.5 pr-3 font-medium">Criterion</th>
                  <th className="py-1.5 pr-3 font-medium">Weight</th>
                  <th className="py-1.5 pr-3 font-medium">Mean</th>
                  <th className="py-1.5 pr-3 font-medium">Range</th>
                  <th className="py-1.5 font-medium">Normalised</th>
                </tr>
              </thead>
              <tbody>
                {criteria.map((criterion) => (
                  <tr key={criterion.criterionId} className="border-b last:border-0">
                    <td className="py-1.5 pr-3">{criterion.name}</td>
                    <td className="py-1.5 pr-3 tabular-nums">{criterion.weight}</td>
                    <td className="py-1.5 pr-3 tabular-nums">
                      {criterion.mean === null
                        ? '—'
                        : `${criterion.mean.toFixed(1)} / ${criterion.maxScore}`}
                    </td>
                    <td className="text-muted-foreground py-1.5 pr-3 tabular-nums">
                      {criterion.min === null || criterion.max === null
                        ? '—'
                        : `${criterion.min}–${criterion.max}`}
                    </td>
                    <td className="py-1.5 tabular-nums">
                      {criterion.normalised === null ? '—' : `${toPercent(criterion.normalised)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-muted-foreground text-[12px]">
            Normalised maps each scale onto 0–100% from its own bottom to its own top, so a 3/4 and
            a 7/10 can be read side by side.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('tabular-nums', tone === 'warn' && 'text-warning font-medium')}>{value}</dd>
    </div>
  );
}

/** One interviewer's scorecard, in full. */
export function ScorecardCard({
  feedback,
  criteria,
}: {
  feedback: FeedbackView;
  criteria: readonly CriterionView[];
}) {
  const byCriterion = new Map(feedback.scores.map((score) => [score.criterionId, score]));
  // This author's own weighted average, on the same normalised basis as the
  // panel's, so the two can be read against each other without arithmetic.
  const overall = scorecardOverall(criteria, feedback.scores);

  return (
    <article className="space-y-3 rounded-lg border px-4 py-3.5">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="text-[13px] font-medium">{feedback.authorName}</p>
        {feedback.recommendation ? (
          <RecommendationBadge recommendation={feedback.recommendation} />
        ) : null}
        {feedback.confidence ? <ConfidenceBadge confidence={feedback.confidence} /> : null}
        <FeedbackStatusBadge status={feedback.status} />
        {overall === null ? null : (
          <Badge variant="outline" className="tabular-nums">
            {toPercent(overall)}% rubric
          </Badge>
        )}
        <span className="text-muted-foreground ml-auto text-[12px]">
          {formatDate(feedback.submittedAt ?? feedback.updatedAt)}
        </span>
      </header>

      {feedback.revisionCount > 0 ? (
        <p className="text-muted-foreground text-[12px]">
          Revised {feedback.revisionCount} {feedback.revisionCount === 1 ? 'time' : 'times'}. The
          earlier versions are kept.
        </p>
      ) : null}

      {criteria.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[24rem] border-collapse text-[13px]">
            <tbody>
              {criteria.map((criterion) => {
                const score = byCriterion.get(criterion.id);
                const normalised =
                  score === undefined ? null : normaliseScore(score.score, criterion.maxScore);
                return (
                  <tr key={criterion.id} className="border-b align-top last:border-0">
                    <td className="py-1.5 pr-3">
                      <span className="font-medium">{criterion.name}</span>
                      {score?.note ? (
                        <span className="text-muted-foreground block text-[12px]">
                          {score.note}
                        </span>
                      ) : null}
                    </td>
                    <td className="w-24 py-1.5 text-right tabular-nums">
                      {score === undefined ? (
                        <span className="text-muted-foreground">not scored</span>
                      ) : (
                        <>
                          {score.score} / {criterion.maxScore}
                          {normalised === null ? null : (
                            <span className="text-muted-foreground block text-[11px]">
                              {toPercent(normalised)}%
                            </span>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      <Prose label="Summary" body={feedback.summary} />
      <Prose label="Strengths" body={feedback.strengths} />
      <Prose label="Concerns" body={feedback.concerns} />
    </article>
  );
}

function Prose({ label, body }: { label: string; body: string }) {
  if (body.trim() === '') return null;
  return (
    <div className="space-y-1">
      <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {label}
      </p>
      {/* Through `Markdown`, always: this is prose one member of staff wrote
          and another reads, and the renderer escapes rather than injects. */}
      <Markdown content={body} className="text-[13px]" />
    </div>
  );
}

/** What stands in for the scorecards a blinded panellist may not read yet. */
export function BlindNotice({
  hiddenSubmitted,
  hiddenDrafts = 0,
}: {
  hiddenSubmitted: number;
  hiddenDrafts?: number;
}) {
  return (
    <Alert tone="info" title="Hidden until you submit yours">
      <span className="flex items-start gap-1.5">
        <EyeOff className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>
          {hiddenSubmitted === 0
            ? 'Nobody else has submitted yet.'
            : `${hiddenSubmitted} ${hiddenSubmitted === 1 ? 'scorecard is' : 'scorecards are'} hidden until you submit yours.`}{' '}
          Four interviewers who read each other first produce one opinion and three echoes of it.
          {hiddenDrafts > 0
            ? ` ${hiddenDrafts} other ${hiddenDrafts === 1 ? 'draft is' : 'drafts are'} in progress; drafts are never readable by anyone but their author.`
            : ''}
        </span>
      </span>
    </Alert>
  );
}

/**
 * The automated coding results.
 *
 * Presented as one input among several and captioned, because a pass-rate is
 * the easiest number on the page to over-read: it measures whether the tests
 * that happened to be written went green, not whether the code is any good.
 */
export function AutomatedPanel({ runs }: { runs: readonly ScorecardAutomatedRun[] }) {
  if (runs.length === 0) {
    return (
      <p className="text-muted-foreground text-[13px]">
        No submissions were recorded for this round.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-1.5">
        {runs.map((run) => (
          <li key={run.submissionId} className="flex flex-wrap items-center gap-2 text-[13px]">
            <Link
              href={`/admin/submissions/${run.submissionId}`}
              className="hover:text-primary min-w-0 flex-1 truncate font-medium transition-colors"
            >
              {run.questionTitle}
            </Link>
            <Badge variant="outline">
              {run.passedCount}/{run.totalCount} tests
            </Badge>
            <ScoreBadge score={run.score} />
            <span className="text-muted-foreground text-[12px]">{formatDate(run.submittedAt)}</span>
          </li>
        ))}
      </ul>
      <Alert tone="warning" title="Test pass-rate is not code quality">
        <span className="flex items-start gap-1.5">
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            It says the submitted code satisfied the cases somebody wrote for this question.
            Readability, judgement and how the candidate got there are in the scorecards above, and
            they are what the round is for.
          </span>
        </span>
      </Alert>
    </div>
  );
}
