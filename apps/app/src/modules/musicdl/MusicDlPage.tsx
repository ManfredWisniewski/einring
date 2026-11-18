import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "~/api/client";
import { useModuleRegistry, useMusicdlJobs, useSubmitMusicdl } from "~/api/hooks";
import type { MusicdlJob } from "~/api/types";

const YT_LINK = /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i;

function JobCard({ job }: { job: MusicdlJob }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{job.url}</CardTitle>
        <CardDescription>
          {t(`modules.musicdl.state_${job.state}`)}
          {job.total > 0
            ? ` — ${t("modules.musicdl.progress", { done: job.done, total: job.total })}`
            : ""}
        </CardDescription>
      </CardHeader>
      {job.error ? (
        <CardContent>
          <p className="alert alert--danger">{job.error}</p>
        </CardContent>
      ) : null}
      {job.items.length > 0 ? (
        <CardContent>
          <ul className="status-list">
            {job.items.map((item, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: job items are append-only and never reorder
              <li className="status-item" key={i}>
                <span>{item.title || item.url}</span>
                <span className="muted">
                  {item.ok
                    ? item.deduped
                      ? t("modules.musicdl.item_deduped")
                      : t("modules.musicdl.item_ok")
                    : (item.error ?? t("modules.musicdl.item_failed"))}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      ) : null}
    </Card>
  );
}

export function MusicDlPage() {
  const { t } = useTranslation();
  const urlId = useId();
  const [url, setUrl] = useState("");
  const [clientError, setClientError] = useState<string | null>(null);
  const jobs = useMusicdlJobs();
  const submit = useSubmitMusicdl();
  const registry = useModuleRegistry();
  const einmusicEnabled = registry.data?.modules.some((m) => m.id === "einmusic");

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setClientError(null);
    if (!YT_LINK.test(url.trim())) {
      setClientError(t("modules.musicdl.invalidUrl"));
      return;
    }
    submit.mutate(url.trim(), {
      onSuccess: () => setUrl(""),
      onError: (err) =>
        setClientError(err instanceof ApiError ? err.message : t("modules.musicdl.submitError")),
    });
  };

  return (
    <div className="stack">
      <h2 className="text-lg">{t("modules.musicdl.title")}</h2>
      <p className="muted">{t("modules.musicdl.intro")}</p>
      <form className="row" onSubmit={onSubmit}>
        <Label htmlFor={urlId} className="sr-only">
          {t("modules.musicdl.urlLabel")}
        </Label>
        <Input
          id={urlId}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t("modules.musicdl.urlPlaceholder")}
          aria-label={t("modules.musicdl.urlLabel")}
        />
        <Button type="submit" disabled={submit.isPending || !url.trim()}>
          {submit.isPending ? t("modules.musicdl.submitting") : t("modules.musicdl.submit")}
        </Button>
      </form>
      {clientError ? <p className="alert alert--danger">{clientError}</p> : null}
      {einmusicEnabled ? (
        <Link to="/einmusic" className={buttonVariants({ variant: "outlined" })}>
          {t("modules.musicdl.openLibrary")}
        </Link>
      ) : null}
      <div className="stack">
        <h3 className="text-base">{t("modules.musicdl.jobs")}</h3>
        {jobs.data?.jobs.length ? (
          jobs.data.jobs.map((job) => <JobCard key={job.id} job={job} />)
        ) : (
          <p className="muted">{t("modules.musicdl.empty")}</p>
        )}
      </div>
    </div>
  );
}
