"use client";

import type { ActivityEvent } from "@design-sharingan/core";

export function ProjectActivityPanel({ events }: { events: readonly ActivityEvent[] }) {
  return (
    <section className="report-panel" aria-labelledby="report-activity-title">
      <div className="report-panel__header">
        <p className="utility-label">ACTIVITY</p>
        <h2 id="report-activity-title">Durable workflow record</h2>
      </div>
      {events.length > 0 ? (
        <ol className="activity-log">
          {events.map((event) => (
            <li key={event.id}>
              <span>{event.category}</span>
              <strong>{event.message}</strong>
              <time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString()}</time>
            </li>
          ))}
        </ol>
      ) : <p>Activity is unavailable until a durable transition is recorded.</p>}
    </section>
  );
}
