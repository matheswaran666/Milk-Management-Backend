/**
 * Unit tests for billStructure utilities.
 * Run with:  node scripts/test-bill-structure.js
 *
 * Uses Node's built-in `assert` so no extra dev dependency is needed.
 */
const assert = require('assert');
const {
  normaliseFields,
  suggestFieldsFromOcr,
  extractRecordsWithStructure,
  extractRecordsFromOcrData,
  extractDateFromLine,
  stripDates,
  extractNumbersFromLine,
  detectShift,
  detectMilkType,
  clusterWordsIntoRows,
  findHeaderLine,
} = require('../src/utils/billStructure');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`      ${err.message}`);
    failed += 1;
  }
}

function describe(group, fn) {
  console.log(`\n${group}`);
  fn();
}

// ────────────────────────────────────────────────────────────────
describe('extractDateFromLine', () => {
  test('parses dd-mm-yyyy', () => {
    assert.strictEqual(extractDateFromLine('01-04-2024 xyz'), '2024-04-01');
  });
  test('parses dd/mm/yy', () => {
    assert.strictEqual(extractDateFromLine('01/04/24 xyz'), '2024-04-01');
  });
  test('parses dd.mm.yyyy', () => {
    assert.strictEqual(extractDateFromLine('01.04.2024'), '2024-04-01');
  });
  test('parses yyyy-mm-dd', () => {
    assert.strictEqual(extractDateFromLine('2024-04-01 row'), '2024-04-01');
  });
  test('parses dd Mon yyyy', () => {
    assert.strictEqual(extractDateFromLine('01 Apr 2024'), '2024-04-01');
  });
  test('parses dd-Mon-yy', () => {
    assert.strictEqual(extractDateFromLine('1-Apr-24'), '2024-04-01');
  });
  test('parses full month names', () => {
    assert.strictEqual(extractDateFromLine('1 April 2024'), '2024-04-01');
  });
  test('rejects invalid date 31-02-2024', () => {
    assert.strictEqual(extractDateFromLine('31-02-2024'), null);
  });
  test('returns null for no match', () => {
    assert.strictEqual(extractDateFromLine('no date here'), null);
  });
});

describe('stripDates', () => {
  test('strips multiple formats', () => {
    const out = stripDates('01-04-2024 some 2024-04-01 row 1 Apr 24');
    assert.ok(!/\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/.test(out), `unexpected leftover: ${out}`);
    assert.ok(!/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(out), `unexpected leftover: ${out}`);
    assert.ok(!/Apr/.test(out), `unexpected month leftover: ${out}`);
  });
});

describe('extractNumbersFromLine', () => {
  test('does NOT turn timestamps into numbers', () => {
    const nums = extractNumbersFromLine('06:30 12.5 4.0 250');
    assert.deepStrictEqual(nums, [12.5, 4.0, 250]);
  });
  test('handles European decimal commas', () => {
    const nums = extractNumbersFromLine('12,5 4,0 250');
    assert.deepStrictEqual(nums, [12.5, 4.0, 250]);
  });
  test('does not corrupt negative numbers', () => {
    const nums = extractNumbersFromLine('Adj -10 amount 200');
    assert.deepStrictEqual(nums, [-10, 200]);
  });
  test('does not turn dashes into decimal points', () => {
    // "Item-1 5.5" should yield 1 and 5.5, NOT "Item.1 5.5"
    const nums = extractNumbersFromLine('Item-1 5.5');
    assert.deepStrictEqual(nums, [-1, 5.5]); // -1 because of the leading "-"
  });
});

describe('detectShift / detectMilkType — substring guards', () => {
  test('does NOT match "am" inside "amount"', () => {
    assert.strictEqual(detectShift('Total amount 250'), null);
  });
  test('matches " AM " standalone', () => {
    assert.strictEqual(detectShift('01-04-2024 AM 12.5 250'), 'AM');
  });
  test('matches "morning"', () => {
    assert.strictEqual(detectShift('morning shift'), 'AM');
  });
  test('does NOT match "cm" inside "comment"', () => {
    assert.strictEqual(detectMilkType('comment 12.5'), null);
  });
  test('matches " BM " standalone', () => {
    assert.strictEqual(detectMilkType('01-04-2024 BM 12.5'), 'BM');
  });
});

