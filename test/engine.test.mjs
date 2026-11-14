import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, thresholdFromVolume, personaVote } from '../public/engine.js';

const R = (m, b, c, critical = 0.01, highStakes = 0.1) => ({
  votes: { melchior: { p: m }, balthasar: { p: b }, casper: { p: c } },
  globals: { is_critical: critical, high_stakes: highStakes },
});

test('volume maps to threshold', () => {
  assert.equal(thresholdFromVolume(50), 0.5);
  assert.equal(thresholdFromVolume(1), 0.99);
  assert.equal(thresholdFromVolume(65535), 0);
});

test('hold band is per persona', () => {
  assert.equal(personaVote(0.53, 'melchior', 0.5), 'hold');
  assert.equal(personaVote(0.56, 'melchior', 0.5), 'resolve');
  assert.equal(personaVote(0.60, 'balthasar', 0.5), 'hold');
  assert.equal(personaVote(0.55, 'casper', 0.5), 'resolve');
});

test('c02 walking: 2:1 majority approves', () => {
  const d = decide(R(0.94, 0.96, 0.30));
  assert.equal(d.final, 'resolve');
  assert.equal(d.rule, 'majority');
  assert.deepEqual(d.votes, { melchior: 'resolve', balthasar: 'resolve', casper: 'reject' });
});

test('e07 special agenda: CASPER vetoes what the majority approves', () => {
  const d = decide(R(0.94, 0.79, 0.39, 0.94));
  assert.equal(d.critical, true);
  assert.equal(d.rule, 'unanimous');
  assert.equal(d.final, 'reject');
  assert.deepEqual(d.vetoBy, ['casper']);
});

test('priority A forces majority even for a special agenda', () => {
  assert.equal(decide(R(0.94, 0.79, 0.39, 0.94), { priority: 'A' }).final, 'resolve');
});

test('priority AAA forces veto on an ordinary case', () => {
  assert.equal(decide(R(0.94, 0.96, 0.30), { priority: 'AAA' }).final, 'reject');
});

test('two holds give a held verdict', () => {
  assert.equal(decide(R(0.52, 0.55, 0.10)).final, 'hold');
});

test('volume 65535 forces approval', () => {
  assert.equal(decide(R(0.01, 0.02, 0.03), { volume: 65535 }).final, 'resolve');
});

test('high stakes flag', () => {
  assert.equal(decide(R(0.5, 0.5, 0.5, 0.1, 0.85)).highStakes, true);
});
