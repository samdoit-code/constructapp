// Pulls named declarations OUT of the real index.html and evaluates them in a
// vm with stubbed dependencies.
//
// Why not load the whole file: index.html's IIFE touches the DOM at top level
// ($('#entryForm'), addEventListener on real nodes), so running it needs a DOM
// implementation — a dependency this project deliberately does not have. Why
// not copy the functions into the test instead: a copy stops being the shipped
// code the moment anyone edits one of them, which is exactly when a regression
// test has to still be looking at the real thing.
//
// Extraction relies on one property that holds throughout the file: every
// declaration inside the IIFE is indented exactly two spaces, and a function
// closes with "  }" alone on its line. If someone reindents or renames a
// function under test, extraction fails loudly with a clear message rather than
// silently testing nothing.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Overridable so the suite can be pointed at a previous commit's file — the
// negative control that proves a regression test actually catches its bug.
// See tests/README.md.
const APP_PATH = process.env.CMOREIRA_APP || path.join(__dirname, '..', '..', 'index.html');
let cachedSource = null;

function appSource() {
  if (cachedSource === null) cachedSource = fs.readFileSync(APP_PATH, 'utf8');
  return cachedSource;
}

// The source of `function NAME(...) { ... }` (async or not), from the `function`
// keyword to its closing brace.
function extractFunction(name) {
  const src = appSource();
  const re = new RegExp('\\n  (?:async )?function ' + name.replace(/[$]/g, '\\$') + '\\s*\\(');
  const m = src.match(re);
  if (!m) throw new Error(`app-source: no top-level function "${name}" found in index.html`);
  const start = m.index + 1;
  const end = src.indexOf('\n  }\n', start);
  if (end === -1) throw new Error(`app-source: could not find the end of "${name}"`);
  return src.slice(start, end + '\n  }'.length);
}

// The source of a single-line `const NAME = ...;` / `let NAME = ...;`.
function extractDeclaration(name) {
  const src = appSource();
  const re = new RegExp('\\n  (?:const|let|var) ' + name.replace(/[$]/g, '\\$') + ' = [^\\n]*', 'm');
  const m = src.match(re);
  if (!m) throw new Error(`app-source: no top-level declaration "${name}" found in index.html`);
  return m[0].trim();
}

/**
 * Builds a vm context holding the real extracted sources plus stubs.
 *
 * @param {object} spec
 *   functions    [names]  top-level functions to extract verbatim
 *   declarations [names]  top-level single-line const/let to extract verbatim
 *   vars         {name: value}  mutable module-scope state the extracted code
 *                               assigns to (declared as `var` so assignment
 *                               works and the test can read it back)
 *   stubs        {name: value}  dependencies the extracted code calls
 */
function buildContext(spec) {
  const ctx = Object.assign({
    console,
    setTimeout,
    clearTimeout,
    Promise,
    JSON,
    Math,
    Date,
    Set,
    Map,
    String,
    Number,
    Object,
    Array,
    Error,
    TypeError,
    Uint8Array,
    TextDecoder,
    atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
  }, spec.stubs || {});
  vm.createContext(ctx);

  const prelude = Object.keys(spec.vars || {})
    .map((k) => `var ${k} = __vars__.${k};`)
    .join('\n');
  ctx.__vars__ = spec.vars || {};

  const parts = [prelude]
    .concat((spec.declarations || []).map(extractDeclaration))
    .concat((spec.functions || []).map(extractFunction));

  vm.runInContext(parts.join('\n\n'), ctx, { filename: 'index.html(extracted)' });
  delete ctx.__vars__;
  return ctx;
}

// Whole-file assertions, for invariants that are about the source rather than
// about a single function's behaviour.
function appSourceText() {
  return appSource();
}

module.exports = { extractFunction, extractDeclaration, buildContext, appSourceText };
