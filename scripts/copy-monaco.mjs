/**
 * Copy the Monaco distribution into `public/monaco/vs`.
 *
 * `@monaco-editor/react` defaults to fetching Monaco from a CDN. That is a
 * bad dependency for an internal tool: a candidate on a restricted corporate
 * network, an air-gapped deployment, or a Docker host with no egress all end
 * up in the plain-textarea fallback halfway through a timed interview. Monaco
 * is already an npm dependency, so serve it from our own origin instead.
 *
 * Runs before `dev` and `build`. Skips the copy when the output is already
 * current, so it costs nothing on a warm rebuild.
 */
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Resolved by path rather than `require.resolve`: monaco-editor's "exports"
// map deliberately does not expose package.json.
const packageRoot = path.join(process.cwd(), 'node_modules', 'monaco-editor');
const packageJsonPath = path.join(packageRoot, 'package.json');
const source = path.join(packageRoot, 'min', 'vs');
const destination = path.join(process.cwd(), 'public', 'monaco', 'vs');
const stampPath = path.join(process.cwd(), 'public', 'monaco', '.version');

const { version } = JSON.parse(await readFile(packageJsonPath, 'utf8'));

async function isCurrent() {
  try {
    const [stamp] = await Promise.all([readFile(stampPath, 'utf8'), stat(source)]);
    return stamp.trim() === version;
  } catch {
    return false;
  }
}

if (await isCurrent()) {
  process.exit(0);
}

await mkdir(path.dirname(destination), { recursive: true });
await cp(source, destination, { recursive: true });
await writeFile(stampPath, `${version}\n`, 'utf8');
console.info(`Copied monaco-editor ${version} to public/monaco/vs`);
