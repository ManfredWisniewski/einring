import { Minus, RefreshCw, SignalHigh, SignalLow, SignalMedium, TriangleAlert } from "lucide-react";
import { type ComponentType, type CSSProperties, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiError } from "~/api/client";
import {
  useApi,
  useConnectorStatus,
  useItsaplanBoards,
  useItsaplanTickets,
  useItsaplanUpdateTicket,
  useModuleRegistry,
} from "~/api/hooks";
import type { ItsaplanBoard, ItsaplanColumn, ItsaplanTicket } from "~/api/types";
import { ConnectorPage } from "~/components/ConnectorPage";

function BoardRow({ board }: { board: ItsaplanBoard }) {
  const { t } = useTranslation();
  const inner = (
    <CardHeader>
      <CardTitle className="text-base">
        {board.name}
        {board.archived ? ` (${t("modules.itsaplan.archived")})` : ""}
      </CardTitle>
      <CardDescription>
        {board.ref}
        {board.teamName ? ` · ${board.teamName}` : ""}
        {board.lastActivityAt ? ` · ${new Date(board.lastActivityAt).toLocaleString()}` : ""}
      </CardDescription>
    </CardHeader>
  );
  return (
    <Card>
      {board.url ? (
        <a href={board.url} target="_blank" rel="noreferrer" className="block">
          {inner}
        </a>
      ) : (
        inner
      )}
    </Card>
  );
}

function TicketRow({
  ticket,
  estimate,
  timed,
  timerRunning,
  timerDisabled,
  onToggleTimer,
  states,
  onStateChange,
  stateDisabled,
}: {
  ticket: ItsaplanTicket;
  estimate?: string | null;
  timed?: boolean;
  timerRunning?: boolean;
  timerDisabled?: boolean;
  onToggleTimer?: () => void;
  states?: ItsaplanColumn[];
  onStateChange?: (columnId: number) => void;
  stateDisabled?: boolean;
}) {
  const { t } = useTranslation();
  const inner = (
    <CardHeader>
      <CardTitle className="text-base">
        {ticket.identifier}: {ticket.title}
      </CardTitle>
      <CardDescription>
        {ticket.projectName}
        {ticket.priority && (
          <>
            {" · "}
            <span className="inline-flex items-center gap-1">
              <PriorityIcon p={ticket.priority} />
              {priorityLabel(t, ticket.priority)}
            </span>
          </>
        )}
        {ticket.dueDate ? ` · ${new Date(ticket.dueDate).toLocaleDateString()}` : ""}
        {estimate ? ` · ${estimate}` : ""}
      </CardDescription>
    </CardHeader>
  );
  return (
    <Card>
      <div className="row pe-3">
        {ticket.url ? (
          <a href={ticket.url} target="_blank" rel="noreferrer" className="block grow">
            {inner}
          </a>
        ) : (
          <div className="grow">{inner}</div>
        )}
        {states != null && states.length > 0 && (
          <Menu>
            <MenuTrigger asChild>
              <Button
                variant="outlined"
                size="sm"
                disabled={stateDisabled}
                aria-label={t("modules.itsaplan.state")}
              >
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{
                    backgroundColor:
                      states.find((c) => c.id === ticket.columnId)?.color ?? "transparent",
                  }}
                />
                <span className="truncate">
                  {states.find((c) => c.id === ticket.columnId)?.name ?? ticket.column}
                </span>
              </Button>
            </MenuTrigger>
            <MenuContent>
              <MenuRadioGroup
                value={String(ticket.columnId)}
                onValueChange={(v) => onStateChange?.(Number(v))}
              >
                {states.map((c) => (
                  <MenuRadioItem key={c.id} value={String(c.id)}>
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: c.color ?? "transparent" }}
                    />
                    {c.name}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuContent>
          </Menu>
        )}
        {timed && (
          <Button variant="outlined" size="sm" onClick={onToggleTimer} disabled={timerDisabled}>
            {timerRunning ? t("modules.itsaplan.timerPause") : t("modules.itsaplan.timerStart")}
          </Button>
        )}
      </div>
    </Card>
  );
}

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const priorityRank = (p: string | null) => (p ? (PRIORITY_ORDER[p.toLowerCase()] ?? 4) : 5);
// itsaplan priority iconography: TriangleAlert/SignalHigh/Medium/Low + accent colour.
const PRIORITY_META: Record<
  string,
  { icon: ComponentType<{ className?: string; style?: CSSProperties }>; color: string; key: string }
