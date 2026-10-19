// The Chrome Web Store package: a release build (sw.js and the manifest's own version,
// no dev stamps) zipped as release/lumen-recorder-<version>.zip.
// Usage: npm run release
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execFileSync('node', [path.join(root, 'scripts', 'build.mjs')], { stdio: 'inherit', env: { ...process.env, LUMEN_RELEASE: '1' } });
const dist = path.join(root, 'dist');
const { version, background } = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
if (background.service_worker !== 'sw.js' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('not a release build');
fs.mkdirSync(path.join(root, 'release'), { recursive: true });
const zip = path.join(root, 'release', `lumen-recorder-${version}.zip`);
fs.rmSync(zip, { force: true });
// Python's zipfile: no extra tools needed, and the same bytes for the same files.
execFileSync('python3', ['-c', `
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for d, _, files in sorted(os.walk(src)):
        for f in sorted(files):
            p = os.path.join(d, f)
            info = zipfile.ZipInfo(os.path.relpath(p, src), (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            with open(p, 'rb') as fh: z.writestr(info, fh.read())
`, dist, zip]);
console.log(`${path.relative(root, zip)}: ${(fs.statSync(zip).size / 1e6).toFixed(1)} MB, version ${version}`);
