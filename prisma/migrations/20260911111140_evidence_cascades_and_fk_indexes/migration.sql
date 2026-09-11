-- DropForeignKey
ALTER TABLE "application_comments" DROP CONSTRAINT "application_comments_authorId_fkey";

-- DropForeignKey
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_applicationId_fkey";

-- DropForeignKey
ALTER TABLE "feedback" DROP CONSTRAINT "feedback_authorId_fkey";

-- DropForeignKey
ALTER TABLE "rubric_versions" DROP CONSTRAINT "rubric_versions_rubricId_fkey";

-- DropForeignKey
ALTER TABLE "submission_notes" DROP CONSTRAINT "submission_notes_authorId_fkey";

-- CreateIndex
CREATE INDEX "applications_jobRoleId_idx" ON "applications"("jobRoleId");

-- CreateIndex
CREATE INDEX "applications_pipelineTemplateId_idx" ON "applications"("pipelineTemplateId");

-- CreateIndex
CREATE INDEX "feedback_rubricVersionId_idx" ON "feedback"("rubricVersionId");

-- CreateIndex
CREATE INDEX "stages_rubricVersionId_idx" ON "stages"("rubricVersionId");

-- AddForeignKey
ALTER TABLE "rubric_versions" ADD CONSTRAINT "rubric_versions_rubricId_fkey" FOREIGN KEY ("rubricId") REFERENCES "rubrics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_notes" ADD CONSTRAINT "submission_notes_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_comments" ADD CONSTRAINT "application_comments_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
