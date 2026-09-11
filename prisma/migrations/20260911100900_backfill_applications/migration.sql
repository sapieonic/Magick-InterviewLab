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
--
-- Two things here are load-bearing and were wrong in an earlier draft:
--
--  * The application is chosen with a correlated subquery rather than a plain
--    JOIN on `candidateId`. A candidate with two applications would otherwise
--    match both, producing two stage rows carrying the same `assignmentId` —
--    which violates `stages_assignmentId_key` and aborts the whole migration.
--    Backfilled stages belong to the backfilled application, and only that one.
--
--  * `position` continues from the stages that application already has, rather
--    than restarting at 0. `WHERE` is evaluated before the window function, so
--    a `ROW_NUMBER()` over the filtered set always starts again at 1 — on a
--    re-run against an application that was already backfilled, every new row
--    would land on a position that is already taken.
INSERT INTO "stages" (
  "id", "applicationId", "name", "type", "position", "status",
  "assignmentId", "blindFeedback", "completedAt", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  app."id",
  i."title",
  'CODING_ASSESSMENT'::"StageType",
  COALESCE(existing."maxPosition" + 1, 0)
    + (ROW_NUMBER() OVER (PARTITION BY app."id" ORDER BY a."createdAt", a."id"))::int - 1,
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
JOIN "interviews" i ON i."id" = a."interviewId"
JOIN LATERAL (
  SELECT app2."id"
  FROM "applications" app2
  WHERE app2."candidateId" = a."candidateId"
    AND app2."source" = 'backfill'
  ORDER BY app2."createdAt", app2."id"
  LIMIT 1
) app ON true
LEFT JOIN LATERAL (
  SELECT MAX(s2."position") AS "maxPosition"
  FROM "stages" s2
  WHERE s2."applicationId" = app."id"
) existing ON true
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
