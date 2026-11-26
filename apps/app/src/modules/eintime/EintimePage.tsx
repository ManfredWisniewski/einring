import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError } from "~/api/client";
import {
  useEintimeCreateEntry,
  useEintimeEntries,
  useEintimeTimer,
  useEintimeUpdateEntry,
} from "~/api/hooks";
import { DayList } from "./DayList";
import { addDays, dayKey, dayKeys, dayRangeIso, weekStart } from "./dates";
import { Report } from "./Report";
import { TimerBar } from "./TimerBar";
import { Timesheet } from "./Timesheet";
import { WeekGrid } from "./WeekGrid";

const SNAP_MINUTES = 15; // matches MODULE_EINTIME_SNAP_MINUTES default (BFF)

function WeekNav({
  anchor,
  dayView,
  onAnchor,
  onDayView,
}: {
  anchor: Date;
  dayView: boolean;
  onAnchor: (d: Date) => void;
  onDayView: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const step = dayView ? 1 : 7;
  return (
    <div className="row">
      <Button
        variant="outlined"
        size="sm"
        aria-label={dayView ? t("modules.eintime.prevDay") : t("modules.eintime.prevWeek")}
        onClick={() => onAnchor(addDays(anchor, -step))}
      >
        <ChevronLeft className="size-4" aria-hidden />
      </Button>
      <Button variant="outlined" size="sm" onClick={() => onAnchor(new Date())}>
        {t("modules.eintime.today")}
      </Button>
      <Button
        variant="outlined"
        size="sm"
        aria-label={dayView ? t("modules.eintime.nextDay") : t("modules.eintime.nextWeek")}
        onClick={() => onAnchor(addDays(anchor, step))}
      >
        <ChevronRight className="size-4" aria-hidden />
      </Button>
      <Button variant="outlined" size="sm" onClick={() => onDayView(!dayView)}>
        {dayView ? t("modules.eintime.weekView") : t("modules.eintime.dayView")}
      </Button>
    </div>
  );
}

export function EintimePage() {
  const { t } = useTranslation();
  const timer = useEintimeTimer();
  const create = useEintimeCreateEntry();
  const update = useEintimeUpdateEntry();

  // Timer tab lists the last 14 days; week/timesheet share the visible range.
  const listFrom = dayKey(addDays(new Date(), -14));
  const listRange = dayRangeIso(dayKeys(new Date(`${listFrom}T00:00:00`), 15));
  const listEntries = useEintimeEntries(listRange.from, listRange.to);

  const [anchor, setAnchor] = useState(() => new Date());
  const [dayView, setDayView] = useState(false);
  const first = dayView ? anchor : weekStart(anchor);
  const days = dayKeys(first, dayView ? 1 : 7);
  const range = dayRangeIso(days);
  const gridEntries = useEintimeEntries(range.from, range.to);

  const err = timer.error ?? listEntries.error ?? gridEntries.error;
  return (
    <div className="stack">
      {err && (
        <div className="alert alert--danger">
          {t("modules.eintime.error", { status: err instanceof ApiError ? err.status : "?" })}
        </div>
      )}
      <Tabs defaultValue="timer">
        <TabsList>
          <TabsTrigger value="timer">{t("modules.eintime.tabTimer")}</TabsTrigger>
          <TabsTrigger value="week">{t("modules.eintime.tabWeek")}</TabsTrigger>
          <TabsTrigger value="timesheet">{t("modules.eintime.tabTimesheet")}</TabsTrigger>
          <TabsTrigger value="report">{t("modules.eintime.tabReport")}</TabsTrigger>
        </TabsList>
        <TabsContent value="timer" className="stack">
          <TimerBar running={timer.data?.running ?? null} />
          <DayList segments={listEntries.data?.entries ?? []} />
        </TabsContent>
        <TabsContent value="week" className="stack">
          <WeekNav anchor={anchor} dayView={dayView} onAnchor={setAnchor} onDayView={setDayView} />
          <WeekGrid
            days={days}
            segments={gridEntries.data?.entries ?? []}
            snapMinutes={SNAP_MINUTES}
            onCreate={(start, end) => create.mutate({ start, end })}
            onResize={(entryId, patch) => update.mutate({ id: entryId, patch })}
          />
        </TabsContent>
        <TabsContent value="timesheet" className="stack">
          <div className="row">
            <Button
              variant="outlined"
              size="sm"
              aria-label={t("modules.eintime.prevWeek")}
              onClick={() => setAnchor(addDays(anchor, -7))}
            >
              <ChevronLeft className="size-4" aria-hidden />
            </Button>
            <Button variant="outlined" size="sm" onClick={() => setAnchor(new Date())}>
              {t("modules.eintime.today")}
            </Button>
            <Button
              variant="outlined"
              size="sm"
              aria-label={t("modules.eintime.nextWeek")}
              onClick={() => setAnchor(addDays(anchor, 7))}
            >
              <ChevronRight className="size-4" aria-hidden />
            </Button>
          </div>
          <Timesheet days={days} segments={gridEntries.data?.entries ?? []} />
        </TabsContent>
        <TabsContent value="report">
          <Report />
        </TabsContent>
      </Tabs>
    </div>
  );
}
