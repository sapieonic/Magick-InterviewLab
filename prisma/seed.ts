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
  SAMPLE_INTERVIEW,
  SAMPLE_JOB_ROLE,
  SAMPLE_PIPELINE_STAGES,
  SAMPLE_PIPELINE_TEMPLATE,
  SAMPLE_QUESTIONS,
  SAMPLE_STAFF,
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
async function seedPipeline(ctx: { candidateId: string; assignmentId: string }): Promise<void> {
  const recruiter = await ensureStaff(SAMPLE_STAFF.recruiter);
  const hiringManager = await ensureStaff(SAMPLE_STAFF.hiringManager);
  const interviewer = await ensureStaff(SAMPLE_STAFF.interviewer);

  // Whatever rubric authoring has already seeded, if anything. A stage
  // template names a rubric and an instance freezes a version, so both halves
  // are looked up here and both are optional: the demo is still walkable with
  // no rubric at all, it just has nothing to score against.
  const rubric = await prisma.rubric.findFirst({
    where: { isActive: true, versions: { some: { isPublished: true } } },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      versions: {
        where: { isPublished: true },
        orderBy: { version: 'desc' },
        take: 1,
        select: { id: true },
      },
    },
  });
  const rubricId = rubric?.id ?? null;
  const rubricVersionId = rubric?.versions[0]?.id ?? null;

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

    const panel = panels[stage.name] ?? [];
    for (const seat of panel) {
      await prisma.stageInterviewer.create({
        data: { stageId: created.id, userId: seat.userId, role: seat.role },
      });
    }
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
