import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeStorageDatabase } from "../electron/storage-schema.mjs";

const directory = await mkdtemp(join(tmpdir(), "clarity-storage-smoke-"));

try {
  const fresh = new DatabaseSync(join(directory, "fresh.sqlite"));
  initializeStorageDatabase(fresh);
  fresh.prepare("INSERT INTO sessions(id, title, started_at, updated_at) VALUES (?, ?, ?, ?)").run("fresh", "Fresh", "now", "now");
  assert.deepEqual({ ...fresh.prepare("SELECT mode, mode_prompt_version FROM sessions WHERE id = ?").get("fresh") }, { mode: "general", mode_prompt_version: 1 });
  fresh.close();

  const legacy = new DatabaseSync(join(directory, "legacy.sqlite"));
  legacy.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES (1, datetime('now'));
    INSERT INTO schema_migrations VALUES (2, datetime('now'));
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '', response TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL, updated_at TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'meeting', status TEXT NOT NULL DEFAULT 'complete'
    );
    INSERT INTO sessions(id, title, started_at, updated_at, mode) VALUES ('legacy', 'Legacy', 'then', 'then', 'lecture');
  `);
  initializeStorageDatabase(legacy);
  initializeStorageDatabase(legacy);
  assert.deepEqual({ ...legacy.prepare("SELECT mode, mode_prompt_version FROM sessions WHERE id = ?").get("legacy") }, { mode: "lecture", mode_prompt_version: 0 });
  assert.equal(legacy.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 4);
  assert.equal(legacy.prepare("PRAGMA table_info(sessions)").all().some((column) => column.name === "capture_source"), true);
  legacy.close();

  console.log("Storage migration smoke passed");
} finally {
  await rm(directory, { recursive: true, force: true });
}
