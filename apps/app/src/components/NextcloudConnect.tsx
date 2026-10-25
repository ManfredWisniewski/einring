import { Browser } from "@capacitor/browser";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useClaimLoginFlow, usePollLoginFlow, useStartLoginFlow } from "@/api/hooks";
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

/** "Connect Nextcloud" card: starts Login Flow v2 via the BFF, polls until Nextcloud
 *  reports success, then asks for the claim code dropped into the user's own files. */
export function NextcloudConnect() {
  const { t } = useTranslation();
  const name = useInstanceName();
  const { setSession } = useAuth();
  const start = useStartLoginFlow();
  const poll = usePollLoginFlow();
  const claim = useClaimLoginFlow();
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [flowId, setFlowId] = useState<string | undefined>();
  const [awaitingClaim, setAwaitingClaim] = useState(false);
  const [code, setCode] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!loginUrl || awaitingClaim || !flowId) return;
    timer.current = setInterval(() => {
      if (!poll.isPending) poll.mutate(flowId);
    }, POLL_INTERVAL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [loginUrl, poll, flowId, awaitingClaim]);

  useEffect(() => {
    const data = poll.data ?? claim.data;
    if (poll.data?.status === "awaiting_claim") {
      setAwaitingClaim(true);
      if (timer.current) clearInterval(timer.current);
    }
    if (data?.status === "connected") {
      setLoginUrl(null);
      setAwaitingClaim(false);
      if (isNative) void Browser.close().catch(() => {});
      // Anonymous embedded flow: adopt the minted session as our auth.
      if (data.sessionToken) void setSession(data.sessionToken);
    }
  }, [poll.data, claim.data, setSession]);

  const begin = async () => {
    const { login, flow } = await start.mutateAsync();
    setFlowId(flow);
    setLoginUrl(login);
    await openLogin(login);
  };

  const submitCode = () => {
    if (flowId && code.trim()) claim.mutate({ flow: flowId, code: code.trim() });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("nextcloud.title")}</CardTitle>
      </CardHeader>
      <CardContent className="stack">
        {awaitingClaim ? (
          <>
            <p className="muted">{t("nextcloud.claimHint")}</p>
            <div className="row">
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                placeholder={t("nextcloud.claimPlaceholder")}
              />
              <Button onClick={submitCode} disabled={claim.isPending || code.length !== 6}>
                {t("nextcloud.claim")}
              </Button>
            </div>
            {claim.isError && <p className="text-danger">{t("nextcloud.claimFailed")}</p>}
          </>
        ) : loginUrl ? (
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
