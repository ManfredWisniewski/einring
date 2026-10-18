import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { type AuthenticatedNextcloud, parsePropResponses, propText } from "../nextcloud/client.js";
import type { BffModule } from "./types.js";

/** Hrefs returned by REPORT/PROPFIND are absolute DAV paths — only these may be touched. */
const DAV_PREFIX = "/remote.php/dav/";
const safeHref = (href: string) => href.startsWith(DAV_PREFIX);

/** Authenticated client for the caller, or null when Nextcloud is disconnected. */
function ncFor(ctx: AppContext, sub: string): AuthenticatedNextcloud | null {
  const cred = ctx.store.getCredential(sub);
  return cred
    ? ctx.nextcloud.withCredentials(cred.loginName, ctx.secrets.open(cred.appPasswordSealed))
    : null;
}

// -- vCard 3.0 ----------------------------------------------------------------

const unfold = (text: string) =>
  text
    .replace(/\r\n[ \t]/g, "")
    .replace(/\n[ \t]/g, "")
    .split(/\r?\n/);

/** `NAME[;PARAM=...]:VALUE` → {name, value} (params ignored for our read set). */
const propLine = (line: string) => {
  const i = line.indexOf(":");
  if (i < 0) return null;
  return {
    name: (line.slice(0, i).split(";")[0] ?? "").toUpperCase(),
    value: line.slice(i + 1),
  };
};

const vcardEscape = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
const vcardUnescape = (s: string) =>
  s.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");

export interface ParsedContact {
  href: string;
  etag: string | null;
  uid: string | null;
  fn: string;
  emails: string[];
  tels: string[];
  note: string | null;
  vcard: string;
}

export function parseVcard(href: string, etag: string | null, vcard: string): ParsedContact {
  const emails: string[] = [];
  const tels: string[] = [];
  let fn = "";
  let uid: string | null = null;
  let note: string | null = null;
  for (const line of unfold(vcard)) {
    const p = propLine(line);
    if (!p) continue;
    if (p.name === "FN") fn = vcardUnescape(p.value);
    else if (p.name === "EMAIL") emails.push(vcardUnescape(p.value));
    else if (p.name === "TEL") tels.push(vcardUnescape(p.value));
    else if (p.name === "NOTE") note = vcardUnescape(p.value);
    else if (p.name === "UID") uid = p.value;
  }
  return { href, etag, uid, fn, emails, tels, note, vcard };
}

const uid = () => `einring-${randomBytes(8).toString("hex")}`;

export function buildVcard(c: {
  uid: string;
  fn: string;
  emails: string[];
  tels: string[];
  note?: string;
}): string {
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `UID:${c.uid}`,
    `FN:${vcardEscape(c.fn)}`,
    `N:${vcardEscape(c.fn)};;;;`,
    ...c.emails.map((e) => `EMAIL;TYPE=INTERNET:${vcardEscape(e)}`),
    ...c.tels.map((n) => `TEL;TYPE=CELL:${vcardEscape(n)}`),
    ...(c.note ? [`NOTE:${vcardEscape(c.note)}`] : []),
    `REV:${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "")}`,
    "END:VCARD",
  ];
  return `${lines.join("\r\n")}\r\n`;
}

// -- iCalendar VEVENT ----------------------------------------------------------

export interface ParsedEvent {
  href: string;
  etag: string | null;
  uid: string | null;
  summary: string;
  description: string | null;
  location: string | null;
  start: string;
  end: string;
  allDay: boolean;
  ics: string;
}

