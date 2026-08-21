#!/usr/bin/env node
/**
 * region-seo-loader
 *
 * Prepares a Wunderflats city landing page seed script and loads it into MongoDB.
 *
 *   input/lisbon-en.js   ->   output/lisbon-en.js   ->   mongosh
 *
 * Pipeline:
 *   1. read input/<city-lang>.js
 *   2. fix `description: null` -> `description: ''`
 *   3. force the collection to `regions`
 *   4. read the h2 / h3 outline so every prompt can name its destination
 *   5. take four Prismic URLs from images.json or ask for them, build
 *      IMAGE_1..IMAGE_4, place them
 *   6. rewrite the tail as a safe conditional write, generating prismicId
 *   7. save to output/<city-lang>.js and lint it (node --check)
 *   8. ask for the connection string, report what will happen, confirm, run
 *
 * The generated output file is self-contained and safe to hand to an admin.
 * It runs a single updateOne with upsert and two payloads:
 *   - $set          every run        -> h2s
 *   - $setOnInsert  creation only    -> title, metaTitle, metaDescription,
 *                                       prismicId
 * Mongo ignores $setOnInsert on a document that already exists, so those
 * fields keep whatever the live document has. _id is never written, Mongo
 * assigns it.
 *
 * Nothing is stored on disk by this script. No config file, no credentials.
 *
 * Zero dependencies. Node 18+.
 *
 * Usage:
 *   node region-seo-loader.js lisbon-en
 *   node region-seo-loader.js lisbon-en --dry-run
 *   node region-seo-loader.js --all            every .js in input/
 *
 * With --all, every file is prepared first and the database is asked for and
 * confirmed once, not once per city. One city failing does not stop the rest.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const INPUT_DIR = 'input';
const OUTPUT_DIR = 'output';

// One shared file for every city, keyed by <city-lang>. Optional: any city
// without an entry falls back to the prompts. images.txt is the pasteable
// format, images.json the structured one. txt wins if both are present.
const IMAGES_FILES = ['images.txt', 'images.json'];
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-z]{2}$/; // city-lang

const WIDTHS = [1200, 1800, 2400, 3600, 400, 800]; // key order matches the seed files
const PRISMIC_ID_LENGTH = 16;
const PRISMIC_ID_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// Always this collection. Overridable with --collection, never prompted for.
const COLLECTION = 'regions';
const DEFAULT_URI = 'mongodb://localhost:27017/wunderflats-dev';
const URI_ENV_VAR = 'REGION_LOADER_URI';

// Written only when the document is created, via $setOnInsert. Never
// overwritten on a document that already exists.
const INSERT_ONLY_FIELDS = [
  'metaDescription',
  'metaTitle',
  'slug',
  'lang',
  'title',
  'prismicId'
];

// Never written at all. Mongo assigns _id itself, and a hard coded one in the
// input would either collide across environments or be rejected on update.
const DROPPED_FIELDS = ['_id'];

// Where each image goes. Input files carry EMPTY_IMAGE in every slot, so the
// script decides placement rather than reading it from the file.
//
// Matching is on the heading, never on position. Counting breaks as soon as a
// city has an extra section: Brussels carries "Rent Prices" as its own h2 while
// Zurich has it as an h3, which shifts every index after it.
//
// `position` is only a last resort, used when no heading matches, and it always
// warns. When a rule matches nothing and the fallback is missing, or when it
// matches more than one heading, the script asks rather than guesses.
const PLACEMENTS = [
  {
    varName: 'IMAGE_1',
    level: 'h2',
    match: /^\s*tips for finding\b/i,
    describe: 'the "Tips for Finding an Apartment" h2',
    position: { h2: 0 }
  },
  {
    varName: 'IMAGE_2',
    level: 'h2',
    match: /^\s*living in\b/i,
    describe: 'the "Living in <City>" h2',
    position: { h2: 1 }
  },
  {
    varName: 'IMAGE_3',
    level: 'h3',
    match: /^\s*sightseeing\b/i,
    describe: 'the "Sightseeing in <City>" h3',
    position: { h2: 1, h3: 1 }
  },
  {
    varName: 'IMAGE_4',
    level: 'h2',
    match: /^\s*(frequently asked questions|faqs?)\b/i,
    describe: 'the "Frequently Asked Questions" h2',
    position: { h2: 2 }
  }
];

const GENERATED_MARKER = 'region-seo-loader:generated';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m'
};

const log = (s = '') => process.stdout.write(s + '\n');
const ok = (s) => log(`  ${C.green}OK${C.reset}    ${s}`);
const warn = (s) => log(`  ${C.yellow}WARN${C.reset}  ${s}`);
const info = (s) => log(`  ${C.dim}-${C.reset}     ${s}`);

function fail(msg) {
  log(`\n${C.red}Error:${C.reset} ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

// Flags that never take a value, so `--all lisbon-en` keeps lisbon-en as the
// positional argument rather than swallowing it.
const BOOLEAN_FLAGS = new Set(['all', 'dry-run', 'yes', 'outline']);

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(key) && next && !next.startsWith('--')) {
        out.flags[key] = next;
        i++;
      } else {
        out.flags[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// prompting
//
// A small line queue sits in front of readline. Lines that arrive while no
// question is pending are buffered rather than dropped, so answers can also be
// piped in for testing.
// ---------------------------------------------------------------------------

let rl = null;
let queuedLines = [];
let pendingResolve = null;
let stdinClosed = false;

function initPrompt() {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('line', (line) => {
    const value = line.trim();
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(value);
    } else {
      queuedLines.push(value);
    }
  });
  rl.on('close', () => {
    stdinClosed = true;
    if (pendingResolve) fail('input ended before all questions were answered');
  });
}

function ask(question) {
  if (!rl) initPrompt();
  process.stdout.write(question);
  if (queuedLines.length) {
    const value = queuedLines.shift();
    process.stdout.write(value + '\n');
    return Promise.resolve(value);
  }
  if (stdinClosed) {
    fail(
      `needed input ("${question.trim()}") but stdin is closed.\n` +
        `Run the script in a terminal, or pass the value as a flag.`
    );
  }
  return new Promise((resolve) => {
    pendingResolve = resolve;
  });
}

function closePrompt() {
  if (rl) rl.close();
  rl = null;
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

/**
 * Accepts "lisbon-en", "lisbon-en.js", "input/lisbon-en.js" or a full path.
 * Prefers <cwd>/input/<name>.js, which is the normal way to run this.
 */
