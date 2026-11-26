import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Menu, MenuCheckboxItem, MenuContent, MenuTrigger } from "@/components/ui/menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiError } from "~/api/client";
import { useConnectorStatus, useItsaplanBoards, useItsaplanTickets } from "~/api/hooks";
import type { ItsaplanBoard, ItsaplanTicket } from "~/api/types";
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

function TicketRow({ ticket }: { ticket: ItsaplanTicket }) {
  const inner = (
    <CardHeader>
      <CardTitle className="text-base">
        {ticket.identifier}: {ticket.title}
      </CardTitle>
      <CardDescription>
        {ticket.projectName}
        {ticket.column ? ` · ${ticket.column}` : ""}
        {ticket.priority ? ` · ${ticket.priority}` : ""}
        {ticket.dueDate ? ` · ${new Date(ticket.dueDate).toLocaleDateString()}` : ""}
      </CardDescription>
    </CardHeader>
  );
  return (
    <Card>
      {ticket.url ? (
        <a href={ticket.url} target="_blank" rel="noreferrer" className="block">
          {inner}
        </a>
      ) : (
        inner
      )}
    </Card>
  );
}

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const priorityRank = (p: string | null) => (p ? (PRIORITY_ORDER[p.toLowerCase()] ?? 4) : 5);

export function ItsaplanPage() {
  const { t } = useTranslation();
  const status = useConnectorStatus("itsaplan");
  const connected = status.data?.connected === true;
  const boards = useItsaplanBoards(connected);
  const tickets = useItsaplanTickets(connected);
  const [boardFilter, setBoardFilter] = useState<Set<string>>(new Set());
  const [priorityFilter, setPriorityFilter] = useState("all");

  if (!connected) return <ConnectorPage service="itsaplan" />;

  const allTickets = tickets.data?.tickets ?? [];
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

  const listError = boards.error ?? tickets.error;
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
                {p}
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
      {filteredTickets.map((ticket) => (
        <TicketRow key={ticket.id} ticket={ticket} />
      ))}

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
