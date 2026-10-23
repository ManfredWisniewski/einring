import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useSchoolAddPayment,
  useSchoolGenerateInvoices,
  useSchoolInstruments,
  useSchoolInvoice,
  useSchoolInvoicePdf,
  useSchoolInvoices,
  useSchoolPatchInvoice,
  useSchoolRentals,
} from "@/api/hooks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { currentPeriod, fmtCents, fmtDate } from "./shared";

/** Invoices + instruments/rentals. Parents see only their household (server scope). */
export default function BillingView({ admin }: { admin: boolean }) {
  const { t, i18n } = useTranslation();
  const [period, setPeriod] = useState(currentPeriod());
  const invoices = useSchoolInvoices(period);
  const generate = useSchoolGenerateInvoices();
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="stack">
      <div className="row">
        <Input
          type="month"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          aria-label={t("modules.school.billing.period")}
        />
        {admin && (
          <Button
            size="sm"
            variant="outline"
            disabled={generate.isPending}
            onClick={() => void generate.mutateAsync(period)}
          >
            {t("modules.school.billing.generate")}
          </Button>
        )}
        {generate.isSuccess && (
          <span className="muted">
            {t("modules.school.billing.generated", {
              created: generate.data.created,
              skipped: generate.data.skipped,
            })}
          </span>
        )}
      </div>

      <ul className="stack" style={{ gap: "var(--space-2)" }}>
        {(invoices.data?.invoices ?? []).map((inv) => (
          <li key={inv.id}>
            <button
              type="button"
              className="linklike"
              onClick={() => setOpen(open === inv.id ? null : inv.id)}
            >
              <strong>{inv.number}</strong>{" "}
              <span className="muted">
                {inv.householdName} · {inv.period} ·{" "}
                {t(`modules.school.invoiceStatus.${inv.status}`)}
              </span>{" "}
              {fmtCents(inv.totalCents, i18n.language)}
            </button>
            {open === inv.id && <InvoiceDetail id={inv.id} admin={admin} />}
          </li>
        ))}
        {invoices.data && invoices.data.invoices.length === 0 && (
          <li className="muted">{t("modules.school.billing.empty")}</li>
        )}
      </ul>

      {admin && <InstrumentsSection />}
    </div>
  );
}

function InvoiceDetail({ id, admin }: { id: string; admin: boolean }) {
  const { t, i18n } = useTranslation();
  const detail = useSchoolInvoice(id);
  const patch = useSchoolPatchInvoice();
  const pay = useSchoolAddPayment();
  const pdf = useSchoolInvoicePdf();
  const [amount, setAmount] = useState("");
  const inv = detail.data?.invoice;
  if (!inv) return <p className="muted">{t("common.loading")}</p>;

  return (
    <div className="stack" style={{ gap: "var(--space-2)" }}>
      <ul className="muted">
        {inv.lines.map((l) => (
          <li key={l.id}>
            {l.description} — {fmtCents(l.amountCents, i18n.language)}
          </li>
        ))}
      </ul>
      <p className="muted">
        {t("modules.school.billing.due")}: {fmtDate(inv.dueDate, i18n.language)}
      </p>
      {inv.payments.map((p) => (
        <p key={p.id} className="muted">
          {t("modules.school.billing.payment")} {fmtDate(p.paidAt, i18n.language)}:{" "}
          {fmtCents(p.amountCents, i18n.language)}
        </p>
      ))}
      <div className="row">
        <Button
          size="sm"
          variant="outline"
          disabled={pdf.isPending}
          onClick={() => pdf.mutate({ id: inv.id, number: inv.number })}
        >
          {t("modules.school.billing.pdf")}
        </Button>
        {admin && inv.status === "draft" && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => patch.mutate({ id: inv.id, body: { status: "issued" } })}
          >
            {t("modules.school.billing.issue")}
          </Button>
        )}
        {admin && inv.status !== "paid" && inv.status !== "cancelled" && (
          <>
            <Input
              type="number"
              min={0}
              placeholder={t("modules.school.billing.cents")}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={pay.isPending || !amount}
              onClick={() => pay.mutate({ id: inv.id, amountCents: Number(amount) })}
            >
              {t("modules.school.billing.recordPayment")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function InstrumentsSection() {
  const { t, i18n } = useTranslation();
  const instruments = useSchoolInstruments();
  const rentals = useSchoolRentals();
  return (
    <div className="stack">
      <h3>{t("modules.school.instruments.title")}</h3>
      <ul className="muted">
        {(instruments.data?.instruments ?? []).map((i) => (
          <li key={i.id}>
            {i.name}
            {(i.serialNo ?? i.serial_no) ? ` (${i.serialNo ?? i.serial_no})` : ""} —{" "}
            {t(`modules.school.instruments.status.${i.status}`, {
              defaultValue: i.status,
            })}{" "}
            · {fmtCents(i.monthlyRateCents ?? i.monthly_rate_cents, i18n.language)}
          </li>
        ))}
      </ul>
      <h3>{t("modules.school.rentals.title")}</h3>
      <ul className="muted">
        {(rentals.data?.rentals ?? []).map((r) => (
          <li key={r.id}>
            {r.instrumentName ?? r.instrumentId ?? r.instrument_id} →{" "}
            {r.studentName ?? r.studentId ?? r.student_id} ({r.startDate ?? r.start_date}
            {(r.endDate ?? r.end_date) ? ` – ${r.endDate ?? r.end_date}` : ""})
          </li>
        ))}
      </ul>
    </div>
  );
}