function resolveInput(name) {
  const raw = name.trim().replace(/^~/, os.homedir());
  const withExt = raw.endsWith('.js') ? raw : `${raw}.js`;

  const candidates = [];
  if (path.isAbsolute(withExt)) {
    candidates.push(withExt);
  } else {
    candidates.push(path.resolve(process.cwd(), INPUT_DIR, withExt));
    candidates.push(path.resolve(__dirname, INPUT_DIR, withExt));
    candidates.push(path.resolve(process.cwd(), withExt));
  }

  const unique = [...new Set(candidates)];
  for (const c of unique) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return { path: c, tried: unique };
  }
  return { path: null, tried: unique };
}

/**
 * input lives at <root>/input/<name>.js, so output goes to <root>/output/<name>.js.
 * If the input came from somewhere else, output/ is created next to it.
 */
/**
 * Parses the plain text format, which is what a colleague's message looks like
 * once pasted into a file:
 *
 *   Lisbon-en:
 *
 *   https://images.prismic.io/.../..._LisbonImage1.jpg
 *   https://images.prismic.io/.../..._LisbonImage2.jpg
 *   ...
 *
 *   Milan-en:
 *   ...
 *
 * City headings are matched case insensitively against the input file name.
 * URLs are taken in order, first is IMAGE_1. Blank lines are ignored.
 */
function parseImagesText(text) {
  const data = {};
  const issues = [];
  let city = null;

  text.split(/\r?\n/).forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) return;

    if (/^https?:\/\//i.test(line)) {
      if (!city) {
        issues.push(`line ${i + 1}: a URL before any "City-lang:" heading, ignored`);
        return;
      }
      data[city].push(line);
      return;
    }

    const heading = line.match(/^(.+?)\s*:\s*$/);
    if (heading) {
      city = heading[1].trim().toLowerCase();
      if (!data[city]) data[city] = [];
      return;
    }

    issues.push(`line ${i + 1}: not a heading or a URL, ignored: "${line}"`);
  });

  for (const [name, urls] of Object.entries(data)) {
    if (urls.length && urls.length !== 4) {
      issues.push(`${name}: ${urls.length} URL(s), expected 4`);
    }
  }
  return { data, issues };
}

function stringifyImagesText(data) {
  return (
    Object.keys(data)
      .sort()
      .map((city) => {
        const urls = Array.isArray(data[city])
          ? data[city]
          : Object.keys(data[city])
              .sort()
              .map((k) => data[city][k]);
        return `${city}:\n\n${urls.join('\n')}\n`;
      })
      .join('\n') + ''
  );
}

/**
 * The shared URL file. Looked for in the working directory and next to the
 * script. Missing is fine, it just means every city gets prompted.
 */
function loadImageManifest(override) {
  const candidates = override
    ? [path.resolve(override)]
    : IMAGES_FILES.flatMap((name) => [
        path.resolve(process.cwd(), name),
        path.resolve(__dirname, name)
      ]);

  for (const p of [...new Set(candidates)]) {
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p, 'utf8');

    if (p.endsWith('.json')) {
      try {
        return { path: p, format: 'json', data: JSON.parse(raw), existed: true, issues: [] };
      } catch (e) {
        throw new Error(`${p} is not valid JSON: ${e.message}`);
      }
    }
    const parsed = parseImagesText(raw);
    return {
      path: p,
      format: 'txt',
      data: parsed.data,
      existed: true,
      issues: parsed.issues
    };
  }

  return {
    path: path.resolve(process.cwd(), IMAGES_FILES[0]),
    format: 'txt',
    data: {},
    existed: false,
    issues: []
  };
}

/** Accepts either { IMAGE_1: url, ... } or a plain array of four URLs. */
function normaliseManifestEntry(entry) {
  if (!entry) return {};
  if (Array.isArray(entry)) {
    const out = {};
    entry.forEach((url, i) => {
      if (typeof url === 'string' && url.trim()) out[`IMAGE_${i + 1}`] = url.trim();
    });
    return out;
  }
  if (typeof entry === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(entry)) {
      if (typeof v !== 'string' || !v.trim()) continue;
      const m = String(k).match(/(\d+)/);
      out[m ? `IMAGE_${m[1]}` : k] = v.trim();
    }
    return out;
  }
  return {};
}

function saveImageManifest(manifest, stem, urls) {
  const data = manifest.data || {};
  data[stem.toLowerCase()] = urls;

  if (manifest.format === 'json') {
    const ordered = {};
    Object.keys(data)
      .sort()
      .forEach((k) => (ordered[k] = data[k]));
    fs.writeFileSync(manifest.path, JSON.stringify(ordered, null, 2) + '\n', 'utf8');
    return;
  }
  fs.writeFileSync(manifest.path, stringifyImagesText(data), 'utf8');
}

function resolveOutput(inputPath, override) {
  if (typeof override === 'string' && override) {
    return path.resolve(override);
  }
  const dir = path.dirname(inputPath);
  const root = path.basename(dir) === INPUT_DIR ? path.dirname(dir) : dir;
  return path.join(root, OUTPUT_DIR, path.basename(inputPath));
}

// ---------------------------------------------------------------------------
// prismic helpers
// ---------------------------------------------------------------------------

function randomPrismicId() {
  const bytes = crypto.randomBytes(PRISMIC_ID_LENGTH);
  let s = '';
  for (let i = 0; i < PRISMIC_ID_LENGTH; i++) {
    s += PRISMIC_ID_ALPHABET[bytes[i] % PRISMIC_ID_ALPHABET.length];
  }
  return s;
}

/**
 * Splits a Prismic image URL into its parts. The asset id is kept exactly as
 * pasted, so the resulting URLs actually resolve.
 *   https://images.prismic.io/<repo>/<16-char-id>_<filename>.<ext>[?query]
 */
function parsePrismicUrl(raw) {
  let u;
  try {
    u = new URL(raw.trim());
  } catch (e) {
    throw new Error(`not a valid URL: ${raw}`);
  }
  if (!/(^|\.)prismic\.io$/.test(u.hostname)) {
    throw new Error(`host is "${u.hostname}", expected images.prismic.io`);
  }
  const segments = u.pathname.split('/').filter(Boolean);
  if (segments.length < 2) {
    throw new Error(`path "${u.pathname}" does not look like <repo>/<asset>`);
  }
  const asset = segments[segments.length - 1];
  const repoPath = segments.slice(0, -1).join('/');

  if (asset.length <= PRISMIC_ID_LENGTH + 1 || asset[PRISMIC_ID_LENGTH] !== '_') {
    throw new Error(
      `asset "${asset}" does not match <${PRISMIC_ID_LENGTH}-char id>_<filename>`
    );
  }
  return {
    origin: u.origin,
    repoPath,
    id: asset.slice(0, PRISMIC_ID_LENGTH),
    filename: asset.slice(PRISMIC_ID_LENGTH + 1)
  };
}

