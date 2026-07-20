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
 * Why a script?
 * 1. Expo's HTML uses absolute paths like /_expo/static/... which break when
 *    the app is served at /app/. We rewrite them to relative paths.
 * 2. @expo/vector-icons renders icons as text with fontFamily="Ionicons" etc.
 *    On web, the browser needs @font-face declarations to resolve those family
 *    names — react-native-web doesn't inject them automatically in production
 *    builds. We scan the bundled .ttf files and emit @font-face rules.
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

// ── Step 3b: Inject CSS — @font-face for icon fonts + web input reset ──
// Two concerns:
//  (a) @expo/vector-icons renders icons as text with fontFamily="Ionicons".
//      The browser needs @font-face declarations to resolve those family names
//      — react-native-web doesn't inject them in production builds.
//  (b) react-native-web renders <TextInput> as a <textarea>/<input> and
//      browsers auto-add a focus outline (the blue ring). We reset it so the
//      input doesn't "highlight" while typing.
const FONTS_DIR = path.join(
  APP_OUT,
  'assets',
  'node_modules',
  '@expo',
  'vector-icons',
  'build',
  'vendor',
  'react-native-vector-icons',
  'Fonts',
);

let fontFaceCss = '';
if (fs.existsSync(FONTS_DIR)) {
  const ttfs = fs.readdirSync(FONTS_DIR).filter((f) => f.endsWith('.ttf'));
  const familyMap = new Map();
  for (const file of ttfs) {
    const base = file.replace(/\.ttf$/, '');
    const match = base.match(/^([^.]+)\.([a-f0-9]{16,})$/i);
    if (!match) continue;
    const family = match[1];
    const relPath = `./assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/${file}`;
    familyMap.set(family, relPath);
  }
  for (const [family, url] of familyMap) {
    fontFaceCss += `@font-face{font-family:"${family}";src:url("${url}") format("truetype");}\n`;
  }
  log(`Injected ${familyMap.size} @font-face rules for icon fonts`);
}

// Kill the browser's default focus outline on inputs/textareas so typing
// doesn't show the blue/white ring. The React Native app draws its own
// caret via cursorColor; the browser ring is unwanted noise.
const inputResetCss = `
input:focus, textarea:focus, button:focus, [role="button"]:focus { outline: none; }
textarea { resize: none; }
`;

if (fontFaceCss || inputResetCss) {
  const injectTag = `<style id="web-reset">\n${fontFaceCss}\n${inputResetCss}</style>`;
  appHtml = appHtml.replace('</head>', `${injectTag}\n</head>`);
}

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
