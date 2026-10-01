type DBCell = string | number | boolean | Date;
type DBRecord = { [label: string]: any };
type DBSnapshot = { values: DBCell[][]; formulas: string[][]; fingerprint: string };

class SpreadSheetDB {
  private book = SpreadsheetApp.getActiveSpreadsheet();
  private sheet: GoogleAppsScript.Spreadsheet.Sheet | null = null;
  private data: DBCell[][] = [];
  private labels: string[] = [];
  private id: number = -1;
  private log: string = "";
  private snapshot: string | null = null;
  private needsReconnect = false;

  GetLog(): string {
    return this.log;
  }

  Connect(name: string): boolean {
    this.reset();
    return this.withLock(() => {
      const sheet = this.getBook().getSheetByName(name);
      if (sheet == null) return false;
      const current = this.readSheet(sheet);
      if (current.values.length < 2) throw new Error("The sheet has no database header.");
      const labels = current.values[1];
      const id = current.values[0][0];
      const data = current.values.slice(2);
      this.validateState(labels, data, id);
      if (current.values[0].slice(1).some((cell) => cell !== "")) {
        throw new Error("The metadata row must contain only the database ID counter.");
      }
      this.sheet = sheet;
      this.labels = labels.slice() as string[];
      this.data = this.cloneRows(data);
      this.id = id as number;
      this.snapshot = current.fingerprint;
      this.log += "$Connected\n";
      return true;
    });
  }

  Result(): DBRecord[] {
    const result = this.data.map((row) => this.record(row, this.labels));
    this.log += "$Result\nlines\t" + result.length + "\n";
    return result;
  }

  Map(func: (dic: DBRecord, id: number) => DBRecord, labels: (labels: string[]) => string[]): this {
    this.requireConnected();
    const mappedLabels = labels(this.labels.slice(1));
    if (!Array.isArray(mappedLabels)) throw new Error("Labels must be an array.");
    const nextLabels = ["id", ...mappedLabels];
    this.validateLabels(nextLabels);
    const nextData = this.data.map((row) => {
      const mapped = func(this.record(row.slice(1), this.labels.slice(1)), row[0] as number);
      this.validateRecord(mapped);
      return [row[0], ...nextLabels.slice(1).map((label) => this.field(mapped, label))];
    });
    this.validateState(nextLabels, nextData, this.id);
    this.labels = nextLabels;
    this.data = this.cloneRows(nextData);
    this.log += "$Map\nlines\t" + this.data.length + "\n";
    return this;
  }

  View(): string | null {
    const rows = [this.labels.join("\t"), ...this.data.map((row) => row.join("\t"))];
    this.log += "$View\n";
    return rows.join("\n");
  }

  Filter(func: (dic: DBRecord) => boolean): this {
    this.requireConnected();
    this.data = this.data.filter((row) => func(this.record(row, this.labels)) === true);
    this.log += "$Filter\nlines\t" + this.data.length + "\n";
    return this;
  }