describe('findHeaderLine — full-document scoring', () => {
  test('finds header even when buried below logo/address', () => {
    const lines = [
      'ABC Dairy Pvt Ltd',
      '123 Some Address, Pune',
      'Contact: 9999999999',
      'Date  Shift  Qty   Fat   SNF   Rate   Amount',
      '01-04-24 AM 12.5 4.0 8.5 30 375',
    ];
    const h = findHeaderLine(lines);
    assert.ok(h, 'expected to find a header');
    assert.strictEqual(h.idx, 3);
  });
  test('returns null when no clear header (only one alias hit)', () => {
    const lines = ['Random text', 'amount due soon'];
    const h = findHeaderLine(lines);
    assert.strictEqual(h, null);
  });
});

describe('suggestFieldsFromOcr', () => {
  test('detects fields from a real-looking header line', () => {
    const text = [
      'ABC Dairy',
      'Date Shift Qty Fat SNF Rate Amount',
      '01-04-24 AM 12.5 4.0 8.5 30 375',
    ].join('\n');
    const fields = suggestFieldsFromOcr(text);
    const keys = fields.map((f) => f.key);
    assert.ok(keys.includes('date'), 'missing date');
    assert.ok(keys.includes('shift'), 'missing shift');
    assert.ok(keys.includes('quantity_liters'), 'missing quantity_liters');
    assert.ok(keys.includes('fat_percentage'), 'missing fat_percentage');
    assert.ok(keys.includes('snf_percentage'), 'missing snf_percentage');
    assert.ok(keys.includes('rate_per_liter'), 'missing rate_per_liter');
    assert.ok(keys.includes('total_amount'), 'missing total_amount');
  });
  test('returns empty array on empty input', () => {
    assert.deepStrictEqual(suggestFieldsFromOcr(''), []);
    assert.deepStrictEqual(suggestFieldsFromOcr(null), []);
  });
});

describe('normaliseFields', () => {
  test('rejects empty input', () => {
    assert.throws(() => normaliseFields([]), /at least one field/);
  });
  test('rejects unknown keys', () => {
    assert.throws(() => normaliseFields([{ key: 'banana' }]), /Unknown field/);
  });
  test('rejects duplicates', () => {
    assert.throws(
      () => normaliseFields([{ key: 'date' }, { key: 'date' }]),
      /Duplicate field/
    );
  });
  test('merges aliases with canonical defaults', () => {
    const out = normaliseFields([{ key: 'fat_percentage', aliases: ['butterfat'] }]);
    assert.ok(out[0].aliases.includes('fat'), 'should keep canonical "fat"');
    assert.ok(out[0].aliases.includes('butterfat'), 'should add custom alias');
  });
  test('re-indexes order', () => {
    const out = normaliseFields([
      { key: 'total_amount', order: 5 },
      { key: 'date',         order: 1 },
    ]);
    assert.deepStrictEqual(out.map((f) => f.key), ['date', 'total_amount']);
    assert.deepStrictEqual(out.map((f) => f.order), [0, 1]);
  });
});

