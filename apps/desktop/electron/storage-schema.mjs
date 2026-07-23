export const CURRENT_SCHEMA_VERSION = 4;

function hasTable(database, name) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function hasColumn(database, table, column) {
  return database.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column);
}

export function initializeStorageDatabase(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    const existingSessions = hasTable(database, "sessions");
    if (!existingSessions) {
      database.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL DEFAULT '',
          response TEXT NOT NULL DEFAULT '',
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          mode TEXT NOT NULL DEFAULT 'general',
          mode_prompt_version INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'complete',
          capture_source TEXT
        );
      `);
    }
    database.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, datetime('now'))").run(1);

    database.exec(`
      CREATE TABLE IF NOT EXISTS transcript_segments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        speaker TEXT,
        text TEXT NOT NULL,
        started_ms INTEGER NOT NULL,
        ended_ms INTEGER NOT NULL,
        UNIQUE(session_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'complete',
        created_at TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS conversation_messages_session_sequence
        ON conversation_messages(session_id, sequence);
      CREATE VIRTUAL TABLE IF NOT EXISTS session_search USING fts5(session_id UNINDEXED, title, prompt, response);
    `);
    database.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, datetime('now'))").run(2);

    if (existingSessions && !hasColumn(database, "sessions", "mode_prompt_version")) {
      database.exec("ALTER TABLE sessions ADD COLUMN mode_prompt_version INTEGER NOT NULL DEFAULT 0");
    }
    database.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, datetime('now'))").run(3);

    if (!hasColumn(database, "sessions", "capture_source")) {
      database.exec("ALTER TABLE sessions ADD COLUMN capture_source TEXT");
    }
    database.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, datetime('now'))").run(4);

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return CURRENT_SCHEMA_VERSION;
}
