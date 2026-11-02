/** Shared shapes of the email module's two backends — IMAP and JMAP (D58). */

export interface MailAddress {
  name: string | null;
  address: string | null;
}

/** One inbox line: `id` is the IMAP uid or JMAP email id; `account` is set by the merge (D60). */
export interface MailSummary {
  id: string;
  account?: string;
  subject: string | null;
  from: MailAddress | null;
  date: string | null;
}

export interface MailMessage {
  subject: string | null;
  from: MailAddress | null;
  date: string | null;
  text: string | null;
  html: string | null;
}

/** Stored connector secret — username+password works for IMAP login and JMAP Basic. */
export interface MailCred {
  url: string;
  secret: { username: string; password: string };
}

export type MailResult<T> =
  | T
  | { notConnected: true }
  | { notFound: true }
  | { badId: true }
  | { failed: string };
