import { validateArtifact } from "@clarity/ai-core";

function timestamp(milliseconds) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds ?? 0) / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function normalized(value) {
  return String(value ?? "").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function evidenceFor(value, segments) {
  const requested = String(value ?? "").trim();
  const match = segments.find((segment) => {
    const text = normalized(segment.text);
    const evidence = normalized(requested.replace(/^\[[^\]]+\]\s*/, ""));
    return evidence && (text.includes(evidence) || evidence.includes(text));
  }) ?? segments[0];
  if (!match) return requested;
  const text = requested.replace(/^\[[^\]]+\]\s*/, "") || String(match.text ?? "");
  return `[${timestamp(match.startedMs)}] ${text}`;
}

function explicitlyMentioned(value, transcript) {
  return !value || normalized(transcript).includes(normalized(value));
}

export function validateMeetingArtifact(value, segments = []) {
  const artifact = validateArtifact(value);
  const transcript = segments.map((segment) => segment.text).join("\n");
  return {
    ...artifact,
    decisions: artifact.decisions.map((decision) => ({ ...decision, evidence: evidenceFor(decision.evidence, segments) })),
    actions: artifact.actions.map((action) => ({
      ...action,
      owner: explicitlyMentioned(action.owner, transcript) ? action.owner : null,
      due: explicitlyMentioned(action.due, transcript) ? action.due : null
    })),
    openQuestions: Array.isArray(value.openQuestions)
      ? value.openQuestions.map((question) => String(question).trim()).filter(Boolean).slice(0, 50)
      : []
  };
}

export function parseMeetingArtifact(response, segments = []) {
  const compact = String(response ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return validateMeetingArtifact(JSON.parse(compact), segments);
}