/** `YYYYMMDDTHHMMSSZ` → `YYYY-MM-DDTHH:mm`; date-only → `YYYY-MM-DD`. */
const icsToInput = (v: string) => {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(v.trim());
  if (!m) return v;
  return m[4] ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` : `${m[1]}-${m[2]}-${m[3]}`;
};

/** `YYYY-MM-DD[THH:mm[:ss]]` → `YYYYMMDDTHHMMSSZ` or `YYYYMMDD`. */
const inputToIcs = (v: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(v.trim());
  if (!m) return null;
  return m[4] ? `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}${m[6] ?? "00"}Z` : `${m[1]}${m[2]}${m[3]}`;
};

export function parseVevent(href: string, etag: string | null, ics: string): ParsedEvent | null {
  const lines = unfold(ics);
  const start = lines.indexOf("BEGIN:VEVENT");
  const end = lines.indexOf("END:VEVENT");
  if (start < 0 || end < 0) return null;
  const ev: Record<string, string> = {};
  const allDay = lines
    .slice(start, end)
    .some((l) => /^DTSTART;VALUE=DATE(?!-TIME)/i.test(l) || /^DTSTART:\d{8}$/.test(l));
  for (const line of lines.slice(start + 1, end)) {
    const p = propLine(line);
    if (!p) continue;
    ev[p.name] ??= vcardUnescape(p.value);
  }
  return {
    href,
    etag,
    uid: ev.UID ?? null,
    summary: ev.SUMMARY ?? "",
    description: ev.DESCRIPTION ?? null,
    location: ev.LOCATION ?? null,
    start: icsToInput(ev.DTSTART ?? ""),
    end: icsToInput(ev.DTEND ?? ev.DTSTART ?? ""),
    allDay,
    ics,
  };
}

export function buildIcs(e: {
  uid: string;
  summary: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
}): string | null {
  const dtstart = inputToIcs(e.start);
  const dtend = inputToIcs(e.end || e.start);
  if (!dtstart || !dtend) return null;
  const allDay = dtstart.length === 8;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//einring//eindav//EN",
    "BEGIN:VEVENT",
    `UID:${e.uid}`,
    `DTSTAMP:${stamp}`,
    allDay ? `DTSTART;VALUE=DATE:${dtstart}` : `DTSTART:${dtstart}`,
    allDay ? `DTEND;VALUE=DATE:${dtend}` : `DTEND:${dtend}`,
    `SUMMARY:${vcardEscape(e.summary)}`,
    ...(e.description ? [`DESCRIPTION:${vcardEscape(e.description)}`] : []),
    ...(e.location ? [`LOCATION:${vcardEscape(e.location)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.join("\r\n")}\r\n`;
}

// -- Schemas ------------------------------------------------------------------

const contactSchema = z.object({
  book: z.string().min(1),
  href: z.string().optional(),
  uid: z.string().optional(),
  fn: z.string().min(1).max(500),
  emails: z.array(z.string().max(300)).max(20).default([]),
  tels: z.array(z.string().max(100)).max(20).default([]),
  note: z.string().max(4000).optional(),
});

const eventSchema = z.object({
  cal: z.string().min(1),
  href: z.string().optional(),
  uid: z.string().optional(),
  summary: z.string().min(1).max(500),
  description: z.string().max(8000).optional(),
  location: z.string().max(500).optional(),
  start: z.string().min(8).max(30),
  end: z.string().max(30).optional(),
});

/**
 * EinDAV (D54): CardDAV contacts + CalDAV events + WebDAV files, two-way,
 * through the stored Nextcloud credential. Parsing/composition happens here so
 * the wire format is tested once; Android provider writes live in the
 * Capacitor EinDav plugin and receive already-parsed data.
 */
export const eindavModule: BffModule = {
  id: "eindav",
  requires: ["nextcloud"],

  register(api, ctx) {
    api.get("/addressbooks", async (req, reply) => {
      const nc = ncFor(ctx, req.user.sub);
      if (!nc) return reply.code(424).send({ error: "nextcloud is not connected" });
      const xml = await nc.davPropfindAbs(
        `${nc.davHome("addressbooks")}/`,
        1,
        "<d:resourcetype/><d:displayname/><cs:getctag xmlns:cs='http://calendarserver.org/ns/'/>",
      );
      const books = parsePropResponses(xml)
        .filter(
          (r) =>
            typeof r.props.resourcetype === "object" &&
            r.props.resourcetype !== null &&
            "addressbook" in (r.props.resourcetype as object),
        )
        .map((r) => ({ href: r.href, name: propText(r.props.displayname) ?? r.href }));
      return { addressbooks: books };
    });

    api.get("/contacts", async (req, reply) => {
      const nc = ncFor(ctx, req.user.sub);
      if (!nc) return reply.code(424).send({ error: "nextcloud is not connected" });
      const book = (req.query as { book?: string }).book ?? "";
      if (!safeHref(book)) return reply.code(400).send({ error: "invalid book href" });
      const xml = await nc.davReport(
        book,
        `<?xml version="1.0"?>