function buildImageBlock(varName, parts) {
  const base = `${parts.origin}/${parts.repoPath}/${parts.id}_${parts.filename}`;
  const lines = WIDTHS.map(
    (w, i) =>
      `  px${w}: '${base}?auto=format,compress&w=${w}'` +
      (i === WIDTHS.length - 1 ? '' : ',')
  );
  return `var ${varName} = {\n${lines.join('\n')}\n};`;
}

// ---------------------------------------------------------------------------
// a very small JS text scanner
//
// Enough to walk balanced brackets while skipping strings and comments. The
// seed files are machine generated and contain no regex literals.
// ---------------------------------------------------------------------------

function skipNonCode(src, i) {
  const c = src[i];
  if (c === '/' && src[i + 1] === '/') {
    while (i < src.length && src[i] !== '\n') i++;
    return i;
  }
  if (c === '/' && src[i + 1] === '*') {
    i += 2;
    while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
    return i + 1;
  }
  if (c === "'" || c === '"' || c === '`') {
    const quote = c;
    i++;
    while (i < src.length) {
      if (src[i] === '\\') {
        i += 2;
        continue;
      }
      if (src[i] === quote) break;
      i++;
    }
    return i;
  }
  return -1;
}

/** src[start] must be an opening bracket. Returns the index of its match. */
function matchBracket(src, start) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const open = src[start];
  const close = pairs[open];
  if (!close) return -1;

  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const skipped = skipNonCode(src, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits "a, {b: 1}, [c]" into top level pieces. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const skipped = skipNonCode(text, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }
    const c = text[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length);
}

/**
 * Top level properties of an object literal given as text, each with its own
 * source slice so it can be moved around without reformatting the contents.
 * Returns [{ name, text, valueText }].
 */
function topLevelProperties(objText) {
  const open = objText.indexOf('{');
  const close = objText.lastIndexOf('}');
  if (open === -1 || close === -1) return [];

  const spans = [];
  let depth = 0;
  let segStart = open + 1;
  for (let i = open + 1; i < close; i++) {
    const skipped = skipNonCode(objText, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }
    const c = objText[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      spans.push([segStart, i]);
      segStart = i + 1;
    }
  }
  spans.push([segStart, close]);

  return spans
    .map(([s, e]) => {
      const seg = objText.slice(s, e);
      const m = seg.match(/^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/);
      if (!m) return null;
      return {
        name: m[1] || m[2] || m[3],
        text: seg.replace(/^\s*\n?/, '').replace(/\s+$/, ''),
        valueText: seg.slice(m[0].length).trim()
      };
    })
    .filter(Boolean);
}

function objectKeys(objText) {
  return topLevelProperties(objText).map((p) => p.name);
}

/** Renders properties back into an object literal at two space indent. */
function renderObject(props) {
  if (!props.length) return '{}';
  return `{\n${props.map((p) => `  ${p.text}`).join(',\n')}\n}`;
}

// ---------------------------------------------------------------------------
// source transforms
// ---------------------------------------------------------------------------

