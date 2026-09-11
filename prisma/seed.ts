/**
 * Development seed.
 *
 * Idempotent: safe to run repeatedly. Creates the env-configured admin, a
 * sample interview with three questions and their test cases, and one
 * candidate with the interview assigned — enough to walk the whole product
 * without touching the database by hand.
 *
 * No credential is hard-coded. The candidate password comes from
 * SEED_CANDIDATE_PASSWORD; if unset, a random one is generated and printed
 * once, at which point it exists only in your terminal.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import {
  SAMPLE_APPLICATION_PROGRESS,
  SAMPLE_FEEDBACK,
  SAMPLE_INTERVIEW,
  SAMPLE_JOB_ROLE,
  SAMPLE_PIPELINE_STAGES,
  SAMPLE_PIPELINE_TEMPLATE,
  SAMPLE_QUESTIONS,
  SAMPLE_RUBRIC,
  SAMPLE_STAFF,
  SAMPLE_SUBMISSION_SOURCE,
} from './seed-data.js';
import type { Role } from '../src/generated/prisma/enums.js';

const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is not set. Copy .env.example to .env.');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

function generatePassword(): string {
  // Readable but high-entropy: base64url of 12 bytes, plus a digit guarantee.
  return `${randomBytes(9).toString('base64url')}7a`;
}

async function seedAdmin(): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) {
    console.warn('· ADMIN_EMAIL not set — skipping admin bootstrap.');
    return;
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.info(`· Admin ${email} already exists.`);
    return;
  }

  let passwordHash = process.env.ADMIN_PASSWORD_HASH?.trim();
  let generated: string | undefined;
  if (!passwordHash) {
    const plaintext = process.env.ADMIN_PASSWORD?.trim();
    if (plaintext) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('ADMIN_PASSWORD (plaintext) is refused in production.');
      }
      passwordHash = await hash(plaintext, ARGON);
    } else {
      generated = generatePassword();
      passwordHash = await hash(generated, ARGON);
    }
  }

  await prisma.user.create({
    data: {
      email,
      name: process.env.ADMIN_NAME?.trim() || 'MagicVoice Admin',
      passwordHash,
      role: 'ADMIN',
      mustChangePassword: Boolean(generated),
    },
  });
  console.info(`✓ Admin created: ${email}`);
  if (generated) {
    console.info(`  Generated password (shown once): ${generated}`);
    console.info('  You will be asked to change it on first sign-in.');
  }
}

async function seedDemo(): Promise<void> {
  if (process.env.SEED_DEMO_DATA === 'false') {
    console.info('· SEED_DEMO_DATA=false — skipping demo content.');
    return;
  }

  // Questions are keyed by title so re-running updates rather than duplicates.
  const questionIds: string[] = [];
  for (const q of SAMPLE_QUESTIONS) {
    const existing = await prisma.question.findFirst({ where: { title: q.title } });
    const data = {
      title: q.title,
      description: q.description,
      difficulty: q.difficulty,
      supportedLanguages: q.supportedLanguages,
      starterCode: q.starterCode,
      timeLimitMs: q.timeLimitMs,
    };
    const question = existing
      ? await prisma.question.update({ where: { id: existing.id }, data })
      : await prisma.question.create({ data });

    await prisma.testCase.deleteMany({ where: { questionId: question.id } });
    await prisma.testCase.createMany({
      data: q.testCases.map((t, i) => ({ ...t, questionId: question.id, position: i })),
    });
    questionIds.push(question.id);
  }
  console.info(`✓ ${questionIds.length} sample questions`);

  const existingInterview = await prisma.interview.findFirst({
    where: { title: SAMPLE_INTERVIEW.title },
  });
  const interview = existingInterview
    ? await prisma.interview.update({
        where: { id: existingInterview.id },
        data: SAMPLE_INTERVIEW,
      })
    : await prisma.interview.create({ data: SAMPLE_INTERVIEW });

  await prisma.interviewQuestion.deleteMany({ where: { interviewId: interview.id } });
  await prisma.interviewQuestion.createMany({
    data: questionIds.map((questionId, position) => ({
      interviewId: interview.id,
      questionId,
      position,
    })),
  });
  console.info(`✓ Interview "${interview.title}"`);

  const candidateEmail = (process.env.SEED_CANDIDATE_EMAIL || 'candidate@magicvoice.local')
    .trim()
    .toLowerCase();
  let candidate = await prisma.user.findUnique({ where: { email: candidateEmail } });
  if (!candidate) {
    const plaintext = process.env.SEED_CANDIDATE_PASSWORD?.trim() || generatePassword();
    candidate = await prisma.user.create({
      data: {
        email: candidateEmail,
        name: 'Sample Candidate',
        passwordHash: await hash(plaintext, ARGON),
        role: 'CANDIDATE',
        mustChangePassword: true,
      },
    });
    console.info(`✓ Candidate created: ${candidateEmail}`);
    console.info(`  Temporary password (shown once): ${plaintext}`);
  } else {
    console.info(`· Candidate ${candidateEmail} already exists.`);
  }

  const assignment = await prisma.interviewAssignment.upsert({
    where: { interviewId_candidateId: { interviewId: interview.id, candidateId: candidate.id } },
    create: { interviewId: interview.id, candidateId: candidate.id },
    update: {},
  });
  console.info('✓ Interview assigned to candidate');

  await seedSubmission({ interviewId: interview.id, candidateId: candidate.id });

  // A second candidate with nothing attached, so the "start an application"
  // picker on the board has somebody in it: the first candidate is mid-flight
  // by the time the seed finishes, and `listAssignableCandidates` rightly
  // excludes anyone with a live run.
  const spareEmail = (process.env.SEED_SPARE_CANDIDATE_EMAIL || 'applicant@magicvoice.local')
    .trim()
    .toLowerCase();
  const spare = await prisma.user.findUnique({ where: { email: spareEmail } });
  if (!spare) {
    const plaintext = process.env.SEED_CANDIDATE_PASSWORD?.trim() || generatePassword();
    await prisma.user.create({
      data: {
        email: spareEmail,
        name: 'Nadia Halvorsen',
        passwordHash: await hash(plaintext, ARGON),
        role: 'CANDIDATE',
        mustChangePassword: true,
      },
    });
    console.info(`✓ Candidate created: ${spareEmail}`);
    console.info(`  Temporary password (shown once): ${plaintext}`);
  } else {
    console.info(`· Candidate ${spareEmail} already exists.`);
  }

  await seedPipeline({ candidateId: candidate.id, assignmentId: assignment.id });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A staff account, created once.
 *
 * Same contract as the candidate above: the password comes from
 * SEED_STAFF_PASSWORD or is generated and printed exactly once, and it is
 * always temporary — whoever runs the seed knows it, so the colleague must
 * replace it at first sign-in.
 */