<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop><d:getetag/><card:address-data/></d:prop>
</card:addressbook-query>`,
      );
      const contacts = parsePropResponses(xml)
        .map((r) => {
          const data = propText(r.props["address-data"]);
          return data
            ? parseVcard(r.href, propText(r.props.getetag)?.replaceAll('"', "") ?? null, data)
            : null;
        })
        .filter((c): c is ParsedContact => c !== null);
      return { contacts };
    });

    api.put("/contact", async (req, reply) => {
      const nc = ncFor(ctx, req.user.sub);
      if (!nc) return reply.code(424).send({ error: "nextcloud is not connected" });
      const parsed = contactSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid contact" });
      const c = parsed.data;
      if (!safeHref(c.book) || (c.href && !safeHref(c.href))) {
        return reply.code(400).send({ error: "invalid href" });
      }
      const id = c.uid ?? uid();
      const href = c.href ?? `${c.book.endsWith("/") ? c.book : `${c.book}/`}${id}.vcf`;
      const vcard = buildVcard({ uid: id, fn: c.fn, emails: c.emails, tels: c.tels, note: c.note });
      await nc.davObjectRequest("PUT", href, vcard, "text/vcard; charset=utf-8");
      return reply.code(201).send({ href });
    });

    api.delete("/contact", async (req, reply) => {
      const nc = ncFor(ctx, req.user.sub);
      if (!nc) return reply.code(424).send({ error: "nextcloud is not connected" });
      const href = (req.query as { href?: string }).href ?? "";
      if (!safeHref(href)) return reply.code(400).send({ error: "invalid href" });
      await nc.davObjectRequest("DELETE", href);
      return reply.code(204).send();
    });

    api.get("/calendars", async (req, reply) => {
      const nc = ncFor(ctx, req.user.sub);
      if (!nc) return reply.code(424).send({ error: "nextcloud is not connected" });
      const xml = await nc.davPropfindAbs(
        `${nc.davHome("calendars")}/`,
        1,
        "<d:resourcetype/><d:displayname/><x1:calendar-color xmlns:x1='http://apple.com/ns/ical/'/>",
      );
      const calendars = parsePropResponses(xml)
        .filter(
          (r) =>
            typeof r.props.resourcetype === "object" &&
            r.props.resourcetype !== null &&
            "calendar" in (r.props.resourcetype as object),
        )
        .map((r) => ({
          href: r.href,
          name: propText(r.props.displayname) ?? r.href,
          color: propText(r.props["calendar-color"]) ?? null,
        }));
      return { calendars };
    });

    api.get("/events", async (req, reply) => {
      const nc = ncFor(ctx, req.user.sub);
      if (!nc) return reply.code(424).send({ error: "nextcloud is not connected" });
      const q = req.query as { cal?: string; from?: string; to?: string };
      const cal = q.cal ?? "";
      if (!safeHref(cal)) return reply.code(400).send({ error: "invalid calendar href" });
      // Date-only bounds expand to full days — CalDAV time-range wants datetimes.
      const dayStart = (v: string) => (v.length === 10 ? `${v}T00:00` : v);
      const dayEnd = (v: string) => (v.length === 10 ? `${v}T23:59` : v);
      const from = inputToIcs(dayStart(q.from ?? "")) ?? "19700101T000000Z";
      const to = inputToIcs(dayEnd(q.to ?? "")) ?? "21000101T000000Z";
      const xml = await nc.davReport(
        cal,
        `<?xml version="1.0"?>
<cal:calendar-query xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><cal:calendar-data/></d:prop>
  <cal:filter>
    <cal:comp-filter name="VCALENDAR">
      <cal:comp-filter name="VEVENT">
        <cal:time-range start="${from}" end="${to}"/>
      </cal:comp-filter>
    </cal:comp-filter>
  </cal:filter>
