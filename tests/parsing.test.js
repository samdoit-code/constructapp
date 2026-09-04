// F3 — Brazilian monetary input parsing.
//
// This is the one bug in the audit that could write a WRONG NUMBER into the
// books with no error and no retry: "1.500" parsed as 1.5, so R$ 1.500,00 was
// recorded as R$ 1,50. Runs the real parseDecimalBR extracted from index.html.
'use strict';

const { test, equal, ok } = require('./helpers/harness');
const { buildContext } = require('./helpers/app-source');

const app = buildContext({
  declarations: ['BR_GROUPED_THOUSANDS'],
  functions: ['splitAtDecimalSep_', 'parseDecimalBR'],
});
const parse = app.parseDecimalBR;

test('F3: a Brazilian grouped-thousands amount is not read as a decimal', () => {
  // The regression. Each of these used to come back a thousandfold too small.
  equal(parse('1.500'), 1500, '"1.500" is R$ 1.500,00 to a Brazilian');
  equal(parse('12.000'), 12000);
  equal(parse('1.500.000'), 1500000);
  equal(parse('999.000'), 999000);
});

test('F3: the decimal-comma forms still parse (they always did)', () => {
  equal(parse('150,50'), 150.5);
  equal(parse('1.500,50'), 1500.5);
  equal(parse('0,01'), 0.01);
  equal(parse('1500,00'), 1500);
});

test('F3: dot-as-decimal-point still parses — the fix is deliberately narrow', () => {
  // None of these has the grouped-thousands shape, so none changes meaning.
  equal(parse('1.5'), 1.5, 'one digit after the dot is a decimal, not grouping');
  equal(parse('1.50'), 1.5, 'two digits after the dot is a decimal');
  equal(parse('1500.50'), 1500.5, 'four leading digits cannot be a thousands group');
  equal(parse('1234.567'), 1234.567);
  equal(parse('0.5'), 0.5);
});

test('F3: US-style grouping with an explicit decimal point still works', () => {
  equal(parse('1,500.50'), 1500.5, 'last separator wins: the dot is the decimal here');
  equal(parse('12,345.67'), 12345.67);
});

test('F3: plain integers and typed noise', () => {
  equal(parse('1500'), 1500);
  equal(parse('0'), 0);
  equal(parse(' 1500 '), 1500, 'surrounding whitespace');
  equal(parse('R$ 1.500,50'), 1500.5, 'a pasted currency string');
  equal(parse('r$1.500'), 1500);
  equal(parse('1 500,50'), 1500.5, 'a space used as the thousands separator');
});

test('F3: a repeated separator degrades to something sane, never NaN', () => {
  // "1,500,50" is a typo, not a convention — but silently returning NaN made
  // the entry form claim a filled-in field was empty.
  equal(parse('1,500,50'), 1500.5);
});

test('F3: genuinely empty or non-numeric input is still NaN', () => {
  ok(Number.isNaN(parse('')), 'empty string');
  ok(Number.isNaN(parse('   ')), 'whitespace only');
  ok(Number.isNaN(parse(null)), 'null');
  ok(Number.isNaN(parse(undefined)), 'undefined');
  ok(Number.isNaN(parse('abc')), 'letters');
  ok(Number.isNaN(parse('R$')), 'a currency symbol with no number');
});

test('F3: negative amounts keep their sign', () => {
  equal(parse('-1.500'), -1500);
  equal(parse('-150,50'), -150.5);
});

test('F3: quantities go through the same parser and must not be corrupted', () => {
  // parseDecimalBR is also used for the qtd field, where grouped thousands are
  // just as legitimate ("1.500 tijolos").
  equal(parse('1.500'), 1500);
  equal(parse('2,5'), 2.5);
});
