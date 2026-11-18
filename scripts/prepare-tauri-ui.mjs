import { cpSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');
const outDir = resolve(rootDir, 'ui-dist');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const file of ['index.html', 'version.json', 'oauth-callback.html', 'sw.js']) {
  const srcFile = resolve(rootDir, file);
  if (existsSync(srcFile)) {
    copyFileSync(srcFile, resolve(outDir, file));
  }
}

for (const dir of ['public', 'src']) {
  const srcSubdir = resolve(rootDir, dir);
  if (existsSync(srcSubdir)) {
    cpSync(srcSubdir, resolve(outDir, dir), { recursive: true });
  }
}

console.log(`Prepared clean Tauri web assets in ${outDir}`);
