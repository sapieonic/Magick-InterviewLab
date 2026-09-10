/**
 * Download the Pyodide runtime into `public/pyodide/` for self-hosting.
 *
 * Python execution defaults to the jsDelivr CDN, which is right for most
 * deployments: the runtime is ~12 MB and does not belong in git. But an
 * air-gapped install, a locked-down corporate network, or a browser whose
 * proxy blocks unpkg-style CDNs will fail — visibly and with a good message,
 * but fail. This script is the escape hatch.
 *
 *   npm run fetch:pyodide
 *   # then set, in .env:
 *   NEXT_PUBLIC_PYODIDE_INDEX_URL="/pyodide/"
 *
 * Only the core runtime is fetched, not the package archive: the executor
 * runs plain CPython and never calls `micropip`, so the several hundred MB of
 * prebuilt wheels are dead weight.
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

const VERSION = process.env.PYODIDE_VERSION ?? 'v314.0.6';
const BASE = process.env.PYODIDE_SOURCE_URL ?? `https://cdn.jsdelivr.net/pyodide/${VERSION}/full/`;
const OUT = path.join(process.cwd(), 'public', 'pyodide');

/** Everything `loadPyodide()` reaches for on a bare `runPython` workload. */
const FILES = [
  'pyodide.js',
  'pyodide.mjs',
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
];

async function alreadyPresent(file) {
  try {
    const info = await stat(path.join(OUT, file));
    return info.size > 0;
  } catch {
    return false;
  }
}

await mkdir(OUT, { recursive: true });

let downloaded = 0;
for (const file of FILES) {
  if (await alreadyPresent(file)) {
    console.info(`· ${file} (already present)`);
    continue;
  }
  const url = new URL(file, BASE).toString();
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url} — HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(path.join(OUT, file), bytes);
  downloaded += 1;
  console.info(`✓ ${file} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
}

console.info(
  downloaded === 0
    ? '\nPyodide already self-hosted in public/pyodide.'
    : `\nDownloaded Pyodide ${VERSION} to public/pyodide.`,
);
console.info('Set NEXT_PUBLIC_PYODIDE_INDEX_URL="/pyodide/" in .env to use it.\n');
