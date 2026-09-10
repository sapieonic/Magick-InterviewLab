/**
 * Generate an Argon2id hash for ADMIN_PASSWORD_HASH.
 *   npm run hash-password -- 'correct horse battery staple'
 * With no argument, reads one line from stdin so the password stays out of
 * your shell history.
 */
import { hash } from '@node-rs/argon2';
import { createInterface } from 'node:readline/promises';

async function read(): Promise<string> {
  const fromArgv = process.argv.slice(2).join(' ').trim();
  if (fromArgv) return fromArgv;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question('Password: ');
  rl.close();
  return answer.trim();
}

const password = await read();
if (!password) {
  console.error('No password provided.');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Refusing to hash a password shorter than 8 characters.');
  process.exit(1);
}
const digest = await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
console.error('\nAdd this to your .env:\n');
console.log(`ADMIN_PASSWORD_HASH='${digest}'`);
