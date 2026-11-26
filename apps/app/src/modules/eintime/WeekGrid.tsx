import { useRef, useState } from "react";
import type { EintimeSegment } from "~/api/types";
import { dayIso, dayStart } from "./dates";

const PX_MIN = 0.8; // 48 px per hour
const DAY_MINS = 1440;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const snapMin = (m: number, snap: number, fine: boolean) =>
  fine ? Math.round(m) : Math.round(m / snap) * snap;
const minsIntoDay = (iso: string, day: string) =>
  clamp(0, DAY_MINS, (Date.parse(iso) - dayStart(day).getTime()) / 60_000);

interface DragState {
  kind: "paint" | "resize";
  /** paint: anchor minute + current minute. */
  a: number;
  b: number;
  /** resize: entry + edge + current minute. */
  entryId?: string;
  edge?: "top" | "bottom";
  /** resize limit — the entry's opposite bound in day minutes. */
  limit?: number;
}

function DayColumn({
  day,
  segments,
  snapMinutes,
  onCreate,
  onResize,
}: {
  day: string;
  segments: EintimeSegment[];
  snapMinutes: number;
  onCreate: (start: string, end: string) => void;
  onResize: (entryId: string, patch: { start?: string; end?: string }) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const minsAt = (e: React.PointerEvent) => {
    const r = ref.current?.getBoundingClientRect();
    return clamp(0, DAY_MINS, r ? (e.clientY - r.top) / PX_MIN : 0);
  };
  const fine = (e: React.PointerEvent) => e.altKey || e.shiftKey;

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !ref.current) return;
    if ((e.target as HTMLElement).closest(".eintime-block")) return;
    const m = snapMin(minsAt(e), snapMinutes, fine(e));
    ref.current.setPointerCapture(e.pointerId);
    setDrag({ kind: "paint", a: m, b: m });
  };

  const startResize = (
    e: React.PointerEvent,
    entryId: string,
    edge: "top" | "bottom",
    limit: number,
  ) => {
    if (e.button !== 0 || !ref.current) return;
    e.stopPropagation();
    const m = snapMin(minsAt(e), snapMinutes, fine(e));
    ref.current.setPointerCapture(e.pointerId);
    setDrag({ kind: "resize", a: m, b: m, entryId, edge, limit });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const m = snapMin(minsAt(e), snapMinutes, fine(e));
    setDrag({ ...drag, b: m });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag || !ref.current) return;
    ref.current.releasePointerCapture(e.pointerId);
    if (drag.kind === "paint") {
      const s = Math.min(drag.a, drag.b);
      const en = Math.max(drag.a, drag.b);
      if (en - s >= 1) onCreate(dayIso(day, s), dayIso(day, en));
    } else if (drag.entryId && drag.edge) {
      const m =
        drag.edge === "top"
          ? clamp(drag.b, 0, (drag.limit ?? DAY_MINS) - 1)
          : clamp(drag.b, (drag.limit ?? 0) + 1, DAY_MINS);
      const iso = dayIso(day, m);
      onResize(drag.entryId, drag.edge === "top" ? { start: iso } : { end: iso });
    }
    setDrag(null);
  };

  return (
    <div
      ref={ref}
      className="eintime-col"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {segments.map((s) => {
        const top = minsIntoDay(s.segStart, day);
        const bottom = minsIntoDay(s.segEnd, day);
        const resizing = drag?.kind === "resize" && drag.entryId === s.entryId;
        let topMin = top;
        let bottomMin = Math.max(bottom, top + 1);
        if (resizing && drag.edge === "top") topMin = clamp(0, bottomMin - 1, drag.b);
        if (resizing && drag.edge === "bottom") bottomMin = clamp(topMin + 1, DAY_MINS, drag.b);
        const canTop = s.segStart === s.start;
        const canBottom = !s.running && s.end !== null && s.segEnd === s.end;
        return (
          <div
            key={`${s.entryId}-${s.segStart}`}
            className={`eintime-block${s.running ? " eintime-block--running" : ""}`}
            style={{ top: topMin * PX_MIN, height: Math.max(4, (bottomMin - topMin) * PX_MIN) }}
          >
            {canTop && (
              <div
                className="eintime-block__edge eintime-block__edge--top"
                onPointerDown={(e) => startResize(e, s.entryId, "top", bottomMin)}
              />
            )}
            <div className="eintime-block__label">{s.projectName ?? s.description ?? ""}</div>
            {canBottom && (
              <div
                className="eintime-block__edge eintime-block__edge--bottom"
                onPointerDown={(e) => startResize(e, s.entryId, "bottom", topMin)}
              />
            )}
          </div>
        );
      })}
      {drag?.kind === "paint" && (
        <div
          className="eintime-block eintime-block--preview"
          style={{
            top: Math.min(drag.a, drag.b) * PX_MIN,
            height: Math.max(2, Math.abs(drag.b - drag.a) * PX_MIN),
          }}
        />
      )}
    </div>
  );
}

/**
 * Week/day time grid (spec eintime FR-007): paint a block to log time, drag an
 * edge to resize — snapped to `snapMinutes`, held Alt/Shift gives 1-minute precision.
 */
export function WeekGrid({
  days,
  segments,
  snapMinutes,
  onCreate,
  onResize,
}: {
  days: string[];
  segments: EintimeSegment[];
  snapMinutes: number;
  onCreate: (start: string, end: string) => void;
  onResize: (entryId: string, patch: { start?: string; end?: string }) => void;
}) {
  const hours = Array.from({ length: 24 }, (_, i) => i);
  return (
    <div className="eintime-grid">
      <div className="eintime-grid__axis">
        {hours.map((h) => (
          <div key={h} className="eintime-grid__hour" style={{ top: h * 60 * PX_MIN }}>
            {h}:00
          </div>
        ))}
      </div>
      {days.map((day) => (
        <div key={day} className="eintime-grid__day">
          <div className="eintime-grid__dayhead">
            {new Date(`${day}T00:00:00`).toLocaleDateString(undefined, {
              weekday: "short",
              day: "numeric",
              month: "numeric",
            })}
          </div>
          <DayColumn
            day={day}
            segments={segments.filter((s) => s.day === day)}
            snapMinutes={snapMinutes}
            onCreate={onCreate}
            onResize={onResize}
          />
        </div>
      ))}
    </div>
  );
}
