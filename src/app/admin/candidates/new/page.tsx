import type { Metadata } from 'next';
import { requireAdminPage } from '@/features/auth/guards';
import { listAssignableInterviews } from '@/features/candidates/queries';
import { CandidateCreateForm } from '@/components/admin/candidate-forms';
import { PageHeader } from '@/components/admin/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { isEmailConfigured } from '@/lib/env.server';

export const metadata: Metadata = { title: 'New candidate' };

export default async function NewCandidatePage() {
  await requireAdminPage();
  const interviews = await listAssignableInterviews();
  // Resolved on the server: the client has no business knowing whether
  // credentials exist, only whether the option is on offer.
  const emailEnabled = isEmailConfigured();

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="New candidate"
        description={
          emailEnabled
            ? 'You choose the first password. It is shown to you once, and can be emailed to the candidate at the same time.'
            : 'You choose the first password and hand it over yourself — this deployment has no mail provider configured.'
        }
        backHref="/admin/candidates"
        backLabel="Candidates"
      />
      <Card>
        <CardContent className="pt-5">
          <CandidateCreateForm interviews={interviews} emailEnabled={emailEnabled} />
        </CardContent>
      </Card>
    </div>
  );
}
