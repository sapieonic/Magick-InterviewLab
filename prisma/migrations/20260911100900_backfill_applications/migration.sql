-- Backfill the hiring pipeline from the assessment history that already exists.
--
-- Before this change an `InterviewAssignment` was the only record that a
-- candidate was being evaluated. Each one therefore becomes a
-- CODING_ASSESSMENT stage on an application, so no history is stranded
-- outside the new model and every existing candidate opens with a pipeline
-- rather than an empty page.
--
-- Split from the schema migration deliberately: this one reads rows, and a
-- data migration that fails should not take the DDL down with it.
--
-- Ids are UUID text rather than cuid. Prisma generates cuids in the client and
-- the column is plain TEXT, so a uuid is a valid id; it is also visibly
-- distinguishable as backfilled.

-- One ACTIVE application per candidate who has ever been assigned an
-- assessment. Status is ACTIVE even for finished assessments: a completed
-- assessment is not a completed *process*, and only a person may close one.
INSERT INTO "applications" ("id", "candidateId", "status", "source", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  a."candidateId",
  'ACTIVE'::"ApplicationStatus",
  'backfill',
  MIN(a."createdAt"),
  NOW()
FROM "interview_assignments" a
WHERE NOT EXISTS (
  SELECT 1 FROM "applications" app WHERE app."candidateId" = a."candidateId"
)
GROUP BY a."candidateId";

-- One stage per assignment, ordered by when it was assigned. The stage name
-- is the interview's title, which is what a reviewer recognises.
INSERT INTO "stages" (
  "id", "applicationId", "name", "type", "position", "status",
  "assignmentId", "blindFeedback", "completedAt", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  app."id",
  i."title",
  'CODING_ASSESSMENT'::"StageType",
  (ROW_NUMBER() OVER (PARTITION BY a."candidateId" ORDER BY a."createdAt", a."id"))::int - 1,
  CASE a."status"
    WHEN 'ASSIGNED'    THEN 'PENDING'::"StageStatus"
    WHEN 'IN_PROGRESS' THEN 'IN_PROGRESS'::"StageStatus"
    -- A finished assessment is waiting on a human read, not done.
    WHEN 'COMPLETED'   THEN 'AWAITING_FEEDBACK'::"StageStatus"
  END,
  a."id",
  true,
  a."completedAt",
  a."createdAt",
  NOW()
FROM "interview_assignments" a
JOIN "applications" app ON app."candidateId" = a."candidateId"
JOIN "interviews" i ON i."id" = a."interviewId"
WHERE NOT EXISTS (
  SELECT 1 FROM "stages" s WHERE s."assignmentId" = a."id"
);

-- The backfill itself is an auditable event.
INSERT INTO "audit_events" ("id", "action", "entityType", "entityId", "applicationId", "metadata", "createdAt")
SELECT
  gen_random_uuid()::text,
  'application.backfilled',
  'Application',
  app."id",
  app."id",
  jsonb_build_object('stages', (SELECT COUNT(*) FROM "stages" s WHERE s."applicationId" = app."id")),
  NOW()
FROM "applications" app
WHERE app."source" = 'backfill'
  AND NOT EXISTS (
    SELECT 1 FROM "audit_events" e
    WHERE e."applicationId" = app."id" AND e."action" = 'application.backfilled'
  );
