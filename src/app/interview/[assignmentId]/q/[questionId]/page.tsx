import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireCandidatePage } from '@/features/auth/guards';
import { loadWorkspace, startAssignmentIfNeeded } from '@/features/submissions/queries';
import { Workspace } from '@/components/workspace/workspace';

export const metadata: Metadata = { title: 'Workspace' };
export const dynamic = 'force-dynamic';

/**
 * Authorization, then data — never the other way round.
 *
 * `loadWorkspace` scopes every read by `candidateId` and additionally
 * requires the question to be on *this* assignment's interview, so the two
 * URL-editing attacks (someone else's assignment id, a question from another
 * interview) both come back null. Both answer with `notFound()`: a 403 would
 * confirm the id exists, which is exactly the thing not to tell someone
 * poking at ids during their own interview.
 */
export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ assignmentId: string; questionId: string }>;
}) {
  const user = await requireCandidatePage();
  const { assignmentId, questionId } = await params;

  // Stamp the clock before reading, so the timer this render draws is the one
  // the server just committed. Idempotent and scoped to the candidate, so a
  // hostile id is a no-op rather than a write.
  await startAssignmentIfNeeded(user.id, assignmentId);

  const data = await loadWorkspace(user.id, assignmentId, questionId);
  if (!data) notFound();

  return <Workspace data={data} />;
}
