import { describe, expect, it } from "vitest";
import {
  createActivityEvent,
  orderActivityEvents,
  validateActivityEvent,
} from "../activity";

describe("activity evidence", () => {
  it("orders equal-time events by session and event identity", () => {
    const timestamp = "2026-08-29T12:00:00.000Z";
    const events = orderActivityEvents([
      createActivityEvent({
        id: "event-b",
        projectId: "project-1",
        sessionId: "session-b",
        occurredAt: timestamp,
        category: "AGENT",
        message: "Analyzing reference",
        evidence: [{ kind: "SESSION", id: "session-b" }],
      }),
      createActivityEvent({
        id: "event-c",
        projectId: "project-1",
        sessionId: "session-a",
        occurredAt: timestamp,
        category: "AGENT",
        message: "Analyzing reference",
        evidence: [{ kind: "SESSION", id: "session-a" }],
      }),
      createActivityEvent({
        id: "event-a",
        projectId: "project-1",
        sessionId: "session-a",
        occurredAt: timestamp,
        category: "SYSTEM",
        message: "Session record created",
        evidence: [{ kind: "SESSION", id: "session-a" }],
      }),
    ]);

    expect(events.map((event) => event.id)).toEqual([
      "event-a",
      "event-c",
      "event-b",
    ]);
  });

  it("rejects non-canonical timestamps and generic thinking status", () => {
    expect(
      validateActivityEvent({
        id: "event-1",
        projectId: "project-1",
        sessionId: "session-1",
        occurredAt: "2026-08-29T12:00:00Z",
        category: "AGENT",
        message: "Thinking…",
        evidence: [{ kind: "SESSION", id: "session-1" }],
      }),
    ).toBe(false);

    expect(() =>
      createActivityEvent({
        id: "event-1",
        projectId: "project-1",
        sessionId: "session-1",
        occurredAt: "2026-08-29T12:00:00.000Z",
        category: "AGENT",
        message: "Thinking…",
        evidence: [{ kind: "SESSION", id: "session-1" }],
      }),
    ).toThrow(/concrete/i);
  });

  it("returns an immutable event with bounded evidence references", () => {
    const event = createActivityEvent({
      id: "event-1",
      projectId: "project-1",
      sessionId: "session-1",
      occurredAt: "2026-08-29T12:00:00.000Z",
      category: "RENDER",
      message: "Capturing /home",
      evidence: [
        { kind: "SESSION", id: "session-1" },
        { kind: "RENDER", id: "render-1", label: "Desktop /home" },
      ],
    });

    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.evidence)).toBe(true);
    expect(Object.isFrozen(event.evidence[0])).toBe(true);
  });

  it("normalizes records passed to the ordering boundary and rejects duplicate identities", () => {
    const event = createActivityEvent({
      id: "event-1",
      projectId: "project-1",
      sessionId: "session-1",
      occurredAt: "2026-08-29T12:00:00.000Z",
      category: "SYSTEM",
      message: "Session record created",
      evidence: [{ kind: "SESSION", id: "session-1" }],
    });
    const mutable = { ...event, evidence: [...event.evidence] } as unknown as typeof event;
    const ordered = orderActivityEvents([mutable]);

    expect(Object.isFrozen(ordered[0])).toBe(true);
    expect(Object.isFrozen(ordered[0]?.evidence)).toBe(true);
    expect(() => orderActivityEvents([event, { ...event, message: "Different checkpoint" }]))
      .toThrow(/duplicate|unique|identity/i);
  });

  it("keeps the comparator total for equal timestamp and session identity", () => {
    const left = createActivityEvent({
      id: "event-a",
      projectId: "project-1",
      sessionId: "session-1",
      occurredAt: "2026-08-29T12:00:00.000Z",
      category: "SYSTEM",
      message: "Session record created",
      evidence: [{ kind: "SESSION", id: "session-1" }],
    });
    const right = createActivityEvent({
      id: "event-a-2",
      projectId: "project-1",
      sessionId: "session-1",
      occurredAt: "2026-08-29T12:00:00.000Z",
      category: "AGENT",
      message: "Analyzing reference",
      evidence: [{ kind: "SESSION", id: "session-1" }],
    });

    expect(orderActivityEvents([right, left]).map(({ id }) => id)).toEqual([
      "event-a",
      "event-a-2",
    ]);
    expect(orderActivityEvents([left, right]).map(({ id }) => id)).toEqual([
      "event-a",
      "event-a-2",
    ]);
  });
});