  Save(): void {
    const sheet = this.requireConnected();
    // Build and validate everything before any write, including an empty database.
    this.validateState(this.labels, this.data, this.id);
    const next = this.matrix(this.labels, this.data, this.id);
    this.withLock(() => {
      if (this.getBook().getSheetById(sheet.getSheetId()) == null) {
        this.needsReconnect = true;
        throw new Error("The connected sheet no longer exists. Reconnect before saving.");
      }
      const current = this.readSheet(sheet);
      if (current.fingerprint !== this.snapshot) {
        this.needsReconnect = true;
        throw new Error("The sheet changed since Connect/Save. Reconnect and reapply your changes.");
      }
      const height = Math.max(current.values.length, next.length);
      const width = Math.max(current.values[0].length, next[0].length);
      if (height > sheet.getMaxRows() || width > sheet.getMaxColumns()) {
        throw new Error("The sheet grid is too small. Resize it before reconnecting and saving.");
      }
      const range = sheet.getRange(1, 1, height, width);
      if (range.isPartOfMerge()) throw new Error("Merged cells are not supported.");
      const padded: DBCell[][] = Array.from({ length: height }, (_, row) =>
        Array.from({ length: width }, (_, column) => next[row]?.[column] ?? "")
      );
      // One content-only write removes stale cells without first destroying the old sheet.
      // A network/API error can have an unknown result: never blindly overwrite it again.
      try {
        range.setValues(padded);
        SpreadsheetApp.flush();
        const saved = this.readSheet(sheet);
        if (this.valuesFingerprint(saved.values) !== this.valuesFingerprint(next)) {
          throw new Error("The saved content could not be verified.");
        }
        this.snapshot = saved.fingerprint;
      } catch (error) {
        this.needsReconnect = true;
        throw new Error("Save failed or its result is uncertain. Inspect the sheet and reconnect before retrying.");
      }
      this.log += "$Save\nlines\t" + this.data.length + "\n";
    });
  }

  Insert(ins: DBRecord): void {
    this.requireConnected();
    this.validateRecord(ins);
    const nextId = this.id + 1;
    if (!Number.isSafeInteger(nextId)) throw new Error("The database ID counter is exhausted.");
    const row = [nextId, ...this.labels.slice(1).map((label) => this.field(ins, label))];
    this.validateState(this.labels, [...this.data, row], nextId);
    this.data.push(row.map((cell) => this.cloneCell(cell)));
    this.id = nextId;
    this.log += "$Insert\nlines\t" + this.data.length + "\n";
  }

  Create(name: string, labels: string[]): void {
    // Every creation attempt deselects the previous database, even if validation or locking fails.
    this.reset();
    if (!Array.isArray(labels)) throw new Error("Labels must be an array.");
    const nextLabels = ["id", ...labels];
    this.validateLabels(nextLabels);
    if (typeof name !== "string" || name.trim() === "") throw new Error("A sheet name is required.");
    this.withLock(() => {
      const sheet = this.getBook().insertSheet(name);
      const initial = this.matrix(nextLabels, [], 0);
      try {
        if (initial[0].length > sheet.getMaxColumns()) {
          throw new Error("The sheet grid is too small for these labels.");
        }
        sheet.getRange(1, 1, 2, nextLabels.length).setValues(initial);
        SpreadsheetApp.flush();
        const saved = this.readSheet(sheet);
        if (this.valuesFingerprint(saved.values) !== this.valuesFingerprint(initial)) {
          throw new Error("The new database could not be verified.");
        }
        this.sheet = sheet;
        this.data = [];
        this.labels = nextLabels.slice();
        this.id = 0;
        this.snapshot = saved.fingerprint;
        this.needsReconnect = false;
      } catch (error) {
        throw new Error("Create failed or its result is uncertain. Inspect the new sheet before reconnecting.");
      }
      this.log += "$Create\n";
    });
  }

  private reset(): void {
    this.sheet = null;
    this.data = [];
    this.labels = [];
    this.id = -1;
    this.snapshot = null;
    this.needsReconnect = false;
  }

  private getBook(): GoogleAppsScript.Spreadsheet.Spreadsheet {
    if (this.book == null) throw new Error("An active spreadsheet is required.");
    return this.book;
  }

  private requireConnected(): GoogleAppsScript.Spreadsheet.Sheet {
    if (this.sheet == null || this.snapshot == null) throw new Error("Connect or Create a database first.");
    if (this.needsReconnect) throw new Error("Reconnect before making more changes.");
    return this.sheet;
  }

