import { Browser } from "@capacitor/browser";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePollLoginFlow, useStartLoginFlow } from "@/api/hooks";
import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { isNative } from "@/config";
import { useInstanceName } from "@/instance";

const POLL_INTERVAL_MS = 2000;

async function openLogin(url: string) {
  if (isNative) await Browser.open({ url });
  else window.open(url, "_blank", "noopener");
}

/** "Connect Nextcloud" card: starts Login Flow v2 via the BFF and polls until Nextcloud reports success. */
export function NextcloudConnect() {
  const { t } = useTranslation();
  const name = useInstanceName();
  const { setSession } = useAuth();
  const start = useStartLoginFlow();
  const poll = usePollLoginFlow();
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  /** Anonymous (embedded) flows get a flow id that must be echoed on each poll. */
  const [flowId, setFlowId] = useState<string | undefined>();
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!loginUrl) return;
    timer.current = setInterval(() => {
      if (!poll.isPending) poll.mutate(flowId);
    }, POLL_INTERVAL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [loginUrl, poll, flowId]);

  useEffect(() => {
    if (poll.data?.status === "connected") {
      setLoginUrl(null);
      if (isNative) void Browser.close().catch(() => {});
      // Anonymous embedded flow: adopt the minted session as our auth.
      if (poll.data.sessionToken) void setSession(poll.data.sessionToken);
    }
  }, [poll.data, setSession]);

  const begin = async () => {
    const { login, flow } = await start.mutateAsync();
    setFlowId(flow);
    setLoginUrl(login);
    await openLogin(login);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("nextcloud.title")}</CardTitle>
      </CardHeader>
      <CardContent className="stack">
        {loginUrl ? (
          <>
            <p className="muted">{t("nextcloud.waiting")}</p>
            <div className="row">
              <Button variant="outline" onClick={() => openLogin(loginUrl)}>
                {t("nextcloud.openAgain")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p>{t("nextcloud.notConnected", { name })}</p>
            <div className="row">
              <Button onClick={() => void begin()} disabled={start.isPending}>
                {t("nextcloud.connect")}
              </Button>
            </div>
          </>
        )}
        {start.isError && <p className="text-danger">{String(start.error)}</p>}
      </CardContent>
    </Card>
  );
}
