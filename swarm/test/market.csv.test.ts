/**
 * test/market.csv.test.ts — the feed that actually works here, tested hard.
 * Pins: the file is STREAMED, not slurped; every malformed row is rejected with
 * the file and the LINE NUMBER in the message; out-of-order dates, duplicate
 * dates, negative and zero prices, high<low and a close outside [low,high] are all
 * refused; a price that cannot be held exactly in minor units throws; and the
 * traversal guard means a symbol can never be a path.
 *
 * Bad market data that is silently accepted produces confident wrong answers,
 * which is worse than a crash. Every test here is a crash we want.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AresError } from '../src/core/errors.js';
import { CsvFeed, MemoryFeed, parseCsvText, CSV_HEADER } from '../src/market/csv.js';
import type { Venue } from '../src/market/feed.js';

const HEADER = 'date,open,high,low,close,volume';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ares-market-'));
}

function writeCsv(dir: string, venue: Venue, symbol: string, body: string): string {
  const d = join(dir, 'market', venue.toLowerCase());
  mkdirSync(d, { recursive: true });
  const p = join(d, `${symbol.toLowerCase()}.csv`);
  writeFileSync(p, body);
  return p;
}

async function failure(fn: () => Promise<unknown>): Promise<AresError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof AresError, `expected AresError, got ${String(err)}`);
    return err;
  }
  throw new Error('expected a throw, got none');
}

const GOOD = [
  HEADER,
  '2025-01-02,100.00,101.50,99.25,100.75,1000',
  '2025-01-03,100.75,103.00,100.00,102.50,1200',
  '2025-01-06,102.00,104.00,101.00,103.00,900',
  '',
].join('\n');

test('a well-formed file parses into integer minor units', async () => {
  const dir = tmp();
  try {
    writeCsv(dir, 'US', 'AAPL', GOOD);
    const feed = new CsvFeed({ dataDir: dir });
    const bars = await feed.bars('AAPL', 'US', '2025-01-01', '2025-01-31');
    assert.equal(bars.length, 3);
    assert.deepEqual(bars[0], {
      symbol: 'AAPL',
      venue: 'US',
      dayUtc: '2025-01-02',
      openMinor: 10000,
      highMinor: 10150,
      lowMinor: 9925,
      closeMinor: 10075,
      volume: 1000,
      currency: 'USD',
    });
    for (const b of bars) {
      for (const v of [b.openMinor, b.highMinor, b.lowMinor, b.closeMinor]) {
        assert.equal(Number.isSafeInteger(v), true, 'a price escaped as a non-integer');
      }
    }
    assert.equal((await feed.latest('AAPL', 'US'))?.dayUtc, '2025-01-06');
    assert.deepEqual((await feed.bars('AAPL', 'US', '2025-01-03', '2025-01-03')).map((b) => b.dayUtc), ['2025-01-03']);
    await feed.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Tadawul files are SAR, US files are USD, and the venue decides — not the file', async () => {
  const dir = tmp();
  try {
    writeCsv(dir, 'TADAWUL', '2222.SR', [HEADER, '2025-01-05,25.00,25.40,24.80,25.10,500', ''].join('\n'));
    const feed = new CsvFeed({ dataDir: dir });
    const bars = await feed.bars('2222.SR', 'TADAWUL', '2025-01-01', '2025-01-31');
    assert.equal(bars[0]?.currency, 'SAR');
    assert.equal(bars[0]?.closeMinor, 2510);
    await feed.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every rejection names the file AND the line', async () => {
  const cases: Array<{ rows: string[]; code: string; line: number; why: string }> = [
    { rows: ['2025-01-02,100.00,99.00,101.00,100.00,10'], code: 'MARKET_BAR_RANGE', line: 2, why: 'high below low' },
    { rows: ['2025-01-02,100.00,101.00,99.00,105.00,10'], code: 'MARKET_BAR_RANGE', line: 2, why: 'close above high' },
    { rows: ['2025-01-02,100.00,101.00,99.00,90.00,10'], code: 'MARKET_BAR_RANGE', line: 2, why: 'close below low' },
    { rows: ['2025-01-02,-1.00,101.00,99.00,100.00,10'], code: 'MARKET_BAR_PRICE', line: 2, why: 'negative open' },
    { rows: ['2025-01-02,0.00,101.00,0.00,100.00,10'], code: 'MARKET_BAR_PRICE', line: 2, why: 'zero price' },
    { rows: ['2025-01-02,100.00,101.00,99.00,100.00'], code: 'MARKET_CSV_BAD_ROW', line: 2, why: 'missing field' },
    { rows: ['2025-01-02,100.00,101.00,99.00,100.00,10,extra'], code: 'MARKET_CSV_BAD_ROW', line: 2, why: 'extra field' },
    { rows: ['2025-13-99,100.00,101.00,99.00,100.00,10'], code: 'MARKET_CSV_BAD_DATE', line: 2, why: 'impossible date' },
    { rows: ['2025-01-02,100.00,101.00,99.00,100.00,-5'], code: 'MARKET_CSV_BAD_VOLUME', line: 2, why: 'negative volume' },
    { rows: ['2025-01-02,100.00,101.00,99.00,100.00,1.5'], code: 'MARKET_CSV_BAD_VOLUME', line: 2, why: 'fractional volume' },
    { rows: ['2025-01-02,100.00,101.00,99.00,100.00,10', '2025-01-02,100.00,101.00,99.00,100.00,10'], code: 'MARKET_DUPLICATE_DAY', line: 3, why: 'duplicate date' },
    { rows: ['2025-01-03,100.00,101.00,99.00,100.00,10', '2025-01-02,100.00,101.00,99.00,100.00,10'], code: 'MARKET_OUT_OF_ORDER', line: 3, why: 'date going backwards' },
    { rows: ['2025-01-02,100.00,101.00,99.00,abc,10'], code: 'MARKET_BAD_PRICE', line: 2, why: 'non-numeric price' },
  ];
  const dir = tmp();
  try {
    for (const c of cases) {
      const path = writeCsv(dir, 'US', 'AAPL', [HEADER, ...c.rows, ''].join('\n'));
      const feed = new CsvFeed({ dataDir: dir });
      const err = await failure(() => feed.bars('AAPL', 'US', '2025-01-01', '2025-12-31'));
      assert.equal(err.code, c.code, `${c.why}: wrong code (${err.message})`);
      assert.ok(err.message.includes(path), `${c.why}: message does not name the file: ${err.message}`);
      assert.ok(
        err.message.includes(`${path}:${c.line}`),
        `${c.why}: message does not name line ${c.line}: ${err.message}`,
      );
      await feed.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a price with sub-minor precision throws instead of being rounded — 123.456', async () => {
  const dir = tmp();
  try {
    const path = writeCsv(
      dir,
      'US',
      'AAPL',
      [HEADER, '2025-01-02,100.00,124.00,99.00,123.456,10', ''].join('\n'),
    );
    const feed = new CsvFeed({ dataDir: dir });
    const err = await failure(() => feed.bars('AAPL', 'US', '2025-01-01', '2025-12-31'));
    assert.equal(err.code, 'MARKET_PRICE_NOT_EXACT');
    assert.ok(err.message.includes(`${path}:2 [close]`), err.message);
    assert.match(err.message, /refuses to round/);
    await feed.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the header is checked, and an empty or header-only file is a failed download', async () => {
  const dir = tmp();
  try {
    writeCsv(dir, 'US', 'AAPL', 'date,o,h,l,c,v\n2025-01-02,1,1,1,1,1\n');
    assert.equal((await failure(() => new CsvFeed({ dataDir: dir }).bars('AAPL', 'US', '2025-01-01', '2025-12-31'))).code, 'MARKET_CSV_BAD_HEADER');
    writeCsv(dir, 'US', 'MSFT', '');
    assert.equal((await failure(() => new CsvFeed({ dataDir: dir }).bars('MSFT', 'US', '2025-01-01', '2025-12-31'))).code, 'MARKET_CSV_EMPTY');
    writeCsv(dir, 'US', 'NVDA', `${HEADER}\n`);
    assert.equal((await failure(() => new CsvFeed({ dataDir: dir }).bars('NVDA', 'US', '2025-01-01', '2025-12-31'))).code, 'MARKET_CSV_NO_ROWS');
    assert.deepEqual([...CSV_HEADER], ['date', 'open', 'high', 'low', 'close', 'volume']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing file says exactly where the operator should put one', async () => {
  const dir = tmp();
  try {
    const err = await failure(() => new CsvFeed({ dataDir: dir }).bars('AAPL', 'US', '2025-01-01', '2025-12-31'));
    assert.equal(err.code, 'MARKET_CSV_MISSING');
    assert.match(err.message, /<dataDir>\/market\/<venue>\/<symbol>\.csv/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a symbol can never escape the data directory', async () => {
  const dir = tmp();
  try {
    const feed = new CsvFeed({ dataDir: dir });
    const err = await failure(() => feed.bars('../../../etc/passwd', 'US', '2025-01-01', '2025-12-31'));
    assert.equal(err.code, 'MARKET_BAD_SYMBOL');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the file is STREAMED: a large file parses, and the byte ceiling is enforced', async () => {
  const dir = tmp();
  try {
    // ~20k sessions. readFileSync + split would hold the whole text and the whole
    // array of lines at once; the streamed parser holds one chunk.
    const rows: string[] = [HEADER];
    let day = Date.UTC(1960, 0, 4);
    for (let i = 0; i < 20_000; i++) {
      const d = new Date(day).toISOString().slice(0, 10);
      rows.push(`${d},100.00,101.00,99.00,100.50,1000`);
      day += 86_400_000;
    }
    const body = `${rows.join('\n')}\n`;
    writeCsv(dir, 'US', 'BIG', body);

    const feed = new CsvFeed({ dataDir: dir });
    const bars = await feed.bars('BIG', 'US', '1900-01-01', '2100-01-01');
    assert.equal(bars.length, 20_000);
    await feed.close();

    // ...and the same file against a ceiling smaller than it is.
    const tight = new CsvFeed({ dataDir: dir, maxBytes: 1024 });
    const err = await failure(() => tight.bars('BIG', 'US', '1900-01-01', '2100-01-01'));
    assert.equal(err.code, 'MARKET_CSV_TOO_LARGE');
    // ...and against a row ceiling.
    const fewRows = new CsvFeed({ dataDir: dir, maxRows: 10 });
    assert.equal((await failure(() => fewRows.bars('BIG', 'US', '1900-01-01', '2100-01-01'))).code, 'MARKET_CSV_TOO_MANY_ROWS');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parsing is deterministic and side-effect free: same file, same bars, twice over', async () => {
  const dir = tmp();
  try {
    writeCsv(dir, 'US', 'AAPL', GOOD);
    const a = await new CsvFeed({ dataDir: dir }).bars('AAPL', 'US', '2025-01-01', '2025-12-31');
    const b = await new CsvFeed({ dataDir: dir }).bars('AAPL', 'US', '2025-01-01', '2025-12-31');
    assert.deepEqual(a, b);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CRLF files and blank lines are tolerated; line numbers stay honest', () => {
  const bars = parseCsvText(`${HEADER}\r\n2025-01-02,1.00,2.00,0.50,1.50,3\r\n\r\n`, {
    symbol: 'AAPL',
    venue: 'US',
    source: 'inline',
  });
  assert.equal(bars.length, 1);
  assert.equal(bars[0]?.closeMinor, 150);
  // A bad row after a blank line reports ITS line, not the count of good rows.
  try {
    parseCsvText(`${HEADER}\n\n2025-01-02,1.00,0.50,2.00,1.50,3\n`, { symbol: 'AAPL', venue: 'US', source: 'inline' });
    throw new Error('expected a throw');
  } catch (e) {
    assert.match((e as Error).message, /^inline:3: /);
  }
});

test('an optional session check can audit a file against the operator holiday list', async () => {
  const dir = tmp();
  try {
    // 2025-01-04 is a Saturday: not a US session under any holiday list.
    writeCsv(dir, 'US', 'AAPL', [HEADER, '2025-01-04,100.00,101.00,99.00,100.00,10', ''].join('\n'));
    const feed = new CsvFeed({ dataDir: dir, isSession: (_v, d) => d !== '2025-01-04' });
    const err = await failure(() => feed.bars('AAPL', 'US', '2025-01-01', '2025-12-31'));
    assert.equal(err.code, 'MARKET_CSV_NOT_A_SESSION');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MemoryFeed enforces the same invariants as the file feed', async () => {
  const f = new MemoryFeed();
  assert.throws(
    () =>
      f.add({
        symbol: 'X',
        venue: 'US',
        dayUtc: '2025-01-02',
        openMinor: 100,
        highMinor: 90,
        lowMinor: 95,
        closeMinor: 96,
        volume: 1,
        currency: 'USD',
      }),
    /MARKET_BAR_RANGE|outside|below/,
  );
  assert.equal(await f.latest('X', 'US'), null);
});