async function ensureStaff(person: { email: string; name: string; role: Role }): Promise<{
  id: string;
  name: string;
}> {
  const email = person.email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.info(`· Staff ${email} already exists.`);
    return { id: existing.id, name: existing.name };
  }

  const plaintext = process.env.SEED_STAFF_PASSWORD?.trim() || generatePassword();
  const created = await prisma.user.create({
    data: {
      email,
      name: person.name,
      passwordHash: await hash(plaintext, ARGON),
      role: person.role,
      mustChangePassword: true,
    },
  });
  console.info(`✓ Staff created: ${email} (${person.role})`);
  console.info(`  Temporary password (shown once): ${plaintext}`);
  return { id: created.id, name: created.name };
}

/**
 * A walkable hiring process: three colleagues, a requisition, the loop it
 * defaults to, and one candidate part-way through it.
 *
 * Idempotent like everything else here. The template's rounds are rewritten on
 * every run (they are content), but the *application* is created once and then
 * left alone — re-running the seed must not resurrect a round somebody skipped
 * or overwrite a status somebody set while walking the demo.
 */
/**
 * The demo rubric, created once and published.
 *
 * Published rather than left as a draft: only a published version may be
 * pinned to a stage, so a draft here would leave the demo in exactly the state
 * this function exists to avoid.
 *
 * Returns the criterion ids keyed by name so the seeded scorecard can score
 * against them without depending on their order.
 */
/**
 * One real submission for the demo candidate, so the coding round has
 * something behind it.
 *
 * The demo used to seed that round as COMPLETE with outcome ADVANCE while no
 * submission existed at all: the pipeline asserted the assessment was done and
 * advanced, and the stage page said nothing had been submitted. A reviewer
 * opening the demo had no code to read, so the whole submission-review half of
 * a coding round was unwalkable.
 *
 * The payload matches what the candidate's browser writes — see
 * `src/features/submissions/stored-results.ts`, which parses it defensively
 * and is very particular about `null` versus `undefined`.
 */
