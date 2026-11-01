import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

function file(relative) {
  return join(ROOT, relative);
}

function requireFile(relative, label = relative) {
  if (!existsSync(file(relative))) fail(`缺少文件：${label}`);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const manifestPath = file('manifest.json');
if (!existsSync(manifestPath)) {
  fail('缺少 manifest.json');
} else {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`manifest.json 不是合法 JSON：${error.message}`);
  }

  if (manifest) {
    if (manifest.manifest_version !== 3) fail('manifest_version 必须为 3');
    if (!manifest.name) fail('manifest 缺少 name');
    if (!manifest.version) fail('manifest 缺少 version');
    if (!manifest.background?.service_worker) fail('manifest 缺少 background.service_worker');
    if (manifest.background?.type !== 'module') fail('background.type 应为 module');
    if (!manifest.action?.default_popup) fail('manifest 缺少 action.default_popup');
    if (!manifest.options_page) fail('manifest 缺少 options_page');
    if (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length === 0) {
      fail('manifest 缺少 content_scripts');
    }

    const paths = new Set();
    const add = (value) => { if (typeof value === 'string') paths.add(value); };
    add(manifest.background?.service_worker);
    add(manifest.action?.default_popup);
    add(manifest.options_page);
    for (const size of Object.values(manifest.action?.default_icon || {})) add(size);
    for (const size of Object.values(manifest.icons || {})) add(size);
    for (const script of manifest.content_scripts || []) {
      for (const js of script.js || []) add(js);
      for (const css of script.css || []) add(css);
    }
    for (const path of paths) requireFile(path);

    if (!manifest.permissions?.includes('storage')) fail('permissions 缺少 storage');
    if (!manifest.permissions?.includes('tabs')) fail('permissions 缺少 tabs');
    if (!manifest.permissions?.includes('scripting')) fail('permissions 缺少 scripting');
    if (!manifest.permissions?.includes('alarms')) fail('permissions 缺少 alarms');
    if (!manifest.permissions?.includes('webNavigation')) fail('permissions 缺少 webNavigation');
    if (!manifest.permissions?.includes('debugger')) fail('permissions 缺少 debugger');
    notes.push(`manifest v${manifest.version} · ${manifest.permissions.length} permissions · ${paths.size} files`);
  }
}

// Verify relative imports in modules and page asset references.
for (const absolute of walk(ROOT)) {
  const relative = absolute.slice(ROOT.length + 1);
  if (absolute.endsWith('.js') || absolute.endsWith('.mjs')) {
    const code = readFileSync(absolute, 'utf8');
    const importRe = /from\s+['"](\.[^'"]+)['"]/g;
    for (const match of code.matchAll(importRe)) {
      const target = resolve(dirname(absolute), match[1]);
      if (!existsSync(target)) fail(`${relative} 引用了不存在的模块：${match[1]}`);
    }
    if (/\bnew\s+Function\s*\(/.test(code)) fail(`${relative} 使用了 new Function`);
    if (/\beval\s*\(/.test(code)) fail(`${relative} 使用了 eval`);
  }
  if (absolute.endsWith('.html')) {
    const html = readFileSync(absolute, 'utf8');
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const value = match[1];
      if (/^(https?:|#|data:)/.test(value)) continue;
      const target = resolve(dirname(absolute), value);
      if (!existsSync(target)) fail(`${relative} 引用了不存在的资源：${value}`);
    }
  }
}

// Minimal required feature checklist.
requireFile('background/service-worker.js');
requireFile('content/content.js');
requireFile('popup/popup.html');
requireFile('options/options.html');
requireFile('shared/planner.js');
requireFile('shared/ai-protocol.js');
requireFile('README.md');

function checkUiIds(htmlRelative, jsRelative) {
  const html = readFileSync(file(htmlRelative), 'utf8');
  const js = readFileSync(file(jsRelative), 'utf8');
  const ids = [];
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) ids.push(match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length) fail(`${htmlRelative} 存在重复 id：${[...new Set(duplicates)].join(', ')}`);

  const refs = new Set();
  for (const match of js.matchAll(/\$\('([^']+)'\)/g)) refs.add(match[1]);
  for (const match of js.matchAll(/getElementById\('([^']+)'\)/g)) refs.add(match[1]);
  for (const id of refs) {
    if (!ids.includes(id)) fail(`${jsRelative} 引用了不存在的 id：${id}`);
  }
}

checkUiIds('popup/popup.html', 'popup/popup.js');
checkUiIds('options/options.html', 'options/options.js');

const content = readFileSync(file('content/content.js'), 'utf8');
for (const marker of ['FF_SNAPSHOT', 'FF_EXECUTE_ACTION', 'FF_HUD', 'findQuiz', 'executePlay']) {
  if (!content.includes(marker)) fail(`content.js 缺少 ${marker}`);
}

const worker = readFileSync(file('background/service-worker.js'), 'utf8');
for (const marker of ['FF_START', 'FF_STOP', 'FF_STATUS', 'runCycle', 'buildActionPlan']) {
  if (!worker.includes(marker)) fail(`service-worker.js 缺少 ${marker}`);
}

if (failures.length) {
  console.error(`✖ ${failures.length} 个问题`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exitCode = 1;
} else {
  console.log(`✔ Chrome 扩展结构检查通过（${notes.join('；')}）`);
}
