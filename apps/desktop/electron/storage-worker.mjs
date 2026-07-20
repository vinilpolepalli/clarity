import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CURRENT_SCHEMA_VERSION, initializeStorageDatabase } from "./storage-schema.mjs";

const directory = process.argv.find((value) => value.startsWith("--directory="))?.slice("--directory=".length);
if (!directory) throw new Error("Storage directory is required");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const database = new DatabaseSync(join(directory, "clarity.sqlite"));
database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;");
initializeStorageDatabase(database);

const statements = {
  list: database.prepare("SELECT id, title, updated_at AS timestamp, substr(response, 1, 120) AS excerpt, response FROM sessions ORDER BY updated_at DESC LIMIT ?"),
  get: database.prepare("SELECT * FROM sessions WHERE id = ?"),
  insert: database.prepare("INSERT INTO sessions(id, title, prompt, response, started_at, updated_at, mode, mode_prompt_version, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
  searchIndex: database.prepare("INSERT INTO session_search(session_id, title, prompt, response) VALUES (?, ?, ?, ?)"),
  search: database.prepare("SELECT s.id, s.title, s.updated_at AS timestamp, snippet(session_search, 3, '<mark>', '</mark>', '…', 16) AS excerpt, s.response FROM session_search JOIN sessions s ON s.id = session_search.session_id WHERE session_search MATCH ? ORDER BY rank LIMIT ?"),
  remove: database.prepare("DELETE FROM sessions WHERE id = ?"),
  removeIndex: database.prepare("DELETE FROM session_search WHERE session_id = ?"),
  appendSegment: database.prepare("INSERT OR REPLACE INTO transcript_segments(id, session_id, sequence, speaker, text, started_ms, ended_ms) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  exportSession: database.prepare("SELECT s.*, (SELECT json_group_array(json_object('speaker', speaker, 'text', text, 'startedMs', started_ms, 'endedMs', ended_ms)) FROM transcript_segments t WHERE t.session_id = s.id ORDER BY sequence) AS transcript FROM sessions s WHERE id = ?")
};

function handle(method, params) {
  switch (method) {
    case "health": return { ok: true, schemaVersion: CURRENT_SCHEMA_VERSION };
    case "list": return statements.list.all(Math.min(Number(params.limit ?? 50), 200));
    case "get": return statements.get.get(params.id) ?? null;
    case "create": {
      const now = params.timestamp ?? new Date().toISOString();
      database.exec("BEGIN IMMEDIATE");
      try {
        statements.insert.run(params.id, params.title, params.prompt ?? "", params.response ?? "", now, now, params.mode ?? "general", params.modePromptVersion ?? 1, params.status ?? "complete");
        statements.searchIndex.run(params.id, params.title, params.prompt ?? "", params.response ?? "");
        database.exec("COMMIT");
        return statements.get.get(params.id);
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    }
    case "appendSegment": {
      statements.appendSegment.run(params.id, params.sessionId, params.sequence, params.speaker ?? null, params.text, params.startedMs, params.endedMs);
      return true;
    }
    case "search": return statements.search.all(String(params.query).replace(/["']/g, " "), Math.min(Number(params.limit ?? 30), 100));
    case "delete": {
      database.exec("BEGIN IMMEDIATE");
      try { statements.removeIndex.run(params.id); statements.remove.run(params.id); database.exec("COMMIT"); return true; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    }
    case "export": return statements.exportSession.get(params.id) ?? null;
    default: throw new Error(`Unsupported storage method: ${method}`);
  }
}

process.parentPort.on("message", (event) => {
  const message = event.data;
  try { process.parentPort.postMessage({ id: message.id, result: handle(message.method, message.params ?? {}) }); }
  catch (error) { process.parentPort.postMessage({ id: message.id, error: String(error?.message ?? error) }); }
});

process.on("exit", () => database.close());
