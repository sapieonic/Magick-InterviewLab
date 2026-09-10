import type { Metadata } from 'next';
import { listAssignableInterviews } from '@/features/candidates/queries';
import { CandidateCreateForm } from '@/components/admin/candidate-forms';
import { PageHeader } from '@/components/admin/page-header';
import { Card, CardContent } from '@/components/ui/card';

export const metadata: Metadata = { title: 'New candidate' };

export default async function NewCandidatePage() {
  const interviews = await listAssignableInterviews();

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="New candidate"
        description="You choose the first password and hand it over yourself — the platform never emails one."
        backHref="/admin/candidates"
        backLabel="Candidates"
      />
      <Card>
        <CardContent className="pt-5">
          <CandidateCreateForm interviews={interviews} />
        </CardContent>
      </Card>
    </div>
  );
}
