import { Capacitor, registerPlugin } from "@capacitor/core";
import { useCallback, useEffect, useState } from "react";
import { Tab, TabList, TabPanel, Tabs } from "react-aria-components";
import { useTranslation } from "react-i18next";
import {
  useDeleteEinDavContact,
  useDeleteEinDavEvent,
  useDeleteEinDavFile,
  useDownloadEinDavFile,
  useEinDavAddressbooks,
  useEinDavCalendars,
  useEinDavContacts,
  useEinDavEvents,
  useEinDavFiles,
  useMkdirEinDav,
  useSaveEinDavContact,
  useSaveEinDavEvent,
  useUploadEinDavFile,
} from "@/api/hooks";
import type { EinDavContact, EinDavEvent } from "@/api/types";
import { NextcloudGate } from "@/components/NextcloudGate";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

interface DirtyContact {
  id: number;
  uid: string | null;
  fn: string;
  emails: string[];
  tels: string[];
  note: string | null;
}

interface DirtyEvent {
  id: number;
  uid: string | null;
  summary: string;
  description: string | null;
  location: string | null;
  start: string;
  end: string;
  allDay: boolean;
}

interface EinDavPlugin {
  syncContacts(options: {
    account: string;
    contacts: {
      uid: string | null;
      fn: string;
      emails: string[];
      tels: string[];
      note: string | null;
    }[];
  }): Promise<{ synced: number }>;
  syncEvents(options: {
    account: string;
    calendar: string;
    events: {
      uid: string | null;
      summary: string;
      description: string | null;
      location: string | null;
      start: string;
      end: string;
      allDay: boolean;
    }[];
  }): Promise<{ synced: number }>;
  pullChanges(options: {
    account: string;
  }): Promise<{ contacts: DirtyContact[]; events: DirtyEvent[] }>;
  markClean(options: {
    contacts: { id: number; uid: string }[];
    events: { id: number; uid: string }[];
  }): Promise<void>;
  requestSync(options: { account: string }): Promise<void>;
  addListener(event: "syncRequested", cb: () => void): Promise<{ remove: () => Promise<void> }>;
}

const OBJECT_UID = /([^/]+)\.(vcf|ics)$/;

/** Present only in the Android WebView — the plugin is registered natively (D54). */
const einDavNative = Capacitor.isNativePlatform() ? registerPlugin<EinDavPlugin>("EinDav") : null;