function fixDescriptions(src) {
  let count = 0;
  const fixed = src.replace(/(["']?description["']?\s*:\s*)null\b/g, (_m, p1) => {
    count++;
    return `${p1}''`;
  });
  return { src: fixed, count };
}

function findOtherNulls(src) {
  const found = {};
  const re = /(["']?)([A-Za-z0-9_]+)\1\s*:\s*null\b/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const key = m[2];
    // alt and caption are legitimately nullable, prismicId is handled later.
    if (key === 'alt' || key === 'caption' || key === 'prismicId') continue;
    found[key] = (found[key] || 0) + 1;
  }
  return found;
}

function readCollection(src) {
  const m = src.match(/var\s+COLLECTION\s*=\s*['"]([^'"]*)['"]\s*;/);
  return m ? m[1] : null;
}

function setCollection(src, name) {
  if (!/var\s+COLLECTION\s*=\s*['"][^'"]*['"]\s*;/.test(src)) {
    throw new Error('no `var COLLECTION = "...";` line found in the input file');
  }
  return src.replace(
    /var\s+COLLECTION\s*=\s*['"][^'"]*['"]\s*;/,
    `var COLLECTION = '${name}';`
  );
}

function setImageBlocks(src, blocks) {
  const out = src.replace(/var\s+IMAGE_\d+\s*=\s*\{[\s\S]*?\n\};\n?/g, '');

  const emptyRe = /var\s+EMPTY_IMAGE\s*=\s*\{[\s\S]*?\n\};/;
  const m = out.match(emptyRe);
  if (!m) throw new Error('could not find a `var EMPTY_IMAGE = { ... };` block');

  const insertAt = m.index + m[0].length;
  const tail = out.slice(insertAt).replace(/^\n+/, '\n\n');
  return out.slice(0, insertAt) + '\n\n' + blocks.join('\n') + tail;
}

function scanImageSlots(lines) {
  const IMAGE_RE = /^(\s*)image:\s*[A-Za-z0-9_.]+\s*(,?)\s*$/;
  const TEXT_RE = /^\s*text:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*,?\s*$/;

  const slots = [];
  lines.forEach((line, i) => {
    const m = line.match(IMAGE_RE);
    if (!m) return;
    const t = (lines[i + 1] || '').match(TEXT_RE);
    slots.push({
      line: i,
      indent: m[1].length,
      trailing: m[2],
      text: t ? (t[1] !== undefined ? t[1] : t[2]) : null
    });
  });

  if (!slots.length) return [];

  const h2Indent = Math.min(...slots.map((s) => s.indent));
  const h2s = [];
  let pendingH3s = [];
  for (const slot of slots) {
    if (slot.indent === h2Indent) {
      h2s.push(Object.assign({}, slot, { h3s: pendingH3s }));
      pendingH3s = [];
    } else {
      pendingH3s.push(slot);
    }
  }
  return h2s;
}

/**
 * Flattens the outline into addressable slots. The id is stable across a
 * rescan of the same document, which is what lets a choice made once be
 * re-applied after the IMAGE_n blocks shift the line numbers.
 */
function buildSlotIndex(h2s) {
  const slots = [];
  h2s.forEach((h2, i) => {
    slots.push({
      id: `h2:${i}`,
      level: 'h2',
      slot: h2,
      text: h2.text,
      where: `h2 #${i + 1}`,
      label: `h2 #${i + 1}  "${h2.text || '(no heading)'}"`
    });
    h2.h3s.forEach((h3, j) => {
      slots.push({
        id: `h2:${i}/h3:${j}`,
        level: 'h3',
        slot: h3,
        text: h3.text,
        where: `h2 #${i + 1} > h3 #${j + 1}`,
        label: `    h3 #${j + 1}  "${h3.text || '(no heading)'}"`
      });
    });
  });
  return slots;
}

function positionSlot(index, position) {
  const id =
    position.h3 === undefined ? `h2:${position.h2}` : `h2:${position.h2}/h3:${position.h3}`;
  return index.find((s) => s.id === id) || null;
}

function printOutline(index) {
  index.forEach((s) => log(`      ${C.dim}${s.label}${C.reset}`));
}

/**
 * Decides where each image goes, by heading. Falls back to position with a
 * warning, and asks when it genuinely cannot tell.
 */
async function resolvePlacements(h2s, opts = {}) {
  const index = buildSlotIndex(h2s);
  const interactive = opts.interactive !== false && Boolean(process.stdin.isTTY);
  const resolved = [];
  const notes = [];
  const used = new Set();

  for (const p of PLACEMENTS) {
    const free = (s) => !used.has(s.id);
    const candidates = index.filter(
      (s) => s.level === p.level && s.text && p.match.test(s.text) && free(s)
    );

    let chosen = null;

    if (candidates.length === 1) {
      chosen = candidates[0];
      const byPosition = positionSlot(index, p.position);
      if (!byPosition || byPosition.id !== chosen.id) {
        notes.push({
          level: 'info',
          text: `${p.varName}: matched ${p.describe} at ${chosen.where}, not the usual position`
        });
      }
    } else if (candidates.length === 0) {
      const fb = positionSlot(index, p.position);
      if (fb && free(fb)) {
        chosen = fb;
        notes.push({
          level: 'warn',
          text:
            `${p.varName}: nothing matches ${p.describe}. Falling back to ` +
            `${fb.where} "${fb.text}" by position. Check this one.`
        });
      } else {
        notes.push({
          level: 'warn',
          text: `${p.varName}: nothing matches ${p.describe}, and no free section at the usual position`
        });
      }
    } else {
      notes.push({
        level: 'warn',
        text:
          `${p.varName}: ${candidates.length} headings match ${p.describe} ` +
          `(${candidates.map((c) => `"${c.text}"`).join(', ')})`
      });
    }

    // Nothing safe to pick. Ask, rather than guess.
    if (!chosen) {
      if (!interactive) {
        throw new Error(
          `${p.varName}: cannot decide where this image goes in this file.\n` +
            `        Expected ${p.describe}.\n` +
            `        Run without --all in a terminal to choose, or use --outline to see the structure.`
        );
      }
      const options = (candidates.length ? candidates : index).filter(free);
      log(`\n  ${C.yellow}${p.varName} needs a section.${C.reset} Expected ${p.describe}.`);
      // Full path, not the indented tree label: used slots are filtered out,
      // so the indentation would no longer line up.
      options.forEach((s, i) =>
        log(
          `      ${String(i + 1).padStart(2)}) ${s.where.padEnd(20)} "${s.text || '(no heading)'}"`
        )
      );
      log(`       0) skip this image`);
      const answer = await ask(`  Which one for ${p.varName}? [0-${options.length}]: `);
      const pick = parseInt(answer, 10);
      if (pick >= 1 && pick <= options.length) {
        chosen = options[pick - 1];
        notes.push({ level: 'info', text: `${p.varName}: you chose ${chosen.where} "${chosen.text}"` });
      } else {
        notes.push({ level: 'warn', text: `${p.varName}: skipped` });
      }
    }

    if (chosen) used.add(chosen.id);
    resolved.push({
      varName: p.varName,
      id: chosen ? chosen.id : null,
      slot: chosen ? chosen.slot : null,
      where: chosen ? chosen.where : null,
      text: chosen ? chosen.text : null
    });
  }

  return { resolved, notes, index };
}

function writeImageSlot(lines, slot, varName) {
  lines[slot.line] = `${' '.repeat(slot.indent)}image: ${varName}${slot.trailing}`;
}

// ---------------------------------------------------------------------------
// the write statement
// ---------------------------------------------------------------------------

/**
 * Pulls the document out of whichever shape the input uses:
 *   db.getCollection(COLLECTION).insertOne({ ... });
 *   db.getCollection(COLLECTION).updateOne({...}, {$set: {...}}, {upsert: true});
 *   a file this script generated earlier
 *
 * Returns { head, props } where props are the document's top level fields.
 */
function extractDocument(src) {
  if (src.includes(GENERATED_MARKER)) {
    const bannerStart = src.lastIndexOf('// ---', src.indexOf(GENERATED_MARKER));
    const head = src.slice(0, bannerStart === -1 ? 0 : bannerStart).replace(/\s+$/, '');

    const props = [];
    for (const varName of ['WRITE_ALWAYS', 'WRITE_ON_CREATE']) {
      const at = src.search(new RegExp(`var\\s+${varName}\\s*=\\s*\\{`));
      if (at === -1) continue;
      const open = src.indexOf('{', at);
      const close = matchBracket(src, open);
      if (close === -1) throw new Error(`unbalanced braces in ${varName}`);
      props.push(...topLevelProperties(src.slice(open, close + 1)));
    }
    // slug and lang live in KEY only, since the upsert seeds them from the
    // filter. Fold them back in so the document is whole again.
    const keyAt = src.search(/var\s+KEY\s*=\s*\{/);
    if (keyAt !== -1) {
      const open = src.indexOf('{', keyAt);
      const close = matchBracket(src, open);
      if (close !== -1) {
        for (const f of topLevelProperties(src.slice(open, close + 1))) {
          if (!props.some((p) => p.name === f.name)) props.push(f);
        }
      }
    }

    if (!props.length) {
      throw new Error('this looks like a generated file but it carries no fields');
    }
    return { head, props };
  }

  const insertRe = /db\s*\.\s*getCollection\s*\(\s*COLLECTION\s*\)\s*\.\s*insertOne\s*\(/;
  const updateRe = /db\s*\.\s*getCollection\s*\(\s*COLLECTION\s*\)\s*\.\s*updateOne\s*\(/;

  const insertMatch = src.match(insertRe);
  if (insertMatch) {
    const openParen = insertMatch.index + insertMatch[0].length - 1;
    const closeParen = matchBracket(src, openParen);
    if (closeParen === -1) throw new Error('unbalanced parentheses in the insertOne call');
    const args = splitTopLevel(src.slice(openParen + 1, closeParen));
    if (!args.length) throw new Error('insertOne has no document');
    return {
      head: src.slice(0, insertMatch.index).replace(/\s+$/, ''),
      props: topLevelProperties(args[0])
    };
  }

  const updateMatch = src.match(updateRe);
  if (updateMatch) {
    const openParen = updateMatch.index + updateMatch[0].length - 1;
    const closeParen = matchBracket(src, openParen);
    if (closeParen === -1) throw new Error('unbalanced parentheses in the updateOne call');

    const args = splitTopLevel(src.slice(openParen + 1, closeParen));
    if (args.length < 2) throw new Error('updateOne needs a filter and an update');

    const updateText = args[1];
    const dollarSet = updateText.search(/\$set\s*:/);
    if (dollarSet === -1) throw new Error('the updateOne call has no `$set`');
    const setOpen = updateText.indexOf('{', dollarSet);
    const setClose = matchBracket(updateText, setOpen);
    if (setOpen === -1 || setClose === -1) throw new Error('unbalanced braces in `$set`');

    const props = topLevelProperties(updateText.slice(setOpen, setClose + 1));
    // The filter usually carries slug and lang. Fold them in if $set omits them.
    for (const f of topLevelProperties(args[0])) {
      if (!props.some((p) => p.name === f.name)) props.push(f);
    }
    return {
      head: src.slice(0, updateMatch.index).replace(/\s+$/, ''),
      props
    };
  }

  throw new Error(
    'could not find `db.getCollection(COLLECTION).insertOne(...)` or `.updateOne(...)` ' +
      'in the input file'
  );
}

/**
 * prismicId must be a real value on a new document. Generates one when the
 * field is missing, null or blank. An existing real value is left alone.
 */
function ensurePrismicId(props) {
  const existing = props.find((p) => p.name === 'prismicId');
  if (existing && !/^(null|undefined|''|""|``)$/.test(existing.valueText)) {
    return { props, generated: null, replaced: false };
  }
  const id = randomPrismicId();
  if (existing) {
    existing.text = `prismicId: '${id}'`;
    existing.valueText = `'${id}'`;
    return { props, generated: id, replaced: true };
  }
  return {
    props: [{ name: 'prismicId', text: `prismicId: '${id}'`, valueText: `'${id}'` }, ...props],
    generated: id,
    replaced: false
  };
}

function readDocumentKey(props) {
  const read = (name) => {
    const p = props.find((x) => x.name === name);
    if (!p) return null;
    const m = p.valueText.match(/^['"]([^'"]*)['"]$/);
    return m ? m[1] : p.valueText;
  };
  return { slug: read('slug'), lang: read('lang') };
}

/**
 * Splits the document into the part written on every run and the part written
 * only when the document is created, then emits a single updateOne.
 *
 * $setOnInsert is what makes this safe: Mongo applies it only when the upsert
 * actually inserts, and ignores it entirely on an existing document. No read,
 * no branching, no race.
 */
function buildWriteStatement(key, props) {
  const keyNames = Object.keys(key).filter((k) => key[k] !== null);

  const always = props.filter((p) => !INSERT_ONLY_FIELDS.includes(p.name));
  const onCreate = props.filter((p) => INSERT_ONLY_FIELDS.includes(p.name));

  const keyText = `{ ${keyNames.map((k) => `${k}: '${key[k]}'`).join(', ')} }`;

  const setOnInsert = onCreate.length
    ? `,\n    $setOnInsert: WRITE_ON_CREATE`
    : '';

  return `// ---------------------------------------------------------------------------
// ${GENERATED_MARKER}
//
// Safe to run more than once, and safe on an environment where the document
// may or may not exist yet.
//
// One updateOne with upsert. Two payloads:
//
//   $set          written every run           -> ${always.map((p) => p.name).join(', ') || 'nothing'}
//   $setOnInsert  written only on creation    -> ${onCreate.map((p) => p.name).join(', ') || 'nothing'}
//
// Mongo ignores $setOnInsert when the document already exists, so those fields
// keep whatever the live document has. Every value below is copied verbatim
// from the input file, apart from prismicId when the input had none. _id is
// not written at all, Mongo assigns it.
// ---------------------------------------------------------------------------

var KEY = ${keyText};

// Replaced on every run.
var WRITE_ALWAYS = ${renderObject(always)};
${
  onCreate.length
    ? `
// Only used if this run creates the document. Never overwritten afterwards.
var WRITE_ON_CREATE = ${renderObject(onCreate)};
`
    : ''
}
var result = db.getCollection(COLLECTION).updateOne(
  KEY,
  {
    $set: WRITE_ALWAYS${setOnInsert}
  },
  { upsert: true }
);

printjson(result);
print(
  result.upsertedCount
    ? 'Created ' + JSON.stringify(KEY) + ' with: ' +
      Object.keys(WRITE_ALWAYS).concat(${
        onCreate.length ? 'Object.keys(WRITE_ON_CREATE)' : '[]'
      }).join(', ')
    : 'Updated ' + JSON.stringify(KEY) + '. Written: ' +
      Object.keys(WRITE_ALWAYS).join(', ') +
      '. Left as it was: ${onCreate.map((p) => p.name).join(', ') || 'nothing'}.'
);
`;
}

// ---------------------------------------------------------------------------
// mongo helpers
// ---------------------------------------------------------------------------

function parseMongoUri(uri) {
  const m = uri
    .trim()
    .match(/^mongodb(\+srv)?:\/\/(?:([^:@/]+)(?::([^@/]*))?@)?([^/?]+)(?:\/([^?]*))?/);
  if (!m) return null;
  return {
    srv: Boolean(m[1]),
    user: m[2] || null,
    hasPassword: Boolean(m[3]),
    hosts: m[4],
    db: m[5] || null
  };
}

function maskUri(uri) {
  return uri.replace(/\/\/([^:@/]+):([^@]*)@/, '//$1:****@');
}

function isLocalUri(uri) {
  const p = parseMongoUri(uri);
  if (!p) return false;
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(p.hosts);
}

function which(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], {
    encoding: 'utf8'
  });
  return r.status === 0 ? r.stdout.trim().split('\n')[0] : null;
}

/** Returns 'exists', 'new' or null when the check could not be run. */
function probeDocument(uri, collection, key) {
  const evalScript =
    `const d = db.getCollection(${JSON.stringify(collection)}).findOne(` +
    `{slug: ${JSON.stringify(key.slug)}, lang: ${JSON.stringify(key.lang)}}, {_id: 1});` +
    `print(d ? 'EXISTS ' + d._id : 'NEW');`;
  const r = spawnSync('mongosh', [uri, '--quiet', '--eval', evalScript], {
    encoding: 'utf8'
  });
  if (r.status !== 0) return { state: null, detail: (r.stderr || r.stdout || '').trim() };
  const outText = (r.stdout || '').trim();
  if (outText.startsWith('EXISTS')) {
    return { state: 'exists', detail: outText.replace('EXISTS ', '') };
  }
  if (outText === 'NEW') return { state: 'new', detail: null };
  return { state: null, detail: outText };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/** Every .js in input/, sorted. Dotfiles and _drafts are skipped. */
function listInputFiles() {
  const dirs = [
    path.resolve(process.cwd(), INPUT_DIR),
    path.resolve(__dirname, INPUT_DIR)
  ];
  for (const dir of [...new Set(dirs)]) {
    if (!fs.existsSync(dir)) continue;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.js') && !f.startsWith('.') && !f.startsWith('_'))
      .sort()
      .map((f) => path.join(dir, f));
    if (files.length) return { dir, files };
    return { dir, files: [] };
  }
  return { dir: dirs[0], files: [] };
}

/**
 * Everything for one city, up to and including writing output/<city-lang>.js.
 * Touches no database. Returns what the database step needs.
 */
async function prepareFile(inputPath, flags, manifest) {
  const outPath = resolveOutput(inputPath, flags.out);
  const stem = path.basename(inputPath, '.js');

  let src = fs.readFileSync(inputPath, 'utf8');

  log(`${C.bold}1. Checks${C.reset}`);
  info(`input:  ${inputPath}`);
  if (!NAME_PATTERN.test(stem)) {
    warn(`"${stem}" is not in city-lang form (e.g. lisbon-en). Carrying on anyway.`);
  }

  // --- descriptions ------------------------------------------------------
  const descResult = fixDescriptions(src);
  src = descResult.src;
  if (descResult.count > 0) ok(`replaced ${descResult.count} null description(s) with ''`);
  else ok('no null descriptions');

  const otherNulls = findOtherNulls(src);
  const otherKeys = Object.keys(otherNulls);
  if (otherKeys.length) {
    warn(
      `other null fields left untouched: ` +
        otherKeys.map((k) => `${k} x${otherNulls[k]}`).join(', ')
    );
  }

  // --- collection --------------------------------------------------------
  const existingCollection = readCollection(src);
  if (existingCollection === null) {
    fail('no `var COLLECTION = "...";` line in the input file');
  }

  // Always the same collection. --collection is only an escape hatch.
  const collection =
    typeof flags.collection === 'string' && flags.collection
      ? flags.collection
      : COLLECTION;

  try {
    src = setCollection(src, collection);
  } catch (e) {
    fail(e.message);
  }

  if (existingCollection && existingCollection !== collection) {
    ok(`collection: ${collection}  (input said '${existingCollection}', overridden)`);
  } else {
    ok(`collection: ${collection}`);
  }

  // --- outline -----------------------------------------------------------
  let lines = src.split('\n');
  const h2s = scanImageSlots(lines);
  if (!h2s.length) fail('found no `image:` assignments in the file');

  ok(
    `found ${h2s.length} h2 section(s), ` +
      `${h2s.reduce((n, h) => n + h.h3s.length, 0)} h3 section(s)`
  );

  if (flags.outline) {
    printOutline(buildSlotIndex(h2s));
  }

  let resolved;
  let notes;
  try {
    ({ resolved, notes } = await resolvePlacements(h2s));
  } catch (e) {
    fail(`${stem}: ${e.message}`);
  }
  notes.forEach((n) => (n.level === 'warn' ? warn(n.text) : info(n.text)));

  if (flags.outline) {
    log();
    resolved.forEach((r) =>
      r.slot
        ? ok(`${r.varName} -> ${r.where}  "${r.text}"`)
        : warn(`${r.varName} -> nowhere`)
    );
    log(`\n${C.yellow}--outline${C.reset} only, stopping here.\n`);
    closePrompt();
    process.exit(0);
  }

  // --- images ------------------------------------------------------------
  log(`\n${C.bold}2. Images${C.reset}`);

  const manifestName = path.basename(manifest.path);

  // City headings are matched case insensitively, so "Lisbon-en:" finds
  // input/lisbon-en.js.
  const wanted = stem.toLowerCase();
  const matchKey = Object.keys(manifest.data).find((k) => k.toLowerCase() === wanted);
  const saved = normaliseManifestEntry(matchKey ? manifest.data[matchKey] : null);
  const savedCount = Object.keys(saved).length;

  (manifest.issues || []).forEach((i) => warn(`${manifestName}: ${i}`));

  if (savedCount) {
    ok(`${manifestName}: found ${savedCount} URL(s) for ${matchKey}`);
    info(manifest.path);
  } else if (manifest.existed) {
    const known = Object.keys(manifest.data).sort().join(', ');
    info(`${manifestName} has no entry for ${stem}, so you will be asked`);
    if (known) info(`it does have: ${known}`);
  } else {
    info(`no ${IMAGES_FILES.join(' or ')} yet, so you will be asked`);
  }
  log(`  ${C.dim}Each prompt names where the image lands.${C.reset}\n`);

  const seenUrls = new Set();
  const blocks = [];
  const placed = [];
  const collected = {};
  let anyTyped = false;

  for (let i = 0; i < resolved.length; i++) {
    const target = resolved[i];
    const flagKey = `img${i + 1}`;

    if (!target.slot) {
      warn(`${target.varName} skipped, no matching section in this file`);
      continue;
    }

    log(
      `  ${C.cyan}${target.varName}${C.reset}  ->  ${target.where}  ` +
        `${C.bold}"${target.text || '(no heading)'}"${C.reset}`
    );

    // flag beats the saved file, the saved file beats asking.
    let url = flags[flagKey];
    let source = 'flag';
    if (typeof url !== 'string') {
      if (saved[target.varName]) {
        url = saved[target.varName];
        source = manifestName;
        log(`  ${C.dim}from ${manifestName}:${C.reset} ${url}`);
      } else {
        url = await ask(`  Prismic URL: `);
        source = 'typed';
        anyTyped = true;
      }
    }
    if (!url) fail(`${target.varName}: a URL is required`);
    collected[target.varName] = url.trim();
    void source;

    let parts;
    try {
      parts = parsePrismicUrl(url);
    } catch (e) {
      fail(`${target.varName}: ${e.message}`);
    }

    const key = `${parts.id}_${parts.filename}`;
    if (seenUrls.has(key)) warn(`the same image was already used for another slot`);
    seenUrls.add(key);

    blocks.push(buildImageBlock(target.varName, parts));
    placed.push({
      varName: target.varName,
      slotId: target.id,
      where: target.where,
      text: target.text,
      filename: parts.filename,
      id: parts.id
    });
    log(`  ${C.dim}${parts.filename}  id ${parts.id}${C.reset}\n`);
  }

  if (!placed.length) fail('no images could be placed');

  // Offer to remember what was typed, so the next run for this city is silent.
  if (anyTyped && process.stdin.isTTY && flags.yes !== true) {
    const yn = await ask(
      `  Save these URLs to ${manifestName} for next time? [y/N]: `
    );
    if (/^y(es)?$/i.test(yn)) {
      try {
        saveImageManifest(manifest, stem, collected);
        ok(`saved ${stem} to ${manifest.path}`);
      } catch (e) {
        warn(`could not write ${manifest.path}: ${e.message}`);
      }
    }
    log();
  }

  try {
    src = setImageBlocks(src, blocks);
  } catch (e) {
    fail(e.message);
  }

  // Line numbers shift when the blocks are inserted, so rescan and look the
  // slots up again by id. Ids are positions in the outline, which the insert
  // does not change, so no question is asked twice.
  lines = src.split('\n');
  const afterIndex = buildSlotIndex(scanImageSlots(lines));
  for (const p of placed) {
    const target = afterIndex.find((s) => s.id === p.slotId);
    if (!target) fail(`internal: lost the slot for ${p.varName}`);
    writeImageSlot(lines, target.slot, p.varName);
  }
  src = lines.join('\n');

  const remaining = (src.match(/image:\s*EMPTY_IMAGE/g) || []).length;
  ok(`${placed.length} image(s) placed, ${remaining} slot(s) left as EMPTY_IMAGE`);
  placed.forEach((p) => info(`${p.varName} -> ${p.where}  "${p.text}"`));

  // --- rebuild the write statement ---------------------------------------
  log(`\n${C.bold}3. Write statement${C.reset}`);

  let extracted;
  try {
    extracted = extractDocument(src);
  } catch (e) {
    fail(e.message);
  }

  const dropped = extracted.props
    .filter((p) => DROPPED_FIELDS.includes(p.name))
    .map((p) => p.name);
  extracted.props = extracted.props.filter((p) => !DROPPED_FIELDS.includes(p.name));
  if (dropped.length) {
    ok(`dropped ${dropped.join(', ')} from the write, MongoDB assigns it`);
  }

  const withId = ensurePrismicId(extracted.props);
  const props = withId.props;
  if (withId.generated) {
    ok(
      `generated prismicId: ${withId.generated}` +
        (withId.replaced ? '  (the file had null)' : '  (the file had none)')
    );
    info('only used if this run creates the document. An existing one is never touched.');
  } else {
    ok('the file already carries a prismicId, left as is');
  }

  const doc = readDocumentKey(props);
  if (!doc.slug || !doc.lang) {
    fail('the document has no slug and lang, so there is nothing to match on');
  }

  const always = props
    .filter((p) => !INSERT_ONLY_FIELDS.includes(p.name))
    .map((p) => p.name);
  const onCreate = props
    .filter((p) => INSERT_ONLY_FIELDS.includes(p.name))
    .map((p) => p.name);

  const blankFields = props
    .filter((p) => onCreate.includes(p.name) && /^(''|""|``)$/.test(p.valueText))
    .map((p) => p.name);

  info(`document:      slug=${doc.slug}  lang=${doc.lang}`);
  info(`one updateOne with upsert:`);
  info(`  $set          every run       ${always.join(', ') || 'nothing'}`);
  info(`  $setOnInsert  creation only   ${onCreate.join(', ') || 'nothing'}`);
  if (blankFields.length) {
    warn(
      `${blankFields.join(', ')} ${blankFields.length === 1 ? 'is' : 'are'} blank in the ` +
        `input. On a new document ${blankFields.length === 1 ? 'it' : 'they'} will be ` +
        `created empty. An existing document keeps its current value.`
    );
  }

  src =
    extracted.head + '\n\n' + buildWriteStatement(doc, props);

  // --- save + lint -------------------------------------------------------
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, src, 'utf8');

  const check = spawnSync(process.execPath, ['--check', outPath], { encoding: 'utf8' });
  if (check.status !== 0) {
    fail(`generated file is not valid JavaScript:\n${check.stderr}`);
  }

  log(`\n${C.bold}4. Output${C.reset}`);
  ok('syntax check passed');
  info(`saved: ${outPath}`);
  info('this file is self-contained. Hand it to an admin to run whenever.');

  return { stem, inputPath, outPath, collection, doc, always, onCreate };
}

// ---------------------------------------------------------------------------

async function main() {
  const { _: positional, flags } = parseArgs(process.argv.slice(2));

  log(`\n${C.bold}region-seo-loader${C.reset} ${C.dim}(Wunderflats city landing pages)${C.reset}\n`);

  // --- which files -------------------------------------------------------
  let inputPaths;
  if (flags.all) {
    if (positional.length) {
      fail('--all takes every file in input/, so do not name one as well');
    }
    if (typeof flags.out === 'string') {
      fail('--out names a single file, so it cannot be combined with --all');
    }
    const found = listInputFiles();
    if (!found.files.length) fail(`no .js files in ${found.dir}`);
    inputPaths = found.files;
    ok(`${inputPaths.length} file(s) in ${found.dir}`);
    inputPaths.forEach((p) => info(path.basename(p)));
    log();
  } else {
    let name = positional[0];
    if (!name) name = await ask('  City file (e.g. lisbon-en, or --all for every one): ');
    if (!name) fail('a file name is required');

    const found = resolveInput(name);
    if (!found.path) {
      fail(
        `could not find "${name}". Looked in:\n` +
          found.tried.map((t) => `        ${t}`).join('\n')
      );
    }
    inputPaths = [found.path];
  }

  // Read once, shared by every file in the run.
  let manifest;
  try {
    manifest = loadImageManifest(flags.images);
  } catch (e) {
    fail(e.message);
  }

  // --- prepare everything before touching a database ---------------------
  const prepared = [];
  for (let i = 0; i < inputPaths.length; i++) {
    if (inputPaths.length > 1) {
      const label = path.basename(inputPaths[i], '.js');
      log(
        `${C.bold}${C.cyan}${'='.repeat(66)}${C.reset}\n` +
          `${C.bold}${C.cyan}  ${label}${C.reset}  ${C.dim}(${i + 1} of ${inputPaths.length})${C.reset}\n` +
          `${C.bold}${C.cyan}${'='.repeat(66)}${C.reset}\n`
      );
    }
    prepared.push(await prepareFile(inputPaths[i], flags, manifest));
    if (inputPaths.length > 1) log();
  }

  if (prepared.length > 1) {
    log(`${C.bold}Prepared${C.reset}`);
    prepared.forEach((p) => info(`${p.stem.padEnd(16)} -> ${p.outPath}`));
  }

  if (flags['dry-run']) {
    log(
      `\n${C.yellow}Dry run.${C.reset} ${prepared.length} output file(s) ready. ` +
        `Nothing was written to any database.\n`
    );
    closePrompt();
    return;
  }

  // --- connection string -------------------------------------------------
  // Never stored, never written to disk. Typed here or taken from an env var.
  // Asked once, whether this run covers one city or all of them.
  log(`\n${C.bold}5. Database${C.reset}`);

  let uri;
  if (typeof flags.uri === 'string' && flags.uri) {
    uri = flags.uri;
    warn('a URI passed with --uri is saved in your shell history. Prefer the prompt.');
  } else if (process.env[URI_ENV_VAR]) {
    const envUri = process.env[URI_ENV_VAR];
    info(`${URI_ENV_VAR} is set: ${maskUri(envUri)}`);
    const answer = await ask(`  Connection string [use ${URI_ENV_VAR}]: `);
    uri = answer || envUri;
  } else {
    log(`  ${C.dim}Press Enter for your local database, or paste another connection string.${C.reset}`);
    const answer = await ask(`  Connection string [${DEFAULT_URI}]: `);
    uri = answer || DEFAULT_URI;
  }

  const parsed = parseMongoUri(uri);
  if (!parsed) fail('that does not look like a mongodb:// connection string');

  const local = isLocalUri(uri);
  info(`host:      ${parsed.hosts}`);
  info(`database:  ${parsed.db || '(none in the URI)'}`);
  if (parsed.user) info(`user:      ${parsed.user}`);

  if (!which('mongosh')) fail('mongosh not found on PATH');

  // --- what is about to happen -------------------------------------------
  for (const p of prepared) {
    const probe = probeDocument(uri, p.collection, p.doc);
    const label = prepared.length > 1 ? `${p.stem}: ` : '';
    if (probe.state === 'exists') {
      warn(`${label}a document already exists (${probe.detail}).`);
      info(`  it will write:  ${p.always.join(', ') || 'nothing'}`);
      info(`  it will keep:   ${p.onCreate.join(', ') || 'nothing'}`);
    } else if (probe.state === 'new') {
      ok(
        `${label}no document there yet. It will create one with: ` +
          `${p.always.concat(p.onCreate).join(', ')}`
      );
    } else {
      warn(`${label}could not check the database first: ${probe.detail || 'unknown reason'}`);
      info('  the output file decides for itself when it runs, so this is not fatal');
    }
  }

  // --- confirm -----------------------------------------------------------
  const what =
    prepared.length > 1 ? `all ${prepared.length} cities` : prepared[0].stem;

  if (!local) {
    log(`\n  ${C.yellow}This is not your local machine.${C.reset}`);
    log(`  ${C.dim}About to write ${what}.${C.reset}`);
    const typed = await ask(`  Type the host name to continue (${parsed.hosts}): `);
    if (typed !== parsed.hosts) fail('that did not match. Nothing was written.');
  } else if (flags.yes !== true) {
    const yn = await ask(
      `\n  Write ${what} to ${parsed.hosts}/${parsed.db || ''}? [y/N]: `
    );
    if (!/^y(es)?$/i.test(yn)) fail('cancelled. Nothing was written.');
  }

  closePrompt();

  // --- run ---------------------------------------------------------------
  // One city failing does not stop the rest. Everything is reported at the end.
  log(`\n${C.bold}6. Writing${C.reset}`);
  const results = [];

  for (const p of prepared) {
    if (prepared.length > 1) log(`\n  ${C.cyan}${p.stem}${C.reset}`);

    const run = spawnSync('mongosh', [uri, p.outPath], { stdio: 'inherit' });
    if (run.status !== 0) {
      warn(`${p.stem}: mongosh exited with code ${run.status}`);
      results.push({ stem: p.stem, ok: false, detail: `mongosh exit ${run.status}` });
      continue;
    }

    const evalScript =
      `const d = db.getCollection(${JSON.stringify(p.collection)}).findOne(` +
      `{slug: ${JSON.stringify(p.doc.slug)}, lang: ${JSON.stringify(p.doc.lang)}});` +
      `if (!d) { print('NOT FOUND'); quit(1); }` +
      `const imgs = (d.h2s || []).filter(h => h.image && h.image.px800).length;` +
      `print('_id=' + d._id + '  prismicId=' + d.prismicId + '  h2s=' + ` +
      `(d.h2s ? d.h2s.length : 0) + '  h2s with an image=' + imgs);`;

    const verify = spawnSync('mongosh', [uri, '--quiet', '--eval', evalScript], {
      encoding: 'utf8'
    });
    if (verify.status !== 0) {
      warn(`${p.stem}: written, but could not read it back`);
      results.push({ stem: p.stem, ok: false, detail: 'verification failed' });
      continue;
    }
    const detail = (verify.stdout || '').trim();
    ok(detail);
    results.push({ stem: p.stem, ok: true, detail });
  }

  // --- summary -----------------------------------------------------------
  if (results.length > 1) {
    log(`\n${C.bold}7. Summary${C.reset}`);
    results.forEach((r) =>
      r.ok
        ? ok(`${r.stem.padEnd(16)} ${r.detail}`)
        : warn(`${r.stem.padEnd(16)} ${r.detail}`)
    );
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    log(
      `\n${C.yellow}Finished with ${failed.length} problem(s):${C.reset} ` +
        `${failed.map((f) => f.stem).join(', ')}\n`
    );
    process.exit(1);
  }

  log(`\n${C.green}Done.${C.reset}\n`);
}

main().catch((e) => {
  closePrompt();
  fail(e.stack || e.message);
});
