/**
 * Build the Monolog web app for deployment alongside the static landing page.
 *
 * Outputs to:
 *   dist/                  ← Vercel outputDirectory
 *   ├── index.html         ← landing page (copied from repo root)
 *   ├── assets/            ← landing page assets (favicon, icon, og images)
 *   └── app/               ← the actual Expo web app (served at /app/)
 *       ├── index.html     ← Expo's generated HTML, with asset paths rewritten
 *       ├── _expo/         ← JS bundle + assets
 *       └── ...
 *
 * Why a script? Expo's HTML uses absolute paths like `/_expo/static/...` which
 * break when the app is served at `/app/`. We rewrite them to relative paths.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const APP_OUT = path.join(DIST, 'app');

function log(msg) {
  console.log(`\x1b[36m[build-web]\x1b[0m ${msg}`);
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', shell: true, cwd: ROOT });
  if (result.status !== 0) {
    console.error(`\x1b[31mCommand failed: ${cmd} ${args.join(' ')}\x1b[0m`);
    process.exit(result.status ?? 1);
  }
}

// ── Step 1: Clean dist ──────────────────────────────────────────
log('Cleaning dist/');
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// ── Step 2: Export Expo web build to dist/app ───────────────────
log('Exporting Expo web build to dist/app/');
run('npx', ['expo', 'export', '--platform', 'web', '--output-dir', 'dist/app']);

// ── Step 3: Rewrite absolute asset paths in the app's index.html ──
// Expo outputs:  <script src="/_expo/static/js/...">
// We need:       <script src="./_expo/static/js/...">
// so the bundle resolves correctly when served at /app/.
const appHtmlPath = path.join(APP_OUT, 'index.html');
if (!fs.existsSync(appHtmlPath)) {
  console.error(`\x1b[31mExpected ${appHtmlPath} but it doesn't exist\x1b[0m`);
  process.exit(1);
}

log('Rewriting asset paths in dist/app/index.html');
let appHtml = fs.readFileSync(appHtmlPath, 'utf8');
appHtml = appHtml
  .replace(/src="\/_expo\//g, 'src="./_expo/')
  .replace(/href="\/_expo\//g, 'href="./_expo/')
  .replace(/href="\/favicon\//g, 'href="./favicon/')
  .replace(/href="\/favicon\.ico"/g, 'href="./favicon.ico"');
fs.writeFileSync(appHtmlPath, appHtml);

// ── Step 4: Copy landing page to dist/index.html ────────────────
log('Copying landing page (index.html) to dist/index.html');
fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(DIST, 'index.html'));

// ── Step 5: Copy landing assets to dist/assets ───────────────────
log('Copying assets/ to dist/assets/');
function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
copyDir(path.join(ROOT, 'assets'), path.join(DIST, 'assets'));

// ── Done ─────────────────────────────────────────────────────────
log('Build complete. Output:');
log('  dist/index.html   ← landing page');
log('  dist/app/         ← Expo web app (served at /app/)');
log('  dist/assets/      ← landing assets');