function saveTextFile(name: string, mime: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const fmtSize = (n: number | null) => {
  if (n === null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
};

const csv = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

// -- Contacts -----------------------------------------------------------------

interface ContactForm {
  href?: string;
  uid?: string;
  fn: string;
  emails: string;
  tels: string;
  note: string;
}

const emptyContact = (): ContactForm => ({ fn: "", emails: "", tels: "", note: "" });

function ContactsPanel() {
  const { t } = useTranslation();
  const books = useEinDavAddressbooks();
  const [book, setBook] = useState<string | null>(null);
  const [form, setForm] = useState<ContactForm | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const contacts = useEinDavContacts(book);
  const save = useSaveEinDavContact();
  const del = useDeleteEinDavContact();

  useEffect(() => {
    if (!book && books.data?.addressbooks.length) {
      setBook(books.data.addressbooks[0]?.href ?? null);
    }
  }, [books.data, book]);

  const submit = async () => {
    if (!form || !book) return;
    await save.mutateAsync({
      book,
      href: form.href,
      uid: form.uid,
      fn: form.fn,
      emails: csv(form.emails),
      tels: csv(form.tels),
      note: form.note || undefined,
    });
    setForm(null);
  };

  /** Two-way: pull device-side dirty contacts up to the BFF, then push server state down (D54). */
  const syncNow = useCallback(async () => {
    if (!einDavNative || !book) return;
    const pulled = await einDavNative.pullChanges({ account: "einring" });
    const clean: { id: number; uid: string }[] = [];
    for (const dc of pulled.contacts) {
      const match = dc.uid ? contacts.data?.contacts.find((c) => c.uid === dc.uid) : undefined;
      const res = await save.mutateAsync({
        book,
        href: match?.href,
        uid: dc.uid ?? undefined,
        fn: dc.fn,
        emails: dc.emails,
        tels: dc.tels,
        note: dc.note ?? undefined,
      });
      const uid = dc.uid ?? OBJECT_UID.exec(res.href)?.[1];
      if (uid) clean.push({ id: dc.id, uid });
    }
    if (clean.length) await einDavNative.markClean({ contacts: clean, events: [] });
    const fresh = await contacts.refetch();
    const res = await einDavNative.syncContacts({
      account: "einring",
      contacts: (fresh.data?.contacts ?? []).map((c: EinDavContact) => ({
        uid: c.uid,
        fn: c.fn,
        emails: c.emails,
        tels: c.tels,
        note: c.note,
      })),
    });
    setSyncMsg(t("modules.eindav.synced", { count: res.synced }));
  }, [book, contacts, save, t]);

  useEffect(() => {
    if (!einDavNative) return;
    const handle = einDavNative.addListener("syncRequested", () => void syncNow());
    return () => {
      void handle.then((h) => h.remove());
    };
  }, [syncNow]);

  return (
    <div className="stack">
      <div className="row">
        {books.data && books.data.addressbooks.length > 1 && (
          <Select value={book ?? undefined} onValueChange={setBook}>
            <SelectTrigger aria-label={t("modules.eindav.addressbook")} className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {books.data.addressbooks.map((b) => (
                <SelectItem key={b.href} value={b.href}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button size="sm" onClick={() => setForm(emptyContact())} disabled={!book}>
          {t("modules.eindav.newContact")}
        </Button>
        {einDavNative && (
          <Button size="sm" variant="secondary" onClick={() => void syncNow()}>
            {t("modules.eindav.syncContacts")}
          </Button>
        )}
      </div>
      {syncMsg && <p className="muted">{syncMsg}</p>}
      {form && (
        <Card>
          <CardHeader>
            <CardTitle>
              {form.href ? t("modules.eindav.editContact") : t("modules.eindav.newContact")}
            </CardTitle>
          </CardHeader>
          <CardContent className="stack">
            <Input
              placeholder={t("modules.eindav.fieldName")}
              value={form.fn}
              onChange={(e) => setForm({ ...form, fn: e.currentTarget.value })}
            />
            <Input
              placeholder={t("modules.eindav.fieldEmails")}
              value={form.emails}
              onChange={(e) => setForm({ ...form, emails: e.currentTarget.value })}
            />
            <Input
              placeholder={t("modules.eindav.fieldPhones")}
              value={form.tels}
              onChange={(e) => setForm({ ...form, tels: e.currentTarget.value })}
            />
            <Textarea
              placeholder={t("modules.eindav.fieldNote")}
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.currentTarget.value })}
            />
            <div className="row">
              <Button size="sm" onClick={() => void submit()} disabled={!form.fn || save.isPending}>
                {t("modules.eindav.save")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setForm(null)}>
                {t("modules.eindav.cancel")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      <ul className="eindav-list">
        {(contacts.data?.contacts ?? []).map((c) => (
          <li key={c.href} className="eindav-row">
            <div className="eindav-row__main">
              <strong>{c.fn}</strong>
              <span className="muted">{[...c.emails, ...c.tels].join(" · ")}</span>
            </div>
            <div className="row">
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setForm({
                    href: c.href,
                    uid: c.uid ?? undefined,
                    fn: c.fn,
                    emails: c.emails.join(", "),
                    tels: c.tels.join(", "),
                    note: c.note ?? "",
                  })
                }
              >
                {t("modules.eindav.edit")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => saveTextFile(`${c.fn || "contact"}.vcf`, "text/vcard", c.vcard)}
              >
                {t("modules.eindav.export")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => del.mutate(c.href)}>
                {t("modules.eindav.delete")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {contacts.data?.contacts.length === 0 && (
        <p className="muted">{t("modules.eindav.emptyContacts")}</p>
      )}
    </div>
  );
}

// -- Calendar -----------------------------------------------------------------

interface EventForm {
  href?: string;
  uid?: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  description: string;
}

const monthRange = () => {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
};

function CalendarPanel() {
  const { t } = useTranslation();
  const cals = useEinDavCalendars();
  const [cal, setCal] = useState<string | null>(null);
  const [range, setRange] = useState(monthRange);
  const [form, setForm] = useState<EventForm | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const events = useEinDavEvents(cal, range.from, range.to);
  const save = useSaveEinDavEvent();
  const del = useDeleteEinDavEvent();

  useEffect(() => {
    if (!cal && cals.data?.calendars.length) {
      setCal(cals.data.calendars[0]?.href ?? null);
    }
  }, [cals.data, cal]);

  const submit = async () => {
    if (!form || !cal) return;
    await save.mutateAsync({
      cal,
      href: form.href,
      uid: form.uid,
      summary: form.summary,
      description: form.description || undefined,
      location: form.location || undefined,
      start: form.start,
      end: form.end || undefined,
    });
    setForm(null);
  };

  /** Two-way: pull device-side dirty events up to the BFF, then push server state down (D54). */
  const syncNow = useCallback(async () => {
    if (!einDavNative || !cal) return;
    const name = cals.data?.calendars.find((c) => c.href === cal)?.name ?? "einring";
    const pulled = await einDavNative.pullChanges({ account: "einring" });
    const clean: { id: number; uid: string }[] = [];
    for (const de of pulled.events) {
      const match = de.uid ? events.data?.events.find((e) => e.uid === de.uid) : undefined;
      const res = await save.mutateAsync({
        cal,
        href: match?.href,
        uid: de.uid ?? undefined,
        summary: de.summary,
        description: de.description ?? undefined,
        location: de.location ?? undefined,
        start: de.start,
        end: de.end || undefined,
      });
      const uid = de.uid ?? OBJECT_UID.exec(res.href)?.[1];
      if (uid) clean.push({ id: de.id, uid });
    }
    if (clean.length) await einDavNative.markClean({ contacts: [], events: clean });
    const fresh = await events.refetch();
    const res = await einDavNative.syncEvents({
      account: "einring",
      calendar: name,
      events: (fresh.data?.events ?? []).map((e: EinDavEvent) => ({
        uid: e.uid,
        summary: e.summary,
        description: e.description,
        location: e.location,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
      })),
    });
    setSyncMsg(t("modules.eindav.synced", { count: res.synced }));
  }, [cal, cals.data, events, save, t]);

  useEffect(() => {
    if (!einDavNative) return;
    const handle = einDavNative.addListener("syncRequested", () => void syncNow());
    return () => {
      void handle.then((h) => h.remove());
    };
  }, [syncNow]);

  return (
    <div className="stack">
      <div className="row">
        {cals.data && cals.data.calendars.length > 1 && (
          <Select value={cal ?? undefined} onValueChange={setCal}>
            <SelectTrigger aria-label={t("modules.eindav.calendar")} className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {cals.data.calendars.map((c) => (
                <SelectItem key={c.href} value={c.href}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Input
          type="date"
          aria-label={t("modules.eindav.from")}
          value={range.from}
          onChange={(e) => setRange({ ...range, from: e.currentTarget.value })}
        />
        <Input
          type="date"
          aria-label={t("modules.eindav.to")}
          value={range.to}
          onChange={(e) => setRange({ ...range, to: e.currentTarget.value })}
        />
        <Button
          size="sm"
          onClick={() =>
            setForm({
              summary: "",
              start: `${range.from}T09:00`,
              end: `${range.from}T10:00`,
              allDay: false,
              location: "",
              description: "",
            })
          }
          disabled={!cal}
        >
          {t("modules.eindav.newEvent")}
        </Button>
        {einDavNative && (
          <Button size="sm" variant="secondary" onClick={() => void syncNow()}>
            {t("modules.eindav.syncEvents")}
          </Button>
        )}
      </div>
      {syncMsg && <p className="muted">{syncMsg}</p>}
      {form && (
        <Card>
          <CardHeader>
            <CardTitle>
              {form.href ? t("modules.eindav.editEvent") : t("modules.eindav.newEvent")}
            </CardTitle>
          </CardHeader>
          <CardContent className="stack">
            <Input
              placeholder={t("modules.eindav.fieldSummary")}
              value={form.summary}
              onChange={(e) => setForm({ ...form, summary: e.currentTarget.value })}
            />
            <div className="row">
              <Input
                type={form.allDay ? "date" : "datetime-local"}
                aria-label={t("modules.eindav.fieldStart")}
                value={form.start}
                onChange={(e) => setForm({ ...form, start: e.currentTarget.value })}
              />
              <Input
                type={form.allDay ? "date" : "datetime-local"}
                aria-label={t("modules.eindav.fieldEnd")}
                value={form.end}
                onChange={(e) => setForm({ ...form, end: e.currentTarget.value })}
              />
              <label className="row">
                <input
                  type="checkbox"
                  checked={form.allDay}
                  onChange={(e) => setForm({ ...form, allDay: e.currentTarget.checked })}
                />
                {t("modules.eindav.allDay")}
              </label>
            </div>
            <Input
              placeholder={t("modules.eindav.fieldLocation")}
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.currentTarget.value })}
            />
            <Textarea
              placeholder={t("modules.eindav.fieldDescription")}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.currentTarget.value })}
            />
            <div className="row">
              <Button
                size="sm"
                onClick={() => void submit()}
                disabled={!form.summary || !form.start || save.isPending}
              >
                {t("modules.eindav.save")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setForm(null)}>
                {t("modules.eindav.cancel")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      <ul className="eindav-list">
        {(events.data?.events ?? []).map((e) => (
          <li key={e.href} className="eindav-row">
            <div className="eindav-row__main">
              <strong>{e.summary}</strong>
              <span className="muted">
                {e.start.replace("T", " ")} – {e.end.replace("T", " ")}
                {e.location ? ` · ${e.location}` : ""}
              </span>
            </div>
            <div className="row">
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setForm({
                    href: e.href,
                    uid: e.uid ?? undefined,
                    summary: e.summary,
                    start: e.start,
                    end: e.end,
                    allDay: e.allDay,
                    location: e.location ?? "",
                    description: e.description ?? "",
                  })
                }
              >
                {t("modules.eindav.edit")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => saveTextFile(`${e.summary || "event"}.ics`, "text/calendar", e.ics)}
              >
                {t("modules.eindav.export")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => del.mutate(e.href)}>
                {t("modules.eindav.delete")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {events.data?.events.length === 0 && (
        <p className="muted">{t("modules.eindav.emptyEvents")}</p>
      )}
    </div>
  );
}

// -- Files --------------------------------------------------------------------

function FilesPanel() {
  const { t } = useTranslation();
  const [path, setPath] = useState("");
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const files = useEinDavFiles(path);
  const upload = useUploadEinDavFile();
  const del = useDeleteEinDavFile();
  const dl = useDownloadEinDavFile();
  const mkdir = useMkdirEinDav();

  const crumbs = path ? path.split("/") : [];
  const entries = [...(files.data?.entries ?? [])].sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
  );

  const pick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) upload.mutate({ path: path ? `${path}/${f.name}` : f.name, file: f });
    };
    input.click();
  };

  return (
    <div className="stack">
      <div className="row">
        <nav className="eindav-crumbs" aria-label={t("modules.eindav.path")}>
          <button type="button" className="linklike" onClick={() => setPath("")}>
            /
          </button>
          {crumbs.map((seg, i) => (
            <span key={crumbs.slice(0, i + 1).join("/")}>
              <span className="muted">/</span>
              <button
                type="button"
                className="linklike"
                onClick={() => setPath(crumbs.slice(0, i + 1).join("/"))}
              >
                {seg}
              </button>
            </span>
          ))}
        </nav>
        <Button size="sm" onClick={pick} disabled={upload.isPending}>
          {t("modules.eindav.upload")}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setNewFolder("")}>
          {t("modules.eindav.newFolder")}
        </Button>
      </div>
      {newFolder !== null && (
        <div className="row">
          <Input
            placeholder={t("modules.eindav.folderName")}
            value={newFolder}
            onChange={(e) => setNewFolder(e.currentTarget.value)}
          />
          <Button
            size="sm"
            onClick={() => {
              if (newFolder) {
                mkdir.mutate(path ? `${path}/${newFolder}` : newFolder);
              }
              setNewFolder(null);
            }}
            disabled={!newFolder}
          >
            {t("modules.eindav.create")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setNewFolder(null)}>
            {t("modules.eindav.cancel")}
          </Button>
        </div>
      )}
      <ul className="eindav-list">
        {entries.map((e) => (
          <li key={e.path} className="eindav-row">
            <div className="eindav-row__main">
              {e.isDir ? (
                <button type="button" className="linklike" onClick={() => setPath(e.path)}>
                  {e.name}/
                </button>
              ) : (
                <strong>{e.name}</strong>
              )}
              <span className="muted">
                {e.isDir ? t("modules.eindav.folder") : fmtSize(e.size)}
                {e.mtime ? ` · ${new Date(e.mtime).toLocaleDateString()}` : ""}
              </span>
            </div>
            <div className="row">
              {!e.isDir && (
                <Button size="sm" variant="ghost" onClick={() => dl.mutate(e.path)}>
                  {t("modules.eindav.download")}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => del.mutate(e.path)}>
                {t("modules.eindav.delete")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {entries.length === 0 && <p className="muted">{t("modules.eindav.emptyFolder")}</p>}
    </div>
  );
}

// -- Page ---------------------------------------------------------------------

export default function EinDavPage() {
  const { t } = useTranslation();
  return (
    <NextcloudGate>
      <Tabs className="tabs">
        <TabList className="tabs__list" aria-label={t("modules.eindav.nav")}>
          <Tab id="contacts" className="tabs__tab">
            {t("modules.eindav.tabs.contacts")}
          </Tab>
          <Tab id="calendar" className="tabs__tab">
            {t("modules.eindav.tabs.calendar")}
          </Tab>
          <Tab id="files" className="tabs__tab">
            {t("modules.eindav.tabs.files")}
          </Tab>
        </TabList>
        <TabPanel id="contacts">
          <ContactsPanel />
        </TabPanel>
        <TabPanel id="calendar">
          <CalendarPanel />
        </TabPanel>
        <TabPanel id="files">
          <FilesPanel />
        </TabPanel>
      </Tabs>
    </NextcloudGate>
  );
}
