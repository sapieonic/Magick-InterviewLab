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
import { SAMPLE_QUESTIONS, SAMPLE_INTERVIEW } from './seed-data.js';

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

  await prisma.interviewAssignment.upsert({
    where: { interviewId_candidateId: { interviewId: interview.id, candidateId: candidate.id } },
    create: { interviewId: interview.id, candidateId: candidate.id },
    update: {},
  });
  console.info('✓ Interview assigned to candidate');
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
