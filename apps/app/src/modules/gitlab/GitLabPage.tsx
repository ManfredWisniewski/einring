import { useTranslation } from "react-i18next";
import { ApiError } from "@/api/client";
import { useConnectorDisconnect, useConnectorStatus, useGitLabTodos } from "@/api/hooks";
import type { GitLabTodo } from "@/api/types";
import { ConnectorPage } from "@/components/ConnectorPage";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** One pending todo — clicking opens the upstream target (MR, issue, pipeline). */
function TodoRow({ todo }: { todo: GitLabTodo }) {
  const inner = (
    <CardHeader>
      <CardTitle className="text-base">
        {todo.action}: {todo.title}
      </CardTitle>
      <CardDescription>
        {todo.targetType}
        {todo.project ? ` · ${todo.project}` : ""}
        {todo.author ? ` · ${todo.author}` : ""}
        {todo.createdAt ? ` · ${new Date(todo.createdAt).toLocaleString()}` : ""}
      </CardDescription>
    </CardHeader>
  );
  return (
    <Card>
      {todo.url ? (
        <a href={todo.url} target="_blank" rel="noreferrer" className="block">
          {inner}
        </a>
      ) : (
        inner
      )}
    </Card>
  );
}

export function GitLabPage() {
  const { t } = useTranslation();
  const status = useConnectorStatus("gitlab");
  const disconnect = useConnectorDisconnect("gitlab");
  const connected = status.data?.connected === true;
  const todos = useGitLabTodos(connected);

  if (!connected) return <ConnectorPage service="gitlab" />;

  return (
    <div className="stack">
      <div className="row einhub-header">
        <p className="muted">{t("modules.gitlab.connectedAs", { url: status.data?.url })}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => disconnect.mutate()}
          disabled={disconnect.isPending}
        >
          {disconnect.isPending
            ? t("modules.gitlab.disconnecting")
            : t("modules.gitlab.disconnect")}
        </Button>
      </div>
      {todos.isPending && <p className="muted">{t("common.loading")}</p>}
      {todos.isError && (
        <div className="alert alert--danger">
          {t("modules.gitlab.error", {
            status: todos.error instanceof ApiError ? todos.error.status : "?",
          })}
        </div>
      )}
      {todos.data?.todos.length === 0 && <p className="muted">{t("modules.gitlab.empty")}</p>}
      {todos.data?.todos.map((todo) => (
        <TodoRow key={todo.id} todo={todo} />
      ))}
    </div>
  );
}