async function seedSubmission(ctx: { interviewId: string; candidateId: string }): Promise<void> {
  const existing = await prisma.submission.findFirst({
    where: { interviewId: ctx.interviewId, candidateId: ctx.candidateId },
    select: { id: true },
  });
  if (existing) {
    console.info('· Demo submission already exists.');
    return;
  }

  const link = await prisma.interviewQuestion.findFirst({
    where: { interviewId: ctx.interviewId },
    orderBy: { position: 'asc' },
    select: {
      questionId: true,
      question: {
        select: {
          title: true,
          testCases: {
            orderBy: { position: 'asc' },
            select: {
              id: true,
              input: true,
              expectedOutput: true,
              description: true,
              weight: true,
            },
          },
        },
      },
    },
  });
  if (!link || link.question.testCases.length === 0) return;

  const cases = link.question.testCases;
  // All but the last pass, so the review screen has both a green and a red row
  // to render and the score is a partial rather than a flat 100.
  const tests = cases.map((testCase, index) => {
    const passed = index < cases.length - 1;
    return {
      testCaseId: testCase.id,
      description: testCase.description,
      status: passed ? 'passed' : 'failed',
      input: testCase.input,
      expectedOutput: testCase.expectedOutput,
      actualOutput: passed ? testCase.expectedOutput : '',
      stderr: null,
      errorMessage: null,
      errorKind: null,
      weight: testCase.weight,
      durationMs: 3 + index,
    };
  });

  const totalWeight = cases.reduce((sum, testCase) => sum + testCase.weight, 0);
  const passedWeight = tests
    .filter((test) => test.status === 'passed')
    .reduce((sum, test) => sum + test.weight, 0);

  await prisma.submission.create({
    data: {
      candidateId: ctx.candidateId,
      interviewId: ctx.interviewId,
      questionId: link.questionId,
      language: 'JAVASCRIPT',
      sourceCode: SAMPLE_SUBMISSION_SOURCE,
      score: totalWeight === 0 ? 0 : Math.round((passedWeight / totalWeight) * 100),
      passedCount: tests.filter((test) => test.status === 'passed').length,
      totalCount: tests.length,
      results: { tests, stdout: '', stderr: '', executionTimeMs: 11 },
      submittedAt: new Date(Date.now() - 12 * DAY_MS),
    },
  });

  // The assignment is the authority on a coding round's status, so it has to
  // agree with the submission that now exists.
  await prisma.interviewAssignment.update({
    where: {
      interviewId_candidateId: { interviewId: ctx.interviewId, candidateId: ctx.candidateId },
    },
    data: {
      status: 'COMPLETED',
      startedAt: new Date(Date.now() - 12 * DAY_MS),
      completedAt: new Date(Date.now() - 12 * DAY_MS),
    },
  });

  console.info(`✓ Submission seeded for "${link.question.title}"`);
}

async function ensureRubric(): Promise<{
  rubricId: string;
  rubricVersionId: string;
  criterionIds: Record<string, string>;
}> {
  const existing = await prisma.rubric.findFirst({
    where: { name: SAMPLE_RUBRIC.name },
    select: {
      id: true,
      versions: {
        where: { isPublished: true },
        orderBy: { version: 'desc' },
        take: 1,
        select: { id: true, criteria: { select: { id: true, name: true } } },
      },
    },
  });

  if (existing?.versions[0]) {
    const version = existing.versions[0];
    console.info(`· Rubric "${SAMPLE_RUBRIC.name}" already exists.`);
    return {
      rubricId: existing.id,
      rubricVersionId: version.id,
      criterionIds: Object.fromEntries(version.criteria.map((c) => [c.name, c.id])),
    };
  }

  const rubric =
    existing ??
    (await prisma.rubric.create({
      data: { name: SAMPLE_RUBRIC.name, description: SAMPLE_RUBRIC.description },
      select: { id: true },
    }));

  const version = await prisma.rubricVersion.create({
    data: {
      rubricId: rubric.id,
      version: 1,
      isPublished: true,
      publishedAt: new Date(),
      notes: 'Seeded for the demo pipeline.',
      criteria: {
        create: SAMPLE_RUBRIC.criteria.map((criterion, position) => ({
          name: criterion.name,
          description: criterion.description,
          weight: criterion.weight,
          maxScore: criterion.maxScore,
          position,
        })),
      },
    },
    select: { id: true, criteria: { select: { id: true, name: true } } },
  });

  console.info(`✓ Rubric "${SAMPLE_RUBRIC.name}" (v1, ${SAMPLE_RUBRIC.criteria.length} criteria)`);
  return {
    rubricId: rubric.id,
    rubricVersionId: version.id,
    criterionIds: Object.fromEntries(version.criteria.map((c) => [c.name, c.id])),
  };
}

