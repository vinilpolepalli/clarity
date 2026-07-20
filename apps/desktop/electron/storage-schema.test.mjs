import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, initializeStorageDatabase } from "./storage-schema.mjs";

const sqliteModule = await import("node:sqlite").catch(() => null);
const DatabaseSync = sqliteModule?.DatabaseSync;
const describeWithSqlite = DatabaseSync ? describe : describe.skip;

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function openDatabase() {
  const directory = await mkdtemp(join(tmpdir(), "clarity-storage-"));
  temporaryDirectories.push(directory);
  return new DatabaseSync(join(directory, "clarity.sqlite"));
}

describeWithSqlite("storage schema migrations", () => {
  it("creates a fresh v3 schema with General and prompt version 1 defaults", async () => {
    const database = await openDatabase();
    expect(initializeStorageDatabase(database)).toBe(CURRENT_SCHEMA_VERSION);
    database.prepare("INSERT INTO sessions(id, title, started_at, updated_at) VALUES (?, ?, ?, ?)").run("fresh", "Fresh", "now", "now");
    expect({ ...database.prepare("SELECT mode, mode_prompt_version FROM sessions WHERE id = ?").get("fresh") }).toEqual({ mode: "general", mode_prompt_version: 1 });
    expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version).toBe(3);
    database.close();
  });

  it("migrates existing v2 conversations to legacy prompt version zero exactly once", async () => {
    const database = await openDatabase();
    database.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (1, datetime('now'));
      INSERT INTO schema_migrations VALUES (2, datetime('now'));
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '', response TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL, updated_at TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'meeting', status TEXT NOT NULL DEFAULT 'complete'
      );
      INSERT INTO sessions(id, title, started_at, updated_at, mode) VALUES ('legacy', 'Legacy', 'then', 'then', 'lecture');
    `);
    initializeStorageDatabase(database);
    initializeStorageDatabase(database);
    expect({ ...database.prepare("SELECT mode, mode_prompt_version FROM sessions WHERE id = ?").get("legacy") }).toEqual({ mode: "lecture", mode_prompt_version: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 3").get().count).toBe(1);
    database.close();
  });
});