> = {
  urgent: { icon: TriangleAlert, color: "var(--text-danger)", key: "priorityUrgent" },
  high: { icon: SignalHigh, color: "var(--warning)", key: "priorityHigh" },
  medium: { icon: SignalMedium, color: "var(--info)", key: "priorityMedium" },
  low: { icon: SignalLow, color: "var(--text-secondary)", key: "priorityLow" },
};
const priorityLabel = (t: (k: string) => string, p: string | null) => {
  const m = p ? PRIORITY_META[p.toLowerCase()] : undefined;
  if (m) return t(`modules.itsaplan.${m.key}`);
  return p ? p.charAt(0).toUpperCase() + p.slice(1) : "";
};
function PriorityIcon({ p }: { p: string | null }) {
  const m = p ? PRIORITY_META[p.toLowerCase()] : undefined;
  const I = m ? m.icon : Minus;
  return (
    <I
      className="size-4 shrink-0"
      style={{ color: m ? m.color : "var(--text-secondary)" }}
      aria-hidden
    />
  );
}
const formatMinutes = (minutes: number) =>
  `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
const formatClock = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  return `${h}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export function ItsaplanPage() {
  const { t } = useTranslation();
  const api = useApi();
  const modules = useModuleRegistry();
  const status = useConnectorStatus("itsaplan");
  const connected = status.data?.connected === true;
  const boards = useItsaplanBoards(connected);
  const tickets = useItsaplanTickets(connected);
  const updateTicket = useItsaplanUpdateTicket();
  const [boardFilter, setBoardFilter] = useState<Set<string>>(new Set());
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [running, setRunning] = useState<{
    id: number;
    base: number;
    startedAt: number;
    ticket: ItsaplanTicket;
  } | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [running]);

  if (!connected) return <ConnectorPage service="itsaplan" />;

  // EinTime feed (spec eintime FR-014): a saved ticket-timer session also lands
  // as a local eintime entry — after the estimate save attempt, never blocking it.
  const feedEintime = (ticket: ItsaplanTicket, startedAt: number) => {
    if (modules.data?.modules.some((m) => m.id === "eintime") !== true) return;
    api
      .post("/eintime/entries", {
        start: new Date(startedAt).toISOString(),
        end: new Date().toISOString(),
        description: `${ticket.identifier}: ${ticket.title}`,
        provider: "itsaplan",
        projectExternalId: ticket.projectRef,
        taskExternalId: String(ticket.id),
        clientName: ticket.teamName,
        projectName: ticket.projectName,
        taskName: `${ticket.identifier}: ${ticket.title}`,
        origin: "itsaplan",
      })
      .catch((err) => console.warn("eintime feed failed", err));
  };

  const toggleTimer = (ticket: ItsaplanTicket) => {
    if (running) {
      const total = running.base + Math.round((Date.now() - running.startedAt) / 60000);
      updateTicket.mutate({ issueId: running.id, patch: { estimateMinutes: total } });
      feedEintime(running.ticket, running.startedAt);
    }
    setRunning(
      running?.id === ticket.id
        ? null
        : {
            id: ticket.id,
            base: ticket.estimateMinutes ?? 0,
            startedAt: Date.now(),
            ticket,
          },
    );
  };

  const allTickets = tickets.data?.tickets ?? [];
  const estimateBoards = new Map(
    (boards.data?.boards ?? []).map((b) => [b.ref, b.timeEstimateEnabled]),
  );
  const filteredBoards = (boards.data?.boards ?? []).filter(
    (b) => boardFilter.size === 0 || boardFilter.has(b.ref),
  );
  const filteredTickets = allTickets
    .filter(
      (ticket) =>
        (boardFilter.size === 0 || boardFilter.has(ticket.projectRef)) &&
        (priorityFilter === "all" || ticket.priority === priorityFilter),
    )
    .sort(
      (a, b) =>
        priorityRank(a.priority) - priorityRank(b.priority) || a.title.localeCompare(b.title),
    );
  const priorities = [
    ...new Set(allTickets.map((ticket) => ticket.priority).filter((p): p is string => p != null)),
  ].sort();
  const toggleBoard = (ref: string, on: boolean) =>
    setBoardFilter((prev) => {
      const next = new Set(prev);
      if (on) next.add(ref);
      else next.delete(ref);
      return next;
    });

  const listError = boards.error ?? tickets.error ?? updateTicket.error;
  return (
    <div className="stack">
      <div className="row">
        <Menu>
          <MenuTrigger asChild>
            <Button variant="outlined" size="sm">
              {t("modules.itsaplan.boards")}
              {boardFilter.size > 0 ? ` (${boardFilter.size})` : ""}
            </Button>
          </MenuTrigger>
          <MenuContent>
            {(boards.data?.boards ?? []).map((b) => (
              <MenuCheckboxItem
                key={b.id}
                checked={boardFilter.has(b.ref)}
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={(on) => toggleBoard(b.ref, on === true)}
              >
                {b.name}
              </MenuCheckboxItem>
            ))}
          </MenuContent>
        </Menu>
        <Select value={priorityFilter} onValueChange={setPriorityFilter}>
          <SelectTrigger className="w-40" aria-label={t("modules.itsaplan.priority")}>
            <SelectValue placeholder={t("modules.itsaplan.priority")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("modules.itsaplan.priority")}</SelectItem>
            {priorities.map((p) => (
              <SelectItem key={p} value={p}>
                <span className="inline-flex items-center gap-2">
                  <PriorityIcon p={p} />
                  {priorityLabel(t, p)}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outlined"
          size="sm"
          aria-label={t("modules.itsaplan.refresh")}
          onClick={() => void tickets.refetch()}
          disabled={tickets.isFetching}
        >
          <RefreshCw className="size-4" aria-hidden />
        </Button>
      </div>
      {listError && (
        <div className="alert alert--danger">
          {t("modules.itsaplan.error", {
            status: listError instanceof ApiError ? listError.status : "?",
          })}
        </div>
      )}

      <h2 className="text-lg">{t("modules.itsaplan.tickets")}</h2>
      {tickets.isPending && <p className="muted">{t("common.loading")}</p>}
      {tickets.data && filteredTickets.length === 0 && (
        <p className="muted">{t("modules.itsaplan.ticketsEmpty")}</p>
      )}
      {filteredTickets.map((ticket) => {
        const timed = estimateBoards.get(ticket.projectRef) === true;
        const isRunning = running != null && running.id === ticket.id;
        const estimate = !timed
          ? null
          : isRunning
            ? formatClock(running.base * 60 + (now - running.startedAt) / 1000)
            : formatMinutes(ticket.estimateMinutes ?? 0);
        return (
          <TicketRow
            key={ticket.id}
            ticket={ticket}
            estimate={estimate}
            timed={timed}
            timerRunning={isRunning}
            timerDisabled={updateTicket.isPending}
            states={tickets.data?.columns?.[ticket.projectRef]}
            onStateChange={(columnId) =>
              updateTicket.mutate({ issueId: ticket.id, patch: { columnId } })
            }
            stateDisabled={updateTicket.isPending}
            onToggleTimer={() => toggleTimer(ticket)}
          />
        );
      })}

      <h2 className="text-lg">{t("modules.itsaplan.boards")}</h2>
      {boards.isPending && <p className="muted">{t("common.loading")}</p>}
      {boards.data && filteredBoards.length === 0 && (
        <p className="muted">{t("modules.itsaplan.boardsEmpty")}</p>
      )}
      {filteredBoards.map((board) => (
        <BoardRow key={board.id} board={board} />
      ))}
    </div>
  );
}