</cal:calendar-query>`,
      );
      const events = parsePropResponses(xml)
        .map((r) => {
          const data = propText(r.props["calendar-data"]);
          return data
            ? parseVevent(r.href, propText(r.props.getetag)?.replaceAll('"', "") ?? null, data)
            : null;
        })
        .filter((e): e is ParsedEvent => e !== null);
      events.sort((a, b) => a.start.localeCompare(b.start));
      return { events };
    });

    api.put("/event", async (req, reply) => {
      const nc = ncFor(ctx, req.user.sub);
      if (!nc) return reply.code(424).send({ error: "nextcloud is not connected" });
      const parsed = eventSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid event" });
      const e = parsed.data;
      if (!safeHref(e.cal) || (e.href && !safeHref(e.href))) {
        return reply.code(400).send({ error: "invalid href" });
      }
      const id = e.uid ?? uid();
      const ics = buildIcs({
        uid: id,
        summary: e.summary,
        description: e.description,
        location: e.location,
        start: e.start,
        end: e.end ?? e.start,
      });
      if (!ics) return reply.code(400).send({ error: "invalid start/end" });
      const href = e.href ?? `${e.cal.endsWith("/") ? e.cal : `${e.cal}/`}${id}.ics`;
      await nc.davObjectRequest("PUT", href, ics, "text/calendar; charset=utf-8");
      return reply.code(201).send({ href });
    });

    api.delete("/event", async (req, reply) => {
      const nc = ncFor(ctx, req.user.sub);
      if (!nc) return reply.code(424).send({ error: "nextcloud is not connected" });
      const href = (req.query as { href?: string }).href ?? "";
      if (!safeHref(href)) return reply.code(400).send({ error: "invalid href" });
      await nc.davObjectRequest("DELETE", href);
      return reply.code(204).send();
    });

    // -- WebDAV files (browse, upload, download, delete, mkdir) ---------------

    const safePath = (p: string) => p !== "" && !p.split("/").includes("..");

    api.get("/files", async (req, reply) => {
      const nc = ncFor(ctx, req.user.sub);
      if (!nc) return reply.code(424).send({ error: "nextcloud is not connected" });
      const path = (req.query as { path?: string }).path ?? "";
      if (path && !safePath(path)) return reply.code(400).send({ error: "invalid path" });
      const entries = (await nc.davPropfind(path, 1)).filter((e) => e.relPath !== path);
      return {
        entries: entries.map((e) => ({
          name: e.relPath.split("/").at(-1) ?? e.relPath,
          path: e.relPath,
          isDir: e.isCollection,
          size: e.size ?? null,
          mtime: e.lastModified ?? null,
        })),
      };
    });

    api.get("/file", async (req, reply) => {
      const nc = ncFor(ctx, req.user.sub);
      if (!nc) return reply.code(424).send({ error: "nextcloud is not connected" });
      const path = (req.query as { path?: string }).path ?? "";
      if (!safePath(path)) return reply.code(400).send({ error: "invalid path" });
      const res = await nc.davGetResponse(path);
      return reply
        .header("Content-Type", res.headers.get("content-type") ?? "application/octet-stream")
        .header("Cache-Control", "private, max-age=60")
        .send(Buffer.from(await res.arrayBuffer()));
    });

    api.addContentTypeParser(
      ["application/octet-stream", "text/vcard", "text/calendar"],
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body),
    );

    api.put("/file", { bodyLimit: 50 * 1024 * 1024 }, async (req, reply) => {
      const nc = ncFor(ctx, req.user.sub);
      if (!nc) return reply.code(424).send({ error: "nextcloud is not connected" });
      const path = (req.query as { path?: string }).path ?? "";
      if (!safePath(path)) return reply.code(400).send({ error: "invalid path" });
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ error: "expected the file bytes as the request body" });
      }
      const ct =
        typeof req.headers["content-type"] === "string"
          ? req.headers["content-type"]
          : "application/octet-stream";
      await nc.davPutFile(path, body, ct);
      return reply.code(201).send({ path });
    });

    api.delete("/file", async (req, reply) => {
      const nc = ncFor(ctx, req.user.sub);
      if (!nc) return reply.code(424).send({ error: "nextcloud is not connected" });
      const path = (req.query as { path?: string }).path ?? "";
      if (!safePath(path)) return reply.code(400).send({ error: "invalid path" });
      await nc.davDelete(path);
      return reply.code(204).send();
    });

    api.post("/folder", async (req, reply) => {
      const nc = ncFor(ctx, req.user.sub);
      if (!nc) return reply.code(424).send({ error: "nextcloud is not connected" });
      const path = (req.query as { path?: string }).path ?? "";
      if (!safePath(path)) return reply.code(400).send({ error: "invalid path" });
      await nc.davMkcol(path);
      return reply.code(201).send({ path });
    });
  },
};
