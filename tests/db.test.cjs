const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const source = stripTypeScriptTypes(fs.readFileSync(path.join(__dirname, '../DB.ts'), 'utf8'));
const copy = (value) => value instanceof Date ? new Date(value.getTime()) : Array.isArray(value) ? value.map(copy) : value;
const plain = (value) => JSON.parse(JSON.stringify(value));

class Sheet {
  constructor(name, values = [], id = 1) {
    this.name = name; this.values = copy(values); this.formulas = []; this.id = id;
    this.maxRows = 1000; this.maxColumns = 26; this.writes = []; this.formats = { B3: 'currency' };
    this.merged = false; this.failure = null; this.afterWrite = null;
  }
  getSheetId() { return this.id; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxColumns; }
  getDataRange() {
    let rows = 1, columns = 1;
    for (const grid of [this.values, this.formulas]) grid.forEach((row, r) => row.forEach((cell, c) => {
      if (cell !== '' && cell !== undefined) { rows = Math.max(rows, r + 1); columns = Math.max(columns, c + 1); }
    }));
    return this.getRange(1, 1, rows, columns);
  }
  getRange(row, column, rows = 1, columns = 1) {
    assert.ok(rows > 0 && columns > 0, 'A range must have positive dimensions');
    assert.ok(row + rows - 1 <= this.maxRows && column + columns - 1 <= this.maxColumns);
    const get = (grid) => Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) => copy(grid[row - 1 + r]?.[column - 1 + c] ?? '')));
    return {
      getValues: () => get(this.values),
      getFormulas: () => get(this.formulas),
      isPartOfMerge: () => this.merged,
      setValues: (values) => {
        assert.equal(values.length, rows); values.forEach((r) => assert.equal(r.length, columns));
        this.writes.push(copy(values));
        if (this.failure === 'before') throw new Error('mock failure before mutation');
        for (let r = 0; r < rows; r++) {
          this.values[row - 1 + r] ??= []; this.formulas[row - 1 + r] ??= [];
          for (let c = 0; c < columns; c++) {
            const value = values[r][c];
            assert.ok(!(typeof value === 'string' && /^\s*=/.test(value)), 'Formula strings must never reach setValues');
            this.values[row - 1 + r][column - 1 + c] = copy(value);
            this.formulas[row - 1 + r][column - 1 + c] = '';
          }
          if (this.failure === 'partial') throw new Error('mock partial/unknown mutation');
        }
        if (this.afterWrite) this.afterWrite(this);
        if (this.failure === 'after') throw new Error('mock response lost after mutation');
      },
    };
  }
  clear() { throw new Error('clear must never be called'); }
  appendRow() { throw new Error('appendRow must never be called'); }
}

function setup(fixtures = { A: [[2, ''], ['id', 'name'], [1, 'old'], [2, 'keep']] }, options = {}) {
  let id = 0;
  const sheets = Object.fromEntries(Object.entries(fixtures).map(([name, values]) => [name, new Sheet(name, values, ++id)]));
  const book = {
    getSheetByName: (name) => sheets[name] ?? null,
    getSheetById: (sheetId) => Object.values(sheets).find((sheet) => sheet.id === sheetId) ?? null,
    insertSheet: (name) => {
      if (sheets[name]) throw new Error('duplicate sheet');
      const sheet = sheets[name] = new Sheet(name, [], ++id);
      if (options.createFailure) sheet.failure = options.createFailure;
      return sheet;
    },
  };
  const state = { held: false, acquired: 0, released: 0, flushFail: false, lockFail: false, scriptLocks: 0 };
  const lock = {
    waitLock: () => { if (state.lockFail) throw new Error('lock timeout'); assert.equal(state.held, false); state.held = true; state.acquired++; },
    releaseLock: () => { assert.equal(state.held, true); state.held = false; state.released++; },
  };
  const context = vm.createContext({
    Date, Error,
    SpreadsheetApp: { getActiveSpreadsheet: () => options.noBook ? null : book, flush: () => { if (state.flushFail) throw new Error('flush failed'); } },
    LockService: { getDocumentLock: () => options.noDocument ? null : lock, getScriptLock: () => { state.scriptLocks++; return lock; } },
  });
  vm.runInContext(source + '\nglobalThis.DB = SpreadSheetDB;', context);
  return { db: new context.DB(), newDB: () => new context.DB(), sheets, state };
}

