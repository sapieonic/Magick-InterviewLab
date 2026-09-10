-- `code_drafts` was created with bare `candidateId`/`questionId` columns and no
-- foreign keys, so deleting a candidate or a question left its drafts behind
-- forever. Adding the constraints would fail against any such row, and rows
-- like that already exist, so clear them first. A draft whose owner or question
-- is gone is unreachable by definition — nothing is lost by deleting it.
DELETE FROM "code_drafts" d
WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = d."candidateId")
   OR NOT EXISTS (SELECT 1 FROM "questions" q WHERE q."id" = d."questionId");

-- CreateIndex
CREATE INDEX "code_drafts_questionId_idx" ON "code_drafts"("questionId");

-- AddForeignKey
ALTER TABLE "code_drafts" ADD CONSTRAINT "code_drafts_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_drafts" ADD CONSTRAINT "code_drafts_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
