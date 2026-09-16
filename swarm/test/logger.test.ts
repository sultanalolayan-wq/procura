/**
 * test/logger.test.ts — redaction is a security control, so it is tested as one:
 * recursive through objects AND arrays, non-mutating, cycle-safe, and applied to
 * child bindings as well as per-call meta.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, nullLogger, redact, REDACT_PATTERN, type Level } from '../src/core/logger.js';
import { TestClock } from '../src/core/clock.js';

function capture(level: Level = 'debug') {
  const lines: Record<string, unknown>[] = [];
  const clock = new TestClock(1000);
  const logger = createLogger({
    level,
    clock,
    write: (l) => {
      lines.push(JSON.parse(l) as Record<string, unknown>);
    },
  });
  return { lines, logger, clock };
}

test('emits one JSON line per call with ts/level/msg', () => {
  const { lines, logger } = capture();
  logger.info('hello', { a: 1 });
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], { ts: 1000, level: 'info', msg: 'hello', meta: { a: 1 } });
});

test('level filtering drops lower-ranked records', () => {
  const { lines, logger } = capture('warn');
  logger.debug('d');
  logger.info('i');
  logger.warn('w');
  logger.error('e');
  assert.deepEqual(lines.map((l) => l['level']), ['warn', 'error']);
});

test('redacts sensitive keys recursively through objects and arrays', () => {
  const { lines, logger } = capture();
  logger.info('secretive', {
    apiToken: 'abc',
    nested: { password: 'p', deeper: { AUTHORIZATION: 'Bearer x', ok: 1 } },
    list: [{ secretSauce: 's' }, { fine: 'yes' }, [{ privateKey: 'k' }]],
  });
  const meta = lines[0]?.['meta'] as Record<string, unknown>;
  assert.equal(meta['apiToken'], '[REDACTED]');
  const nested = meta['nested'] as Record<string, unknown>;
  assert.equal(nested['password'], '[REDACTED]');
  const deeper = nested['deeper'] as Record<string, unknown>;
  assert.equal(deeper['AUTHORIZATION'], '[REDACTED]');
  assert.equal(deeper['ok'], 1);
  const list = meta['list'] as unknown[];
  assert.equal((list[0] as Record<string, unknown>)['secretSauce'], '[REDACTED]');
  assert.equal((list[1] as Record<string, unknown>)['fine'], 'yes');
  const innerArr = list[2] as unknown[];
  assert.equal((innerArr[0] as Record<string, unknown>)['privateKey'], '[REDACTED]');
});

test('redaction NEVER mutates the caller object', () => {
  const { logger } = capture();
  const original = { token: 'sensitive', nested: { secret: 'shh' }, arr: [{ apikey: 'v' }] };
  logger.info('x', original);
  assert.equal(original.token, 'sensitive');
  assert.equal(original.nested.secret, 'shh');
  assert.equal(original.arr[0]?.apikey, 'v');
});

test('cycles are rendered as [CIRCULAR] rather than overflowing the stack', () => {
  const { lines, logger } = capture();
  const a: Record<string, unknown> = { name: 'a' };
  const b: Record<string, unknown> = { name: 'b', a };
  a['b'] = b;
  logger.info('cyclic', { a });
  const meta = lines[0]?.['meta'] as Record<string, unknown>;
  const ao = meta['a'] as Record<string, unknown>;
  const bo = ao['b'] as Record<string, unknown>;
  assert.equal(bo['a'], '[CIRCULAR]');
  // Self-reference at the root of meta.
  const self: Record<string, unknown> = {};
  self['self'] = self;
  logger.info('selfref', self);
  assert.equal((lines[1]?.['meta'] as Record<string, unknown>)['self'], '[CIRCULAR]');
});

test('array cycles are handled too', () => {
  const arr: unknown[] = [1];
  arr.push(arr);
  const out = redact(arr) as unknown[];
  assert.equal(out[0], 1);
  assert.equal(out[1], '[CIRCULAR]');
});

test('child() merges bindings, redacts them, and does not affect the parent', () => {
  const { lines, logger } = capture();
  const child = logger.child({ agentId: 'scout-1', apiKey: 'leak-me' });
  child.info('bound');
  const l0 = lines[0] as Record<string, unknown>;
  assert.equal(l0['agentId'], 'scout-1');
  assert.equal(l0['apiKey'], '[REDACTED]');
  logger.info('unbound');
  assert.equal(lines[1]?.['agentId'], undefined);

  const grand = child.child({ tick: 4 });
  grand.info('deep');
  assert.equal(lines[2]?.['agentId'], 'scout-1');
  assert.equal(lines[2]?.['tick'], 4);
});

test('REDACT_PATTERN covers the documented key families', () => {
  for (const k of ['token', 'Secret', 'API_KEY', 'password', 'Authorization', 'refreshToken']) {
    assert.ok(REDACT_PATTERN.test(k), `${k} should be redacted`);
  }
  for (const k of ['amount', 'agentId', 'tick']) {
    assert.ok(!REDACT_PATTERN.test(k), `${k} should NOT be redacted`);
  }
});

test('redact flattens Map/Set/Date and stringifies bigint', () => {
  const out = redact({
    m: new Map<string, unknown>([
      ['token', 'x'],
      ['n', 1],
    ]),
    s: new Set([1, 2]),
    d: new Date(0),
    big: 10n,
  }) as Record<string, unknown>;
  assert.deepEqual(out['m'], { token: '[REDACTED]', n: 1 });
  assert.deepEqual(out['s'], [1, 2]);
  assert.equal(out['d'], '1970-01-01T00:00:00.000Z');
  assert.equal(out['big'], '10');
});

test('nullLogger swallows everything without throwing', () => {
  assert.doesNotThrow(() => {
    nullLogger.child({ a: 1 }).error('boom', { token: 'x' });
  });
});