test('Connect, Insert and Save use one write and preserve formatting', () => {
  const { db, sheets, state } = setup(); db.Connect('A'); db.Insert({ name: 'new' }); db.Save();
  assert.deepEqual(plain(sheets.A.getDataRange().getValues()), [[3, ''], ['id', 'name'], [1, 'old'], [2, 'keep'], [3, 'new']]);
  assert.equal(sheets.A.writes.length, 1); assert.deepEqual(sheets.A.formats, { B3: 'currency' });
  assert.equal(state.acquired, state.released); assert.equal(state.held, false);
  db.Save(); assert.equal(sheets.A.writes.length, 2);
});

test('Filter all rows then Save has valid dimensions and erases stale rows', () => {
  const { db, sheets } = setup(); db.Connect('A'); db.Filter(() => false).Save();
  assert.deepEqual(plain(sheets.A.getDataRange().getValues()), [[2, ''], ['id', 'name']]);
  assert.deepEqual(plain(sheets.A.writes[0]), [[2, ''], ['id', 'name'], ['', ''], ['', '']]);
  assert.deepEqual(plain(db.Result()), []);
});

test('Map to no user columns clears old columns in the same write', () => {
  const { db, sheets } = setup(); db.Connect('A'); db.Map(() => ({}), () => []).Save();
  assert.deepEqual(plain(sheets.A.getDataRange().getValues()), [[2], ['id'], [1], [2]]);
  assert.ok(sheets.A.writes[0].every((row) => row.length === 2 && row[1] === ''));
});

test('Create initializes every field, supports no labels and isolates prior data', () => {
  const { db, sheets } = setup(); db.Connect('A'); db.Create('B', ['title']); db.Insert({ title: 'B only' }); db.Save();
  assert.deepEqual(plain(sheets.B.getDataRange().getValues()), [[1, ''], ['id', 'title'], [1, 'B only']]);
  assert.deepEqual(plain(sheets.A.getDataRange().getValues()), [[2, ''], ['id', 'name'], [1, 'old'], [2, 'keep']]);
  db.Create('C', []); db.Save(); assert.deepEqual(plain(sheets.C.getDataRange().getValues()), [[0], ['id']]);
  db.Insert({}); db.Save(); assert.deepEqual(plain(db.Result()), [{ id: 1 }]);
});

test('Result, Map and Filter callbacks receive dictionaries, including special keys', () => {
  const { db } = setup({}); db.Create('B', ['__proto__', 'length']);
  db.Insert(JSON.parse('{"__proto__":"safe","length":"not an array"}'));
  const result = db.Result()[0]; assert.equal(Array.isArray(result), false); assert.equal(Object.getPrototypeOf(result), null);
  assert.deepEqual(plain(result), { id: 1, ['__proto__']: 'safe', length: 'not an array' });
  db.Map((record, id) => { assert.equal(Array.isArray(record), false); assert.equal(id, 1); return record; }, (labels) => labels);
  db.Filter((record) => { assert.equal(Array.isArray(record), false); return record.__proto__ === 'safe'; });
  assert.equal(db.Result().length, 1);
});

test('Map callback errors do not partially change rows or labels', () => {
  const { db, sheets } = setup(); db.Connect('A'); const before = plain(db.Result());
  assert.throws(() => db.Map((record, id) => { record.name = 'mutated'; if (id === 2) throw new Error('callback'); return { changed: 'x' }; }, () => ['changed']), /callback/);
  assert.deepEqual(plain(db.Result()), before); db.Save(); assert.equal(sheets.A.values[1][1], 'name');
});

test('Filter callback errors and Date mutations do not change internal state', () => {
  const date = new Date('2024-01-01T00:00:00Z');
  const { db } = setup({ A: [[2, ''], ['id', 'date'], [1, date], [2, date]] }); db.Connect('A');
  const before = plain(db.Result());
  assert.throws(() => db.Filter((row) => { row.date.setTime(0); if (row.id === 2) throw new Error('callback'); return false; }), /callback/);
  assert.deepEqual(plain(db.Result()), before);
  db.Result()[0].date.setTime(0); assert.deepEqual(plain(db.Result()), before);
});

test('Map label callbacks cannot mutate labels or bypass array validation', () => {
  const { db } = setup(); db.Connect('A');
  assert.throws(() => db.Map((record) => record, (labels) => { labels[0] = 'changed'; throw new Error('labels'); }), /labels/);
  assert.throws(() => db.Map((record) => record, () => 'name'), /array/);
  assert.deepEqual(plain(db.Result()), [{ id: 1, name: 'old' }, { id: 2, name: 'keep' }]);
});

