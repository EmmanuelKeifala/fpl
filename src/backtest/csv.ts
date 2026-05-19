export type CsvRow = Record<string, string>;

export function parseCsv(input: string): CsvRow[] {
  const records = parseRecords(input.replace(/^\uFEFF/, ''));
  if (records.length === 0) return [];

  const [headers, ...rows] = records;
  return rows
    .filter(row => row.length > 1 || row[0] !== '')
    .map((row, index) => {
      if (row.length !== headers.length) {
        throw new Error(`CSV row ${index + 2} has ${row.length} fields; expected ${headers.length}`);
      }

      return Object.fromEntries(headers.map((header, headerIndex) => [header, row[headerIndex] ?? '']));
    });
}

export function requireColumns(headers: string[], requiredColumns: string[], label: string): void {
  const missing = requiredColumns.filter(column => !headers.includes(column));
  if (missing.length > 0) throw new Error(`${label} is missing required columns: ${missing.join(', ')}`);
}

function parseRecords(input: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    const next = input[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        index++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      record.push(field);
      field = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') index++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (inQuotes) throw new Error('CSV input ended inside a quoted field');
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  return records;
}