describe('extractRecordsWithStructure (positional fallback)', () => {
  const fields = normaliseFields([
    { key: 'date',            order: 0 },
    { key: 'shift',           order: 1 },
    { key: 'quantity_liters', order: 2 },
    { key: 'fat_percentage',  order: 3 },
    { key: 'rate_per_liter',  order: 4 },
    { key: 'total_amount',    order: 5 },
  ]);

  test('extracts a clean row', () => {
    const text = '01-04-2024 AM 12.5 4.0 30 375';
    const recs = extractRecordsWithStructure(text, fields);
    assert.strictEqual(recs.length, 1);
    assert.deepStrictEqual(recs[0], {
      date: '2024-04-01',
      shift: 'AM',
      quantity_liters: 12.5,
      fat_percentage: 4.0,
      rate_per_liter: 30,
      total_amount: 375,
    });
  });

  test('skips lines without a date when date is in structure', () => {
    const text = 'Header row no date\n01-04-2024 AM 12.5 4.0 30 375';
    const recs = extractRecordsWithStructure(text, fields);
    assert.strictEqual(recs.length, 1);
  });

  test('does not eat timestamps as numbers', () => {
    const text = '01-04-2024 06:30 AM 12.5 4.0 30 375';
    const recs = extractRecordsWithStructure(text, fields);
    // Without timestamp guard the first numeric column becomes 6.30 and
    // everything shifts. With the fix, the row is parsed correctly.
    assert.strictEqual(recs[0].quantity_liters, 12.5);
    assert.strictEqual(recs[0].total_amount, 375);
  });
});

describe('clusterWordsIntoRows', () => {
  const word = (text, x0, y0, x1, y1, conf = 90) => ({
    text, confidence: conf, bbox: { x0, y0, x1, y1 },
  });

  test('clusters words on the same baseline into one row', () => {
    const words = [
      word('Date',  10, 100, 60, 120),
      word('Qty',   80, 102, 110, 121),
      word('Amount', 130, 99, 200, 122),
      // Next row
      word('01-04-24', 10, 200, 70, 220),
      word('12.5',     80, 202, 110, 220),
      word('375',      130, 199, 170, 222),
    ];
    const rows = clusterWordsIntoRows(words);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].words.length, 3);
    assert.strictEqual(rows[1].words.length, 3);
  });
});

describe('extractRecordsFromOcrData (geometry-aware)', () => {
  const word = (text, x0, y0, x1, y1, conf = 90) => ({
    text, confidence: conf, bbox: { x0, y0, x1, y1 },
  });

  const fields = normaliseFields([
    { key: 'date',            order: 0 },
    { key: 'quantity_liters', order: 1 },
    { key: 'fat_percentage',  order: 2 },
    { key: 'total_amount',    order: 3 },
  ]);

  test('aligns columns by bbox even when a number is missing mid-row', () => {
    const words = [
      // Header
      word('Date',   10, 100,  60, 120),
      word('Qty',    100, 100, 140, 120),
      word('Fat',    180, 100, 220, 120),
      word('Amount', 260, 100, 320, 120),
      // Row 1 — full
      word('01-04-24', 10,  200, 70,  220),
      word('12.5',     100, 200, 140, 220),
      word('4.0',      180, 200, 220, 220),
      word('375',      260, 200, 300, 220),
      // Row 2 — Fat dropped, Amount still under "Amount" column.
      // Positional path would mis-assign 250 to fat_percentage; geometry path
      // correctly places it under total_amount.
      word('02-04-24', 10,  300, 70,  320),
      word('10.0',     100, 300, 140, 320),
      word('250',      260, 300, 300, 320),
    ];
    const text = '01-04-24 12.5 4.0 375\n02-04-24 10.0 250';
    const { records, usedGeometry } = extractRecordsFromOcrData(words, fields, text);
    assert.strictEqual(usedGeometry, true, 'should have used geometry');
    assert.strictEqual(records.length, 2);
    assert.strictEqual(records[0].total_amount, 375);
    assert.strictEqual(records[1].date, '2024-04-02');
    assert.strictEqual(records[1].quantity_liters, 10.0);
    assert.strictEqual(records[1].total_amount, 250, 'amount must stay 250 under its column');
    assert.strictEqual(records[1].fat_percentage, undefined, 'fat must NOT be filled by 250');
  });

  test('falls back to positional when no header anchors found', () => {
    const text = '01-04-2024 12.5 4.0 375';
    const { records, usedGeometry } = extractRecordsFromOcrData([], fields, text);
    assert.strictEqual(usedGeometry, false);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].quantity_liters, 12.5);
  });
});

// ────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
