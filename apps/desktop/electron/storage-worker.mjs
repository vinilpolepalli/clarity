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
  list: database.prepare(`
    SELECT s.id, s.title, s.updated_at AS timestamp,
      COALESCE((SELECT substr(content, 1, 120) FROM conversation_messages WHERE session_id = s.id ORDER BY sequence DESC LIMIT 1), substr(s.response, 1, 120)) AS excerpt,
      (SELECT count(*) FROM conversation_messages WHERE session_id = s.id) AS messageCount
    FROM sessions s ORDER BY s.updated_at DESC LIMIT ?
  `),
  get: database.prepare("SELECT * FROM sessions WHERE id = ?"),
  insert: database.prepare("INSERT INTO sessions(id, title, prompt, response, started_at, updated_at, mode, mode_prompt_version, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
  insertIfMissing: database.prepare("INSERT OR IGNORE INTO sessions(id, title, prompt, response, started_at, updated_at, mode, mode_prompt_version, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
  insertMessage: database.prepare("INSERT INTO conversation_messages(id, session_id, sequence, role, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  insertMessageIfMissing: database.prepare("INSERT OR IGNORE INTO conversation_messages(id, session_id, sequence, role, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  listMessages: database.prepare("SELECT id, role, content, status, created_at AS createdAt FROM conversation_messages WHERE session_id = ? ORDER BY sequence"),
  touchSession: database.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?"),
  searchIndex: database.prepare("INSERT INTO session_search(session_id, title, prompt, response) VALUES (?, ?, ?, ?)"),
  searchContent: database.prepare(`
    SELECT s.title,
      COALESCE(group_concat(CASE WHEN m.role = 'user' THEN m.content END, char(10)), '') AS prompt,
      COALESCE(group_concat(CASE WHEN m.role = 'assistant' THEN m.content END, char(10)), '') AS response
    FROM sessions s LEFT JOIN conversation_messages m ON m.session_id = s.id
    WHERE s.id = ? GROUP BY s.id
  `),
  search: database.prepare("SELECT s.id, s.title, s.updated_at AS timestamp, snippet(session_search, 3, '<mark>', '</mark>', '…', 16) AS excerpt, s.response FROM session_search JOIN sessions s ON s.id = session_search.session_id WHERE session_search MATCH ? ORDER BY rank LIMIT ?"),
  remove: database.prepare("DELETE FROM sessions WHERE id = ?"),
  removeIndex: database.prepare("DELETE FROM session_search WHERE session_id = ?"),
  appendSegment: database.prepare("INSERT OR REPLACE INTO transcript_segments(id, session_id, sequence, speaker, text, started_ms, ended_ms) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  transcript: database.prepare("SELECT id, sequence, speaker, text, started_ms AS startedMs, ended_ms AS endedMs FROM transcript_segments WHERE session_id = ? ORDER BY sequence"),
  artifact: database.prepare("SELECT id, kind, content, created_at AS createdAt FROM artifacts WHERE session_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1"),
  upsertArtifact: database.prepare("INSERT INTO artifacts(id, session_id, kind, content, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET content = excluded.content, created_at = excluded.created_at"),
  exportSession: database.prepare("SELECT s.*, (SELECT json_group_array(json_object('speaker', speaker, 'text', text, 'startedMs', started_ms, 'endedMs', ended_ms)) FROM transcript_segments t WHERE t.session_id = s.id ORDER BY sequence) AS transcript FROM sessions s WHERE id = ?")
};

function conversation(id) {
  const session = statements.get.get(id);
  if (!session) return null;
  return {
    id: session.id,
    title: session.title,
    startedAt: session.started_at,
    updatedAt: session.updated_at,
    mode: session.mode,
    modePromptVersion: session.mode_prompt_version,
    status: session.status,
    messages: statements.listMessages.all(id)
  };
}

function rebuildSearchIndex(id) {
  const content = statements.searchContent.get(id);
  if (!content) return;
  statements.removeIndex.run(id);
  statements.searchIndex.run(id, content.title, content.prompt, content.response);
}

function handle(method, params) {
  switch (method) {
    case "health": return { ok: true, schemaVersion: CURRENT_SCHEMA_VERSION };
    case "list": return statements.list.all(Math.min(Number(params.limit ?? 50), 200));
    case "get": return conversation(params.id);
    case "createConversation": {
      const now = params.timestamp ?? new Date().toISOString();
      statements.insert.run(params.id, params.title, "", "", now, now, params.mode ?? "general", params.modePromptVersion ?? 1, params.status ?? "active");
      statements.searchIndex.run(params.id, params.title, "", "");
      return conversation(params.id);
    }
    case "createMeetingSession": {
      const now = params.timestamp ?? new Date().toISOString();
      statements.insertIfMissing.run(params.id, params.title ?? "Live meeting", "", "", now, now, "meeting", 1, "active");
      database.prepare("UPDATE sessions SET capture_source = ?, status = ?, updated_at = ? WHERE id = ?").run(params.captureSource ?? "both", "active", now, params.id);
      statements.searchIndex.run(params.id, params.title ?? "Live meeting", "", "");
      return conversation(params.id);
    }
    case "ensureConversation": {
      const now = params.timestamp ?? new Date().toISOString();
      const messages = Array.isArray(params.messages) ? params.messages : [];
      database.exec("BEGIN IMMEDIATE");
      try {
        statements.insertIfMissing.run(params.id, params.title, "", "", now, now, params.mode ?? "general", params.modePromptVersion ?? 1, params.status ?? "active");
        for (const [sequence, message] of messages.entries()) {
          if (message?.role !== "user" && message?.role !== "assistant") continue;
          statements.insertMessageIfMissing.run(
            message.id,
            params.id,
            sequence,
            message.role,
            String(message.content ?? ""),
            message.status ?? "complete",
            message.createdAt ?? now
          );
        }
        rebuildSearchIndex(params.id);
        database.exec("COMMIT");
        return conversation(params.id);
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    }
    case "appendMessage": {
      const now = params.createdAt ?? new Date().toISOString();
      database.exec("BEGIN IMMEDIATE");
      try {
        statements.insertMessage.run(params.id, params.sessionId, params.sequence, params.role, params.content, params.status ?? "complete", now);
        statements.touchSession.run(now, params.sessionId);
        rebuildSearchIndex(params.sessionId);
        database.exec("COMMIT");
        return true;
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    }
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
    case "getTranscript": return statements.transcript.all(params.sessionId);
    case "upsertArtifact": {
      const createdAt = params.createdAt ?? new Date().toISOString();
      statements.upsertArtifact.run(params.id, params.sessionId, params.kind, JSON.stringify(params.content), createdAt);
      statements.touchSession.run(createdAt, params.sessionId);
      const artifact = statements.artifact.get(params.sessionId, params.kind);
      return artifact ? { ...artifact, content: JSON.parse(artifact.content) } : null;
    }
    case "getArtifact": {
      const artifact = statements.artifact.get(params.sessionId, params.kind);
      return artifact ? { ...artifact, content: JSON.parse(artifact.content) } : null;
    }
    case "completeMeetingSession": {
      database.prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?").run(params.status ?? "complete", new Date().toISOString(), params.sessionId);
      return true;
    }
    case "search": return statements.search.all(String(params.query).replace(/["']/g, " "), Math.min(Number(params.limit ?? 30), 100));
    case "delete": {
      database.exec("BEGIN IMMEDIATE");
      try { statements.removeIndex.run(params.id); statements.remove.run(params.id); database.exec("COMMIT"); return true; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    }
    case "export": {
      const exported = statements.exportSession.get(params.id);
      return exported ? { ...exported, messages: statements.listMessages.all(params.id) } : null;
    }
    default: throw new Error(`Unsupported storage method: ${method}`);
  }
}

process.parentPort.on("message", (event) => {
  const message = event.data;
  try { process.parentPort.postMessage({ id: message.id, result: handle(message.method, message.params ?? {}) }); }
  catch (error) { process.parentPort.postMessage({ id: message.id, error: String(error?.message ?? error) }); }
});

process.on("exit", () => database.close());
