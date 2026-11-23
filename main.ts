// Token Radar v4 entry point: snapshot in, board + dashboard + dossier out.
// Run: mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|dir>
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const TEXT_MAX_BYTES = 65_536;
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}
const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) { process.stderr.write(`token radar: no snapshot at ${inputFile}\n`); process.exit(2); }
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) { process.stderr.write(`token radar: board refused: ${issue}\n`); process.exit(1); }
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const out: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const p = join(from, name);
    if (!statSync(p).isFile()) continue;
    copyFileSync(p, join(to, name));
    out.push(name);
  }
  return out;
}
copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) { process.stderr.write(`token radar: screenshots/ holds ${shots.length} images: hand in 3\n`); process.exit(1); }
for (const name of shots) if (!IMAGE_NAME.test(name)) { process.stderr.write(`token radar: bad screenshot name ${name}\n`); process.exit(1); }
// Fail fast on a screenshot the gate would refuse: whole PNG/JPEG,
// at most 512 KiB, long side at most 1440, short side at least 800.
function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let at = 2;
    while (at + 9 < buf.length) {
      if (buf[at] !== 0xff) return null;
      const marker = buf[at + 1]!;
      const len = buf.readUInt16BE(at + 2);
      if (marker === 0xc0 || marker === 0xc2) return { width: buf.readUInt16BE(at + 7), height: buf.readUInt16BE(at + 5) };
      at += 2 + len;
    }
  }
  return null;
}
for (const name of shots) {
  const buf = readFileSync(join(out, 'screenshots', name));
  if (buf.length > 524_288) { process.stderr.write(`token radar: screenshot ${name} is ${buf.length} bytes, over the 512 KiB cap\n`); process.exit(1); }
  const size = imageSize(buf);
  if (size === null) { process.stderr.write(`token radar: screenshot ${name} is not a whole PNG or JPEG\n`); process.exit(1); }
  const long = Math.max(size.width, size.height), short = Math.min(size.width, size.height);
  if (long > 1440 || short < 800) { process.stderr.write(`token radar: screenshot ${name} is ${size.width}x${size.height}, outside 800-1440\n`); process.exit(1); }
}
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: { max: 4, max_bytes: 524_288 }, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));
const v = radar.fit.validation;
process.stdout.write(`token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} watchlist, ${board.length} rows (${radar.early_size} early), ${radar.kpi.farm_count} FARM / ${radar.kpi.watch_count} WATCH / ${radar.kpi.skip_count} SKIP\n`);
process.stdout.write(`token radar: holdout log MAE cv(7,42)=${v.cvMae742.toFixed(4)} cv(123,2024)=${v.cvMae1232024.toFixed(4)} walk-forward=${v.walkForwardMae.toFixed(4)} LOTO=${v.lotoMae.toFixed(4)}; R2 usable=${v.r2Usable.toFixed(4)}\n`);
process.stdout.write(`token radar: wrote ${join(out, 'board.json')}, data.js, dashboard, screenshots (${shots.length}) and dossier.json\n`);
