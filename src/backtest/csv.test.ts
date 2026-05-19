import { strict as assert } from 'node:assert';
import test from 'node:test';
import { parseCsv, requireColumns } from './csv.js';

test('parseCsv parses headers, quoted commas, escaped quotes, and empty fields', () => {
  const rows = parseCsv('id,name,note,value\n1,"Saka, Bukayo","He said ""go""",83\n2,Foden,,');

  assert.deepEqual(rows, [
    { id: '1', name: 'Saka, Bukayo', note: 'He said "go"', value: '83' },
    { id: '2', name: 'Foden', note: '', value: '' },
  ]);
});

test('parseCsv ignores a trailing blank line', () => {
  assert.deepEqual(parseCsv('id,name\n1,Alpha\n'), [{ id: '1', name: 'Alpha' }]);
});

test('parseCsv rejects rows with a different field count than the header', () => {
  assert.throws(() => parseCsv('id,name\n1,Alpha,extra'), /CSV row 2 has 3 fields; expected 2/);
});

test('requireColumns rejects missing headers', () => {
  assert.throws(() => requireColumns(['id', 'name'], ['id', 'value'], 'players'), /players is missing required columns: value/);
});
