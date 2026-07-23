import { describe, expect, it } from "vitest";
import { parseMeetingArtifact, validateMeetingArtifact } from "./meeting-artifact.mjs";

const segments = [{ startedMs: 61_000, endedMs: 63_000, text: "Alex will publish the notes by Friday. The team agreed to ship." }];

describe("meeting artifact validation", () => {
  it("keeps owners and due dates only when explicitly present in the transcript", () => {
    const artifact = validateMeetingArtifact({
      title: "Planning",
      summary: "Ship it.",
      decisions: [{ text: "Ship", evidence: "The team agreed to ship." }],
      actions: [
        { text: "Publish notes", owner: "Alex", due: "Friday" },
        { text: "Follow up", owner: "Taylor", due: "Next Tuesday" }
      ]
    }, segments);

    expect(artifact.decisions[0].evidence).toBe("[1:01] The team agreed to ship.");
    expect(artifact.actions[0]).toMatchObject({ owner: "Alex", due: "Friday" });
    expect(artifact.actions[1]).toMatchObject({ owner: null, due: null });
  });

  it("accepts fenced JSON and retains explicit open questions", () => {
    const artifact = parseMeetingArtifact("```json\n{\"title\":\"Planning\",\"summary\":\"Discussed launch.\",\"decisions\":[],\"actions\":[],\"openQuestions\":[\"Who owns rollout?\"]}\n```", segments);
    expect(artifact.openQuestions).toEqual(["Who owns rollout?"]);
  });
});
