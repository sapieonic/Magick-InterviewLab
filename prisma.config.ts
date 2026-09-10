import 'dotenv/config';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 moved the connection string out of `schema.prisma` and into this
 * file, with the client taking an explicit driver adapter (see
 * `src/lib/db/prisma.ts`).
 *
 * The placeholder fallback matters: `prisma generate` runs during
 * `npm run build`, and a Docker image build (or a fresh CI checkout) has no
 * database. Generation never connects, so a syntactically valid URL is enough
 * to get through it — and any command that *does* connect fails loudly on the
 * placeholder host rather than silently doing something surprising.
 */
const PLACEHOLDER = 'postgresql://placeholder:placeholder@localhost:5432/placeholder';

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL || PLACEHOLDER,
  },
});
