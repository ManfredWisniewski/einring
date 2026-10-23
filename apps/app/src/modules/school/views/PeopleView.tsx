import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useSchoolHouseholds,
  useSchoolLinkPerson,
  useSchoolPersons,
  useSchoolSaveHousehold,
  useSchoolSavePerson,
  useSchoolSetMembers,
  useSchoolUsers,
} from "@/api/hooks";
import type { SchoolPersonKind } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** People administration: persons, login links, households (admin only). */
export default function PeopleView({ admin }: { admin: boolean }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<SchoolPersonKind | "all">("all");
  const persons = useSchoolPersons(kind === "all" ? null : kind);
  const households = useSchoolHouseholds();
  const [form, setForm] = useState<"person" | "household" | "members" | null>(null);

  return (
    <div className="stack">
      <div className="row">
        <Select value={kind} onValueChange={(v) => setKind(v as SchoolPersonKind | "all")}>
          <SelectTrigger aria-label={t("modules.school.people.filterKind")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("modules.school.people.all")}</SelectItem>
            {(["student", "guardian", "teacher", "staff"] as const).map((k) => (
              <SelectItem key={k} value={k}>
                {t(`modules.school.kind.${k}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {admin && (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setForm(form === "person" ? null : "person")}
            >
              {t("modules.school.people.newPerson")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setForm(form === "household" ? null : "household")}
            >
              {t("modules.school.people.newHousehold")}
            </Button>
          </>
        )}
      </div>

      {form === "person" && admin && <PersonForm onDone={() => setForm(null)} />}
      {form === "household" && admin && <HouseholdForm onDone={() => setForm(null)} />}

      <ul className="stack" style={{ gap: "var(--space-1)" }}>
        {(persons.data?.persons ?? []).map((p) => (
          <li key={p.id} className="row">
            <strong>{p.name}</strong>
            <span className="muted">{t(`modules.school.kind.${p.kind}`)}</span>
            {p.email && <span className="muted">{p.email}</span>}
            {admin && <LinkPicker personId={p.id} sub={p.sub} />}
          </li>
        ))}
      </ul>

      <h3>{t("modules.school.people.households")}</h3>
      <ul className="stack" style={{ gap: "var(--space-2)" }}>
        {(households.data?.households ?? []).map((h) => (
          <li key={h.id}>
            <div className="row">
              <strong>{h.name}</strong>
              {(h.discountPct ?? h.discount_pct ?? 0) > 0 && (
                <span className="muted">
                  {t("modules.school.people.discount", {
                    pct: h.discountPct ?? h.discount_pct,
                  })}
                </span>
              )}
              {admin && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setForm(form === `members:${h.id}` ? null : (`members:${h.id}` as "members"))
                  }
                >
                  {t("modules.school.people.editMembers")}
                </Button>
              )}
            </div>
            <ul className="muted">
              {(h.members ?? []).map((m) => (
                <li key={m.personId}>
                  {m.name ?? m.personId} — {t(`modules.school.relation.${m.relation}`)}
                </li>
              ))}
            </ul>
            {form === (`members:${h.id}` as string) && admin && (
              <MembersForm householdId={h.id} onDone={() => setForm(null)} />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PersonForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const save = useSchoolSavePerson();
  const [kind, setKind] = useState<SchoolPersonKind>("student");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [billing, setBilling] = useState("none");
  const [cents, setCents] = useState("");

  return (
    <div className="stack">
      <div className="row">
        <Select value={kind} onValueChange={(v) => setKind(v as SchoolPersonKind)}>
          <SelectTrigger aria-label={t("modules.school.people.filterKind")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["student", "guardian", "teacher", "staff"] as const).map((k) => (
              <SelectItem key={k} value={k}>
                {t(`modules.school.kind.${k}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          placeholder={t("modules.school.form.name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          placeholder={t("modules.school.form.email")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      {kind === "student" && (
        <div className="row">
          <Select value={billing} onValueChange={setBilling}>
            <SelectTrigger aria-label={t("modules.school.billing.mode")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["none", "flat", "per_lesson", "per_scheduled"] as const).map((b) => (
                <SelectItem key={b} value={b}>
                  {t(`modules.school.billing.${b}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="number"
            min={0}
            placeholder={t("modules.school.billing.cents")}
            value={cents}
            onChange={(e) => setCents(e.target.value)}
          />
        </div>
      )}
      <div className="row">
        <Button
          size="sm"
          disabled={save.isPending || !name}
          onClick={() =>
            void save
              .mutateAsync({
                body: {
                  kind,
                  name,
                  email: email || undefined,
                  billingMode: billing,
                  flatCents: billing === "flat" ? Number(cents) || 0 : undefined,
                  lessonCents:
                    billing === "per_lesson" || billing === "per_scheduled"
                      ? Number(cents) || 0
                      : undefined,
                },
              })
              .then(onDone)
          }
        >
          {t("modules.school.form.save")}
        </Button>
      </div>
    </div>
  );
}

/** Links a login (`sub`) to a person profile — enables portal access. */
function LinkPicker({ personId, sub }: { personId: string; sub: string | null }) {
  const { t } = useTranslation();
  const users = useSchoolUsers();
  const link = useSchoolLinkPerson();
  if (sub) return <span className="muted">{t("modules.school.people.linked")}</span>;
  return (
    <Select onValueChange={(v) => link.mutate({ id: personId, sub: v })}>
      <SelectTrigger aria-label={t("modules.school.people.link")} className="w-48">
        <SelectValue placeholder={t("modules.school.people.link")} />
      </SelectTrigger>
      <SelectContent>
        {(users.data?.users ?? [])
          .filter((u) => !u.personId)
          .map((u) => (
            <SelectItem key={u.sub} value={u.sub}>
              {u.name ?? u.sub}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}

function HouseholdForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const save = useSchoolSaveHousehold();
  const [name, setName] = useState("");
  const [discount, setDiscount] = useState("0");
  return (
    <div className="row">
      <Input
        placeholder={t("modules.school.people.householdName")}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Label>{t("modules.school.people.discountPct")}</Label>
      <Input
        type="number"
        min={0}
        max={100}
        value={discount}
        onChange={(e) => setDiscount(e.target.value)}
      />
      <Button
        size="sm"
        disabled={save.isPending || !name}
        onClick={() =>
          void save.mutateAsync({ body: { name, discountPct: Number(discount) || 0 } }).then(onDone)
        }
      >
        {t("modules.school.form.save")}
      </Button>
    </div>
  );
}

function MembersForm({ householdId, onDone }: { householdId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const persons = useSchoolPersons(null);
  const set = useSchoolSetMembers();
  const [picked, setPicked] = useState<{ personId: string; relation: "guardian" | "student" }[]>(
    [],
  );
  return (
    <div className="stack" style={{ gap: "var(--space-2)" }}>
      {(persons.data?.persons ?? [])
        .filter((p) => p.kind === "student" || p.kind === "guardian")
        .map((p) => (
          <label key={p.id} className="row">
            <input
              type="checkbox"
              checked={picked.some((m) => m.personId === p.id)}
              onChange={(e) =>
                setPicked(
                  e.target.checked
                    ? [
                        ...picked,
                        { personId: p.id, relation: p.kind === "student" ? "student" : "guardian" },
                      ]
                    : picked.filter((m) => m.personId !== p.id),
                )
              }
            />
            {p.name}
          </label>
        ))}
      <Button
        size="sm"
        disabled={set.isPending}
        onClick={() => void set.mutateAsync({ id: householdId, members: picked }).then(onDone)}
      >
        {t("modules.school.form.save")}
      </Button>
    </div>
  );
}