async function seedPipeline(ctx: { candidateId: string; assignmentId: string }): Promise<void> {
  const recruiter = await ensureStaff(SAMPLE_STAFF.recruiter);
  const hiringManager = await ensureStaff(SAMPLE_STAFF.hiringManager);
  const interviewer = await ensureStaff(SAMPLE_STAFF.interviewer);

  // The rubric is *created*, not looked up hopefully. An earlier version of
  // this seed searched for "whatever rubric authoring has already seeded" —
  // and nothing ever seeded one, so every demo stage pinned `null` and the
  // whole rubric half of the product was unreachable without hand-authoring
  // one first. It also never self-healed, because this function returns early
  // once the demo application exists.
  const { rubricId, rubricVersionId, criterionIds } = await ensureRubric();

  const existingTemplate = await prisma.pipelineTemplate.findFirst({
    where: { name: SAMPLE_PIPELINE_TEMPLATE.name },
  });
  const template = existingTemplate
    ? await prisma.pipelineTemplate.update({
        where: { id: existingTemplate.id },
        data: SAMPLE_PIPELINE_TEMPLATE,
      })
    : await prisma.pipelineTemplate.create({ data: SAMPLE_PIPELINE_TEMPLATE });

  await prisma.pipelineStageTemplate.deleteMany({ where: { templateId: template.id } });
  await prisma.pipelineStageTemplate.createMany({
    data: SAMPLE_PIPELINE_STAGES.map((stage, position) => ({
      templateId: template.id,
      name: stage.name,
      type: stage.type,
      position,
      isRequired: stage.isRequired,
      // The coding round is machine-graded; a human rubric on it would invite
      // scoring the same thing twice with two different instruments.
      rubricId: stage.type === 'CODING_ASSESSMENT' ? null : rubricId,
    })),
  });
  console.info(`✓ Pipeline template "${template.name}" (${SAMPLE_PIPELINE_STAGES.length} rounds)`);

  const existingRole = await prisma.jobRole.findFirst({
    where: { title: SAMPLE_JOB_ROLE.title, level: SAMPLE_JOB_ROLE.level },
  });
  const jobRole = existingRole
    ? await prisma.jobRole.update({
        where: { id: existingRole.id },
        data: { ...SAMPLE_JOB_ROLE, pipelineTemplateId: template.id },
      })
    : await prisma.jobRole.create({
        data: { ...SAMPLE_JOB_ROLE, pipelineTemplateId: template.id },
      });
  console.info(`✓ Job role "${jobRole.title} ${jobRole.level}"`);

  const existingApplication = await prisma.application.findFirst({
    where: { candidateId: ctx.candidateId, jobRoleId: jobRole.id },
  });
  if (existingApplication) {
    console.info('· Demo application already exists.');
    return;
  }

  const application = await prisma.application.create({
    data: {
      candidateId: ctx.candidateId,
      jobRoleId: jobRole.id,
      pipelineTemplateId: template.id,
      ownerId: recruiter.id,
      source: 'Referral',
      status: 'ACTIVE',
    },
  });

  const now = Date.now();
  // Who sits on which round. The assessment has no panel — nobody scores a
  // machine-graded round — and the two rounds nobody has reached yet still get
  // their panel, because scheduling is the thing that stalls a pipeline.
  const panels: Record<string, Array<{ userId: string; role: 'LEAD' | 'PANELIST' | 'SHADOW' }>> = {
    'Technical screen': [
      { userId: interviewer.id, role: 'LEAD' },
      { userId: hiringManager.id, role: 'PANELIST' },
    ],
    'System design': [{ userId: interviewer.id, role: 'PANELIST' }],
    'Hiring manager': [{ userId: hiringManager.id, role: 'LEAD' }],
  };

  const stageIds: Record<string, string> = {};

  for (const [position, stage] of SAMPLE_PIPELINE_STAGES.entries()) {
    const progress = SAMPLE_APPLICATION_PROGRESS[position];
    if (!progress) continue;

    const scheduledAt =
      progress.scheduledDaysAgo === null
        ? null
        : new Date(now - progress.scheduledDaysAgo * DAY_MS);

    const created = await prisma.stage.create({
      data: {
        applicationId: application.id,
        name: stage.name,
        type: stage.type,
        position,
        status: progress.status,
        outcome: progress.outcome,
        scheduledAt,
        completedAt: progress.status === 'COMPLETE' ? scheduledAt : null,
        blindFeedback: true,
        rubricVersionId: stage.type === 'CODING_ASSESSMENT' ? null : rubricVersionId,
        // The candidate's existing assignment backs the coding round rather
        // than a second one being invented for it.
        assignmentId: stage.type === 'CODING_ASSESSMENT' ? ctx.assignmentId : null,
      },
    });

    stageIds[stage.name] = created.id;

    const panel = panels[stage.name] ?? [];
    for (const seat of panel) {
      await prisma.stageInterviewer.create({
        data: { stageId: created.id, userId: seat.userId, role: seat.role },
      });
    }
  }

  // One submitted scorecard on the round that is awaiting feedback, written by
  // the interviewer who leads it. Exactly one, because the second panellist
  // opening that round is how the demo shows the blind rule *working* — two
  // would show only its result.
  const feedbackStageId = stageIds[SAMPLE_FEEDBACK.stageName];
  if (feedbackStageId && rubricVersionId) {
    const submittedAt = new Date(now - 2 * DAY_MS);
    await prisma.feedback.create({
      data: {
        stageId: feedbackStageId,
        authorId: interviewer.id,
        status: 'SUBMITTED',
        recommendation: SAMPLE_FEEDBACK.recommendation,
        confidence: SAMPLE_FEEDBACK.confidence,
        summary: SAMPLE_FEEDBACK.summary,
        strengths: SAMPLE_FEEDBACK.strengths,
        concerns: SAMPLE_FEEDBACK.concerns,
        rubricVersionId,
        submittedAt,
        createdAt: submittedAt,
        scores: {
          create: Object.entries(SAMPLE_FEEDBACK.scores).flatMap(([name, entry]) => {
            const criterionId = criterionIds[name];
            // A criterion the rubric no longer carries is skipped rather than
            // failing the seed: the fixture and the rubric are edited by hand
            // and will drift.
            return criterionId ? [{ criterionId, score: entry.score, note: entry.note }] : [];
          }),
        },
      },
    });
    await prisma.auditEvent.create({
      data: {
        actorId: interviewer.id,
        action: 'feedback.submitted',
        entityType: 'Feedback',
        entityId: feedbackStageId,
        applicationId: application.id,
        metadata: { recommendation: SAMPLE_FEEDBACK.recommendation },
        createdAt: submittedAt,
      },
    });
    console.info(`✓ Scorecard submitted on "${SAMPLE_FEEDBACK.stageName}" (1 of 2)`);
  }

  // Two events so the activity panel has something true to show rather than
  // starting empty on a pipeline that is visibly mid-flight.
  await prisma.auditEvent.createMany({
    data: [
      {
        actorId: recruiter.id,
        action: 'application.created',
        entityType: 'Application',
        entityId: application.id,
        applicationId: application.id,
        metadata: { jobRoleId: jobRole.id, source: 'Referral' },
        createdAt: new Date(now - 14 * DAY_MS),
      },
      {
        actorId: recruiter.id,
        action: 'stage.outcome_recorded',
        entityType: 'Application',
        entityId: application.id,
        applicationId: application.id,
        metadata: { outcome: 'ADVANCE', stageName: SAMPLE_PIPELINE_STAGES[0]?.name ?? '' },
        createdAt: new Date(now - 11 * DAY_MS),
      },
    ],
  });

  console.info('✓ Demo application mid-flight, panel assigned');
}

async function main(): Promise<void> {
  console.info('\nSeeding MagicVoice InterviewLab…\n');
  await seedAdmin();
  await seedDemo();
  console.info('\nDone.\n');
}

main()
  .catch((error: unknown) => {
    console.error('\nSeed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