for (const value of ['=1+1', '  =1+1', '\t=1+1', null, undefined, {}, [], NaN, Infinity, new Date('invalid')]) {
  test(`Invalid/formula-like Insert value is rejected before state or sheet mutation: ${String(value)}`, () => {
    const { db, sheets } = setup(); db.Connect('A'); const before = plain(db.Result());
    assert.throws(() => db.Insert({ name: value })); assert.deepEqual(plain(db.Result()), before); assert.equal(sheets.A.writes.length, 0);
    db.Insert({ name: 'valid' }); assert.equal(db.Result().at(-1).id, 3);
  });
}

test('Map rejects formulas, missing fields and invalid output without changing state', () => {
  const { db, sheets } = setup(); db.Connect('A'); const before = plain(db.Result());
  for (const output of [{ name: '=1+1' }, {}, null, []]) {
    assert.throws(() => db.Map(() => output, (labels) => labels)); assert.deepEqual(plain(db.Result()), before);
  }
  assert.equal(sheets.A.writes.length, 0);
});

test('Create rejects invalid or reserved duplicate labels before inserting a sheet', () => {
  const { db, sheets } = setup();
  for (const labels of [['name', 'name'], ['id'], [''], ['=1+1'], [null]]) assert.throws(() => db.Create('bad', labels));
  assert.deepEqual(Object.keys(sheets), ['A']);
});

test('Save revalidates type and rectangle before writing', () => {
  for (const mutate of [
    (db) => { db.data[0].push('extra'); },
    (db) => { db.data[0][1] = '=1+1'; },
    (db) => { delete db.data[0][1]; },
    (db) => { db.id = NaN; },
    (db) => { db.labels = []; },
  ]) {
    const { db, sheets } = setup(); db.Connect('A'); const before = plain(sheets.A.values); mutate(db);
    assert.throws(() => db.Save()); assert.equal(sheets.A.writes.length, 0); assert.deepEqual(plain(sheets.A.values), before);
  }
});

test('A stale instance cannot overwrite another writer; reconnect is required', () => {
  const { db, newDB, sheets } = setup(); const other = newDB(); db.Connect('A'); other.Connect('A');
  db.Insert({ name: 'first' }); other.Insert({ name: 'second' }); db.Save();
  const saved = plain(sheets.A.values); assert.throws(() => other.Save(), /changed since/);
  assert.deepEqual(plain(sheets.A.values), saved); assert.equal(sheets.A.writes.length, 1);
  assert.throws(() => other.Insert({ name: 'more' }), /Reconnect/);
  other.Connect('A'); other.Insert({ name: 'second' }); other.Save(); assert.equal(other.Result().at(-1).id, 4);
});

test('Direct sheet edits and Date-only edits cause snapshot conflicts', () => {
  const { db, sheets } = setup({ A: [[1, ''], ['id', 'date'], [1, new Date('2024-01-01')]] }); db.Connect('A');
  sheets.A.values[2][1].setTime(123); assert.throws(() => db.Save(), /changed since/); assert.equal(sheets.A.writes.length, 0);
});

for (const failure of ['before', 'after', 'partial']) {
  test(`A ${failure}-write failure never rolls back, never retries and requires reconnect`, () => {
    const { db, sheets, state } = setup(); db.Connect('A'); const old = plain(sheets.A.values); db.Insert({ name: 'new' }); sheets.A.failure = failure;
    assert.throws(() => db.Save(), /uncertain/); assert.equal(sheets.A.writes.length, 1);
    if (failure === 'before') assert.deepEqual(plain(sheets.A.values), old);
    const after = plain(sheets.A.values); assert.throws(() => db.Save(), /Reconnect/);
    assert.equal(sheets.A.writes.length, 1); assert.deepEqual(plain(sheets.A.values), after); assert.equal(state.held, false);
  });
}

test('Post-write outside edits are detected and preserved instead of being rolled back', () => {
  const { db, sheets } = setup(); db.Connect('A');
  sheets.A.afterWrite = (sheet) => { sheet.values[2][1] = 'external edit'; };
  assert.throws(() => db.Save(), /uncertain/); assert.equal(sheets.A.values[2][1], 'external edit'); assert.equal(sheets.A.writes.length, 1);
});

test('Flush failure invalidates the instance and always releases the lock', () => {
  const { db, sheets, state } = setup(); db.Connect('A'); state.flushFail = true;
  assert.throws(() => db.Save(), /uncertain/); assert.equal(state.held, false); assert.equal(sheets.A.writes.length, 1);
  assert.throws(() => db.Save(), /Reconnect/);
});

