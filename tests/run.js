#!/usr/bin/env node
// Regression suite. Run with:  node tests/run.js  (optionally: node tests/run.js sync)
//
// No dependencies, no build step, no package.json — the same constraint the app
// itself ships under. Every test drives the REAL backend/Code.js or real
// functions extracted from the REAL index.html; nothing here re-implements
// behaviour it then asserts on.
'use strict';

const fs = require('fs');
const path = require('path');
const { takeTests, AssertionError } = require('./helpers/harness');

const filter = process.argv[2] || '';
const files = fs.readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js'))
  .filter((f) => !filter || f.indexOf(filter) > -1)
  .sort();

if (!files.length) {
  console.error(filter ? `No test files match "${filter}".` : 'No test files found.');
  process.exit(1);
}

(async () => {
  let passed = 0;
  const failures = [];
  const started = Date.now();

  for (const file of files) {
    // A test file can legitimately fail to LOAD — most often when the suite is
    // pointed at an older commit (the negative control) and a function it
    // extracts from index.html does not exist there yet. Report it as a failed
    // file instead of taking the whole run down, so the rest still reports.
    try {
      require(path.join(__dirname, file));
    } catch (err) {
      takeTests();
      failures.push({ file, name: '(failed to load)', err });
      console.log(`\n\x1b[1m${file}\x1b[0m`);
      console.log(`  \x1b[31m✗\x1b[0m could not load this file`);
      console.log(`      ${String(err && err.message).split('\n').join('\n      ')}`);
      continue;
    }
    const tests = takeTests();
    console.log(`\n\x1b[1m${file}\x1b[0m  (${tests.length})`);
    for (const t of tests) {
      try {
        await t.fn();
        passed++;
        console.log(`  \x1b[32m✓\x1b[0m ${t.name}`);
      } catch (err) {
        failures.push({ file, name: t.name, err });
        console.log(`  \x1b[31m✗\x1b[0m ${t.name}`);
        console.log(`      ${String(err && err.message).split('\n').join('\n      ')}`);
        if (!(err instanceof AssertionError) && err && err.stack) {
          console.log(`      \x1b[2m${err.stack.split('\n').slice(1, 4).join('\n      ')}\x1b[0m`);
        }
      }
    }
  }

  const ms = Date.now() - started;
  console.log('');
  if (failures.length) {
    console.log(`\x1b[31m${failures.length} failed\x1b[0m, ${passed} passed  (${ms}ms)`);
    process.exit(1);
  }
  console.log(`\x1b[32m${passed} passed\x1b[0m  (${ms}ms)`);
})().catch((err) => {
  console.error('\nThe test runner itself failed:\n', err);
  process.exit(1);
});
