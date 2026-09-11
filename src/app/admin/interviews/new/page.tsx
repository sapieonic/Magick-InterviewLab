import type { Metadata } from 'next';
import { requireAdminPage } from '@/features/auth/guards';
import { InterviewForm } from '@/components/admin/interview-form';
import { PageHeader } from '@/components/admin/page-header';
import { Card, CardContent } from '@/components/ui/card';

export const metadata: Metadata = { title: 'New interview' };

export default async function NewInterviewPage() {
  await requireAdminPage();
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="New interview"
        description="Create it first, then add questions and assign candidates."
        backHref="/admin/interviews"
        backLabel="Interviews"
      />
      <Card>
        <CardContent className="pt-5">
          <InterviewForm />
        </CardContent>
      </Card>
    </div>
  );
}