test('Connect rejects formulas and malformed databases without writes', () => {
  for (const values of [[], [[0]], [[0, ''], ['id', ''], [1, 'x']], [[1, ''], ['id', 'name'], [2, 'x']], [[1, ''], ['id', 'name'], [1, 'a'], [1, 'b']], [[1, ''], ['id', 'name'], [1, '=1+1']]]) {
    const { db, sheets } = setup({ A: values }); assert.throws(() => db.Connect('A')); assert.equal(sheets.A.writes.length, 0);
    assert.throws(() => db.Save(), /Connect or Create/);
  }
  const { db, sheets } = setup(); sheets.A.formulas[2] = ['', '=1+1'];
  assert.throws(() => db.Connect('A'), /Formula cells/); assert.equal(sheets.A.writes.length, 0);
});

test('Formula edits after Connect are rejected even if their computed value is unchanged', () => {
  const { db, sheets } = setup(); db.Connect('A'); sheets.A.formulas[2] = ['', '="old"'];
  assert.throws(() => db.Save(), /Formula cells/); assert.equal(sheets.A.writes.length, 0);
});

test('Failed Connect clears stale state; disconnected mutations are rejected', () => {
  const { db, sheets } = setup(); db.Connect('A'); assert.equal(db.Connect('missing'), false);
  assert.deepEqual(plain(db.Result()), []);
  for (const action of [() => db.Save(), () => db.Insert({ name: 'x' }), () => db.Map(() => ({}), () => []), () => db.Filter(() => true)]) assert.throws(action, /Connect or Create/);
  assert.equal(sheets.A.writes.length, 0);
});

test('Failed Create never leaves the previous sheet selected for Save', () => {
  const { db, sheets } = setup(undefined, { createFailure: 'before' }); db.Connect('A'); const old = plain(sheets.A.values);
  assert.throws(() => db.Create('B', ['new']), /Create failed/); assert.throws(() => db.Save(), /Connect or Create/);
  assert.deepEqual(plain(sheets.A.values), old); assert.equal(sheets.B.writes.length, 1);
});

test('Missing sheet, merged cells and insufficient grid fail without a write', () => {
  const deleted = setup(); deleted.db.Connect('A'); delete deleted.sheets.A; assert.throws(() => deleted.db.Save(), /no longer exists/);
  const merged = setup(); merged.db.Connect('A'); merged.sheets.A.merged = true; assert.throws(() => merged.db.Save(), /Merged/); assert.equal(merged.sheets.A.writes.length, 0);
  const small = setup(); small.db.Connect('A'); small.sheets.A.maxRows = 4; small.db.Insert({ name: 'too many' });
  assert.throws(() => small.db.Save(), /grid is too small/); assert.equal(small.sheets.A.writes.length, 0);
});

test('Script lock fallback, lock timeout and missing active spreadsheet are handled', () => {
  const fallback = setup(undefined, { noDocument: true }); fallback.db.Connect('A'); fallback.db.Save(); assert.equal(fallback.state.scriptLocks, 2);
  const timeout = setup(); timeout.db.Connect('A'); timeout.state.lockFail = true; assert.throws(() => timeout.db.Save(), /lock timeout/); assert.equal(timeout.sheets.A.writes.length, 0);
  const empty = setup(undefined, { noBook: true }); assert.throws(() => empty.db.Connect('A'), /active spreadsheet/); assert.equal(empty.state.held, false);
});

test('Logs omit cell values and View uses row separators', () => {
  const { db } = setup(); db.Connect('A'); db.Insert({ name: 'private-value' }); db.Map((row) => row, (labels) => labels); db.Filter(() => true); db.Result(); db.Save();
  assert.equal(db.GetLog().includes('private-value'), false); assert.match(db.View(), /id\tname\n1\told\n/);
});


test('Every failed Create attempt deselects the old database, including argument and lock errors', () => {
  for (const failure of ['labels', 'name', 'lock']) {
    const { db, sheets, state } = setup(); db.Connect('A'); db.Insert({ name: 'unsaved' });
    if (failure === 'lock') state.lockFail = true;
    assert.throws(() => db.Create(failure === 'name' ? '' : 'B', failure === 'labels' ? ['id'] : ['new']));
    assert.deepEqual(plain(db.Result()), []);
    assert.throws(() => db.Save(), /Connect or Create/);
    assert.equal(sheets.A.writes.length, 0); assert.deepEqual(Object.keys(sheets), ['A']);
  }
});
