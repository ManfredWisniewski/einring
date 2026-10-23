/**
 * Minimal single/multi-page text PDF writer (D56) — standard-14 Helvetica with
 * WinAnsi encoding, which covers German umlauts and the € sign. No dependency.
 * Good enough for invoices: left-aligned text lines at fixed font sizes.
 */

const encoder = new TextEncoder();

/** WinAnsi byte for a JS string char; unsupported chars become "?". */
function winAnsi(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 63;
    if (cp === 0x20ac)
      out.push(0x80); // €
    else if (cp === 0x201e)
      out.push(0x84); // „
    else if (cp === 0x201c)
      out.push(0x93); // “
    else if (cp === 0x201d)
      out.push(0x94); // ”
    else if (cp === 0x2013 || cp === 0x2014)
      out.push(0x96); // –/—
    else if (cp <= 0xff) out.push(cp);
    else out.push(0x3f);
  }
  return out;
}

const esc = (bytes: number[]) =>
  bytes
    .map((b) => {
      const c = String.fromCharCode(b);
      if (c === "\\" || c === "(" || c === ")") return `\\${c}`;
      if (b < 0x20) return `\\${b.toString(8).padStart(3, "0")}`;
      return c;
    })
    .join("");

export interface PdfLine {
  text: string;
  size?: number;
  bold?: boolean;
  /** Extra vertical gap before this line (points). */
  gap?: number;
}

/**
 * Builds a PDF containing `lines` laid out top-down on A4 pages.
 * Lines that would cross the bottom margin start a new page.
 */
export function buildPdf(title: string, lines: PdfLine[]): Buffer {
  const PAGE_W = 595;
  const PAGE_H = 842;
  const MARGIN = 56;
  const pages: PdfLine[][] = [];
  let y = PAGE_H - MARGIN;
  let page: PdfLine[] = [];
  for (const line of lines) {
    const advance = (line.size ?? 10) * 1.35 + (line.gap ?? 0);
    if (y - advance < MARGIN && page.length > 0) {
      pages.push(page);
      page = [];
      y = PAGE_H - MARGIN;
    }
    y -= advance;
    page.push(line);
  }
  if (page.length > 0) pages.push(page);

  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length; // 1-based object id
  };

  // Defer catalog/pages ids
  const catalogId = 1;
  const pagesId = 2;
  objects.length = 2; // reserve 1,2
  const pageIds: number[] = [];

  const fontRegularId = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );
  const fontBoldId = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  );

  for (const p of pages) {
    let content = "";
    let cy = PAGE_H - MARGIN;
    for (const line of p) {
      const size = line.size ?? 10;
      cy -= size * 1.35 + (line.gap ?? 0);
      const font = line.bold ? "F2" : "F1";
      content += `BT /${font} ${size} Tf ${MARGIN} ${cy.toFixed(1)} Td (${esc(winAnsi(line.text))}) Tj ET\n`;
    }
    const streamId = add(
      `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream`,
    );
    const pageId = add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        `/Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> ` +
        `/Contents ${streamId} 0 R >>`,
    );
    pageIds.push(pageId);
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  // Info object (optional, keep last)
  const infoId = add(`<< /Title (${esc(winAnsi(title))}) /Producer (einring school) >>`);

  // Serialize with xref table
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(encoder.encode(pdf).length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = encoder.encode(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\n`;
  pdf += `startxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

const money = (cents: number, currency: string) =>
  `${(cents / 100).toFixed(2).replace(".", ",")} ${currency === "EUR" ? "€" : currency}`;

export interface InvoicePdfData {
  number: string;
  period: string;
  status: string;
  issuedAt: string | null;
  dueDate: string | null;
  schoolName: string;
  schoolAddress: string;
  householdName: string;
  householdAddress: string | null;
  lines: { label: string; qty: number; unitCents: number; amountCents: number }[];
  totalCents: number;
  paidCents: number;
  currency: string;
}

export function invoicePdf(d: InvoicePdfData): Buffer {
  const lines: PdfLine[] = [];
  if (d.schoolName) lines.push({ text: d.schoolName, size: 16, bold: true });
  if (d.schoolAddress) {
    for (const part of d.schoolAddress.split("\n")) lines.push({ text: part, size: 9 });
  }
  lines.push({ text: "", size: 4, gap: 18 });
  lines.push({ text: d.householdName, size: 11, bold: true });
  if (d.householdAddress) {
    for (const part of d.householdAddress.split("\n")) lines.push({ text: part, size: 10 });
  }
  lines.push({ text: `Rechnung ${d.number}`, size: 15, bold: true, gap: 28 });
  lines.push({
    text: `Zeitraum: ${d.period}    Status: ${d.status}    Fällig: ${d.dueDate ?? "—"}`,
    size: 10,
    gap: 4,
  });
  lines.push({ text: "", size: 4, gap: 16 });
  for (const l of d.lines) {
    const qty = l.qty === 1 ? "" : `${l.qty} × ${money(l.unitCents, d.currency)}  `;
    lines.push({ text: `${qty}${l.label}`, size: 10 });
    lines.push({ text: `        ${money(l.amountCents, d.currency)}`, size: 10 });
  }
  lines.push({ text: `Summe: ${money(d.totalCents, d.currency)}`, size: 12, bold: true, gap: 18 });
  if (d.paidCents > 0) {
    lines.push({ text: `Bereits gezahlt: ${money(d.paidCents, d.currency)}`, size: 10 });
    lines.push({
      text: `Offen: ${money(d.totalCents - d.paidCents, d.currency)}`,
      size: 11,
      bold: true,
    });
  }
  return buildPdf(`Rechnung ${d.number}`, lines);
}
