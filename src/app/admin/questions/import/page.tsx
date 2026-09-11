import type { Metadata } from 'next';
import { requireAdminPage } from '@/features/auth/guards';
import { PageHeader } from '@/components/admin/page-header';
import { QuestionImporter } from '@/components/admin/question-importer';

export const metadata: Metadata = { title: 'Import questions' };

export default async function ImportQuestionsPage() {
  await requireAdminPage();
  return (
    <>
      <PageHeader
        title="Import questions"
        description="Add a whole question set at once from a JSON manifest. Each entry is the same shape the editor saves."
        backHref="/admin/questions"
        backLabel="Questions"
      />
      <QuestionImporter />
    </>
  );
}