  private withLock<T>(operation: () => T): T {
    const lock = LockService.getDocumentLock() || LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      return operation();
    } finally {
      lock.releaseLock();
    }
  }

  private readSheet(sheet: GoogleAppsScript.Spreadsheet.Sheet): DBSnapshot {
    const range = sheet.getDataRange();
    if (range.isPartOfMerge()) throw new Error("Merged cells are not supported.");
    const values = range.getValues();
    const formulas = range.getFormulas();
    if (formulas.some((row) => row.some((formula) => formula !== ""))) {
      throw new Error("Formula cells are not supported. Convert them to literal values before connecting.");
    }
    values.forEach((row) => row.forEach((cell) => this.validateCell(cell)));
    const fingerprint = JSON.stringify([this.valuesFingerprint(values), formulas]);
    return { values, formulas, fingerprint };
  }

  private validateLabels(labels: any[]): void {
    if (!Array.isArray(labels) || labels.length === 0 || labels[0] !== "id") {
      throw new Error("The first database label must be id.");
    }
    const seen = new Set<string>();
    for (const label of labels) {
      if (typeof label !== "string" || label.trim() === "" || seen.has(label)) {
        throw new Error("Database labels must be unique, nonempty strings.");
      }
      this.validateCell(label);
      seen.add(label);
    }
  }

  private validateState(labels: any[], data: any[][], id: any): void {
    this.validateLabels(labels);
    if (!Number.isSafeInteger(id) || id < 0) throw new Error("Invalid database ID counter.");
    if (!Array.isArray(data)) throw new Error("Database rows must be an array.");
    const seen = new Set<number>();
    for (const row of data) {
      if (!Array.isArray(row) || row.length !== labels.length) throw new Error("Database rows must be rectangular.");
      // Indexed iteration also rejects sparse array holes (undefined).
      for (let column = 0; column < row.length; column++) this.validateCell(row[column]);
      const rowId = row[0];
      if (typeof rowId !== "number" || !Number.isSafeInteger(rowId) || rowId < 0 || rowId > id || seen.has(rowId)) {
        throw new Error("Database row IDs must be unique valid integers within the counter.");
      }
      seen.add(rowId);
    }
  }

  private validateCell(cell: any): void {
    if (typeof cell === "string") {
      // Fail closed instead of relying on unverified apostrophe escaping semantics.
      if (/^\s*=/.test(cell)) throw new Error("Formula-like strings are not allowed.");
      return;
    }
    if (typeof cell === "boolean" || (typeof cell === "number" && Number.isFinite(cell))) return;
    if (cell instanceof Date && Number.isFinite(cell.getTime())) return;
    throw new Error("Cells must be strings, finite numbers, booleans or valid Dates. Use an empty string for a blank.");
  }

  private validateRecord(record: DBRecord): void {
    if (record == null || typeof record !== "object" || Array.isArray(record) || record instanceof Date) {
      throw new Error("A record object is required.");
    }
  }

  private field(record: DBRecord, label: string): DBCell {
    if (!Object.prototype.hasOwnProperty.call(record, label)) throw new Error("A record is missing a database field.");
    const value = record[label];
    this.validateCell(value);
    return this.cloneCell(value);
  }

  private record(row: DBCell[], labels: string[]): DBRecord {
    // A dictionary must not be an Array; null prototypes also make __proto__ a normal key.
    const result: DBRecord = Object.create(null);
    labels.forEach((label, index) => { result[label] = this.cloneCell(row[index]); });
    return result;
  }

  private cloneCell(cell: DBCell): DBCell {
    return cell instanceof Date ? new Date(cell.getTime()) : cell;
  }

  private cloneRows(rows: DBCell[][]): DBCell[][] {
    return rows.map((row) => row.map((cell) => this.cloneCell(cell)));
  }

  private matrix(labels: string[], data: DBCell[][], id: number): DBCell[][] {
    return [[id, ...labels.slice(1).map(() => "")], labels.slice(), ...this.cloneRows(data)];
  }

  private valuesFingerprint(values: DBCell[][]): string {
    return JSON.stringify(values.map((row) => row.map((cell) =>
      cell instanceof Date ? ["date", cell.getTime()] : [typeof cell, cell]
    )));
  }
}
