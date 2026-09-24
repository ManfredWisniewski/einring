import { Browser } from "@capacitor/browser";
import { useEffect, useRef, useState } from "react";
import { Button } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { usePollLoginFlow, useStartLoginFlow } from "@/api/hooks";
import { isNative } from "@/config";

const POLL_INTERVAL_MS = 2000;

async function openLogin(url: string) {
  if (isNative) await Browser.open({ url });
  else window.open(url, "_blank", "noopener");
}

/** "Connect Nextcloud" card: starts Login Flow v2 via the BFF and polls until Nextcloud reports success. */
export function NextcloudConnect() {
  const { t } = useTranslation();
  const start = useStartLoginFlow();
  const poll = usePollLoginFlow();
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!loginUrl) return;
    timer.current = setInterval(() => {
      if (!poll.isPending) poll.mutate();
    }, POLL_INTERVAL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [loginUrl, poll]);

  useEffect(() => {
    if (poll.data?.status === "connected") {
      setLoginUrl(null);
      if (isNative) void Browser.close().catch(() => {});
    }
  }, [poll.data]);

  const begin = async () => {
    const { login } = await start.mutateAsync();
    setLoginUrl(login);
    await openLogin(login);
  };

  return (
    <section className="card stack">
      <h2>{t("nextcloud.title")}</h2>
      {loginUrl ? (
        <>
          <p className="muted">{t("nextcloud.waiting")}</p>
          <div className="row">
            <Button className="btn" onPress={() => openLogin(loginUrl)}>
              {t("nextcloud.openAgain")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p>{t("nextcloud.notConnected")}</p>
          <div className="row">
            <Button className="btn btn--primary" onPress={begin} isDisabled={start.isPending}>
              {t("nextcloud.connect")}
            </Button>
          </div>
        </>
      )}
      {start.isError && <p className="text-danger">{String(start.error)}</p>}
    </section>
  );
}
