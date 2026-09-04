// Minimal test registry + assertions. Zero dependencies on purpose: this suite
// has to be runnable with nothing but `node tests/run.js` on any machine, and
// the whole app already ships without a build step or a package.json.
'use strict';

const registry = [];

function test(name, fn) {
  registry.push({ name, fn });
}

function takeTests() {
  const out = registry.slice();
  registry.length = 0;
  return out;
}

class AssertionError extends Error {}

function fail(msg) {
  throw new AssertionError(msg);
}

function ok(value, msg) {
  if (!value) fail(msg || `expected a truthy value, got ${JSON.stringify(value)}`);
}

function notOk(value, msg) {
  if (value) fail(msg || `expected a falsy value, got ${JSON.stringify(value)}`);
}

function equal(actual, expected, msg) {
  if (actual !== expected) {
    fail(`${msg || 'values differ'}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

function deepEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    fail(`${msg || 'values differ'}\n      expected: ${b}\n      actual:   ${a}`);
  }
}

// Resolves to the promise's value, or rejects the test if it has not settled
// within `ms`. This is the assertion the sync-engine deadlock regression turns
// on: a wedged queue produces a promise that never settles at all, which
// without a deadline simply hangs the runner instead of failing it.
function settlesWithin(promise, ms, msg) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new AssertionError(msg || `promise did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// Runs fn() and returns the error it threw, or fails if it threw nothing.
function throws(fn, msg) {
  try {
    fn();
  } catch (err) {
    if (err instanceof AssertionError) throw err;
    return err;
  }
  return fail(msg || 'expected the call to throw, but it returned normally');
}

module.exports = { test, takeTests, AssertionError, fail, ok, notOk, equal, deepEqual, settlesWithin, throws };
