// Mirrors the BFF response shapes (apps/bff/src/routes). Keep in sync until shared types are extracted.

export interface Me {
  sub: string;
  name?: string;
  email?: string;
  preferredUsername?: string;
}

export type ConnectionStatus =
  | { status: "disconnected" }
  | { status: "pending"; login: string }
  | {
      status: "connected";
      loginName: string;
      displayName: string | null;
      server: string;
      /** Set only when an anonymous embedded flow completes — the einring session token. */
      sessionToken?: string;
    };

/** `flow` is set only for anonymous (embedded) starts; echo it back on poll. */
export interface LoginFlowStart {
  login: string;
  flow?: string;
}

export interface TableColumn {
  id: number;
  title: string;
  type: string;
  subtype?: string;
  options?: { id: number; label: string }[];
}

export interface TableRow {
  id: number;
  /** Raw cell values keyed by columnId — resolve labels via `TableColumn.options`. */
  cells: Record<string, unknown>;
}

export type TableNodeType = "view" | "table";

export interface TableNode {
  type: TableNodeType;
  id: number;
  title: string;
}

/** A Nextcloud Tables application (context) and its nodes (D40). */
export interface TablesApplication {
  name: string;
  nodes: TableNode[];
}

export interface TableView {
  kind: TableNodeType;
  id: number;
  title: string;
  emoji?: string;
  columns: TableColumn[];
  rows: TableRow[];
}

/** A module enabled on the BFF; `requires` lists the services it consumes. */
export interface ModuleInfo {
  id: string;
  requires: string[];
}

export interface ModuleRegistry {
  modules: ModuleInfo[];
}

export interface ServerHealth {
  version: string | null;
  webserver: string | null;
  phpVersion: string | null;
  database: { type: string | null; version: string | null; sizeBytes: number | null } | null;
  cpuLoad: number[] | null;
  memory: { totalBytes: number; freeBytes: number } | null;
  swap: { totalBytes: number; freeBytes: number } | null;
  freeSpaceBytes: number | null;
  users: {
    total: number | null;
    last5min: number | null;
    last1h: number | null;
    last24h: number | null;
  };
  apps: { installed: number | null; updatesAvailable: number | null };
}

export interface ServerBasics {
  product: string | null;
  version: string | null;
  quota: { usedBytes: number; freeBytes: number; totalBytes: number | null } | null;
  apps: { talk: string | null; userStatus: boolean; collectives: boolean; tables: boolean };
}

export interface ServerHealthResponse {
  available: boolean;
  health: ServerHealth | null;
  basics: ServerBasics | null;
}

export interface TalkUserStatus {
  userId: string;
  displayName: string | null;
  status: string;
  message: string | null;
  icon: string | null;
  groups: string[];
  /** Epoch ms of the user's last login; null when the account lacks admin access. */
  lastSeenAt: number | null;
}

export interface WikiPageMeta {
  path: string;
  title: string;
  collective: string;
  mtime: string | null;
}

export interface WikiTree {
  syncedAt: string | null;
  pages: WikiPageMeta[];
}

export interface WikiPage extends WikiPageMeta {
  content: string;
}

export interface WikiSearchResult extends WikiPageMeta {
  snippet: string;
}

export interface WikiSyncResult {
  syncedAt: string;
  pages: number;
}

export interface WikiLlmStatus {
  configured: boolean;
  indexing: boolean;
  pages: number;
  indexedPages: number;
  chunks: number;
}

export interface WikiIndexResult {
  pages: number;
  embeddedPages: number;
  chunks: number;
}

export interface WikiAskResult {
  answer: string;
  sources: { path: string; title: string }[];
}

export interface CsvFileMeta {
  id: number;
  name: string;
  headers: string[];
  rowCount: number;
  createdAt: string;
}

export interface CsvRow {
  id: number;
  cells: string[];
  done: boolean;
}

export interface CsvFile extends CsvFileMeta {
  rows: CsvRow[];
}

export interface TalkStatus {
  users: TalkUserStatus[];
  groups: string[];
  /** "all" = server admin, "partial" = group admin sees managed groups only, "none" = no group data. */
  groupsScope: "all" | "partial" | "none";
}

/** A client-held chat turn — the BFF is stateless, history re-sends each message (D41). */
export interface EinChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface EinChatStatus {
  configured: boolean;
  /** Tool names offered by enabled provider modules (e.g. yamtrack_search_media). */
  tools: string[];
}

export interface EinChatReply {
  reply: string;
}

/** A provider-module tool, with the user's enabled flag (EinChat data connections). */
export interface EinChatTool {
  name: string;
  /** Owning module id — the app groups and labels tools by it. */
  module: string;
  enabled: boolean;
}

export interface EinChatTools {
  tools: EinChatTool[];
}

/** Connector-module connection state (yamtrack, audiobookshelf, navidrome, trek, email). */
export interface ConnectorStatus {
  connected: boolean;
  /** Connected instance URL, or the deployment default when not yet connected. */
  url: string | null;
}

export interface EmailAddress {
  name: string | null;
  address: string | null;
}

export interface EmailSummary {
  uid: number;
  subject: string | null;
  from: EmailAddress | null;
  date: string | null;
}

export interface EmailList {
  emails: EmailSummary[];
}

export interface EmailMessage {
  subject: string | null;
  from: EmailAddress | null;
  date: string | null;
  text: string | null;
  html: string | null;
}

export interface GotifyMessage {
  id: number;
  appId: number;
  title: string | null;
  message: string;
  date: string;
  priority: number;
  /** e.g. "text/markdown" — lifted from extras["client::display"]. */
  contentType: string | null;
}

export interface GotifyMessages {
  messages: GotifyMessage[];
}

export interface GotifyApplication {
  id: number;
  name: string;
  description: string | null;
  /** The sender token — needed to configure posting clients (curl, scripts). */
  token: string;
}

export interface GotifyApplications {
  applications: GotifyApplication[];
}

export interface GotifyUser {
  name: string;
  admin: boolean;
}

/** One hub notification collected from a source module (D42). */
export interface EinHubNotification {
  id: number;
  /** Source module id (gotify, email, …). */
  module: string;
  title: string;
  body: string | null;
  /** Upstream event time (ISO). */
  at: string;
  read: boolean;
}

export interface EinHubFeed {
  notifications: EinHubNotification[];
  unread: number;
}

/** One pending GitLab todo — GitLab's API-side notification surface (D43). */
export interface GitLabTodo {
  id: number;
  project: string | null;
  author: string | null;
  /** action_name verbatim: assigned, mentioned, approval_required, build_failed, … */
  action: string;
  targetType: string;
  title: string;
  /** Upstream URL to the target (MR/issue/…). */
  url: string | null;
  createdAt: string;
}

export interface GitLabTodos {
  todos: GitLabTodo[];
}

/** One GitHub notification thread (D44). */
export interface GitHubNotification {
  id: string;
  unread: boolean;
  /** Why notified: mention, review_requested, assigned, ci_activity, … */
  reason: string;
  title: string;
  /** Issue, PullRequest, Commit, Release, Discussion, CheckSuite, … */
  type: string;
  repo: string | null;
  /** Web link to the subject. */
  url: string | null;
  updatedAt: string;
}

export interface GitHubNotifications {
  notifications: GitHubNotification[];
}

/** One Authentik event entry (D45). */
export interface AuthentikEvent {
  action: string;
  created: string;
  app: string | null;
  user: string | null;
}

/**
 * Aggregated Authentik health snapshot (D45) — every field independently
 * nullable; the token's permissions decide what the instance reports.
 */
export interface AuthentikStatus {
  account: { username: string; name: string | null } | null;
  version: { current: string | null; latest: string | null; outdated: boolean | null } | null;
  counts: {
    users: number | null;
    groups: number | null;
    applications: number | null;
    outposts: number | null;
  };
  workers: number | null;
  tasks: { total: number; failed: number; failedNames: string[] } | null;
  events: { loginFailedTotal: number | null; recent: AuthentikEvent[] } | null;
  fetchedAt: string;
}

/** Per-user Nextcloud feature toggles (D46) — all default true. */
export interface NextcloudFeatures {
  monitorTalk: boolean;
  monitorServer: boolean;
  tables: boolean;
  wiki: boolean;
}

export interface NextcloudSettingsResponse {
  settings: NextcloudFeatures;
}

/** Per-user disabled-module set (D47) — module ids the user has switched off. */
export interface ModulePrefs {
  disabled: string[];
}

/** An uploaded MP3 (D48). */
export interface EinMusicTrack {
  id: number;
  title: string;
  bytes: number;
  createdAt: string;
}

export interface EinMusicTracks {
  tracks: EinMusicTrack[];
}

export interface EinMusicPlaylist {
  id: number;
  name: string;
  createdAt: string;
  trackCount?: number;
}

export interface EinMusicPlaylists {
  playlists: EinMusicPlaylist[];
}

export interface EinMusicPlaylistDetail {
  playlist: EinMusicPlaylist;
  tracks: EinMusicTrack[];
}

/** A playlist on the connected Navidrome server (D48). */
export interface NavidromePlaylist {
  id: string;
  name: string;
  songCount: number;
}

export interface NavidromePlaylists {
  playlists: NavidromePlaylist[];
}

export interface NavidromeTrack {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  duration: number | null;
}

export interface NavidromePlaylistDetail {
  playlist: { id: string; name: string };
  tracks: NavidromeTrack[];
}

/** Passman vault as returned by `/api/v2/vaults` (D50 — pass-through). */
export interface PassmanVault {
  vault_id: number;
  guid: string;
  name: string;
  created?: number;
  last_access?: number;
  /** SJCL-encrypted challenge; decrypting it with the vault password verifies the key. */
  challenge_password?: string;
}

export interface PassmanVaults {
  vaults: PassmanVault[];
}

/**
 * A Passman credential as returned by `/api/v2/vaults/:guid` — secret fields
 * (`password`, `url`, `description`, `custom_fields`, `files`, `otp`) are still
 * SJCL-encrypted base64; only the app decrypts them (D50).
 */
export interface PassmanCredential {
  credential_id: number;
  label?: string;
  username?: string;
  email?: string;
  description?: string | null;
  password?: string | null;
  url?: string | null;
  custom_fields?: string | null;
  files?: string | null;
  otp?: string | null;
  favicon?: string | null;
  /**
   * Shape varies with PHP serialization: `{text}[]`, a single `{text}` object,
   * an assoc-array object `{"0":{text}}`, or a JSON string — normalize via `passmanTags`.
   */
  tags?: unknown;
  hidden?: boolean;
  created?: number;
  changed?: number;
}

export interface PassmanVaultDetail {
  vault: {
    guid?: string;
    name?: string;
    credentials?: PassmanCredential[];
  };
}

/** A Talk conversation (D51). */
export interface TalkRoom {
  token: string;
  name: string;
  displayName: string;
  type: number;
  unread: number;
  lastActivity: number;
  lastMessage: string | null;
}

export interface TalkRooms {
  rooms: TalkRoom[];
}

/** A spreed chat message; `messageParameters` carries rich objects (files). */
export interface TalkMessage {
  id: number;
  token?: string;
  actorType?: string;
  actorId?: string;
  actorDisplayName?: string;
  timestamp?: number;
  systemMessage?: string;
  messageType?: string;
  message?: string;
  messageParameters?: Record<string, TalkFileParam | Record<string, unknown>>;
}

/** A `file` rich-object parameter on a chat message. */
export interface TalkFileParam {
  type?: string;
  id?: string;
  name?: string;
  path?: string;
  mimetype?: string;
  link?: string;
  size?: number | string;
}

export interface TalkMessages {
  messages: TalkMessage[];
}

/** A joined Matrix room (D52). */
export interface MatrixRoom {
  id: string;
  name: string | null;
}

export interface MatrixRooms {
  rooms: MatrixRoom[];
}

/** A mapped `/messages` chunk entry — newest first from the BFF (dir=b). */
export interface MatrixMessage {
  id?: string;
  sender: string;
  senderName: string;
  ts: number;
  type: string;
  msgtype: string | null;
  body: string;
  url: string | null;
  info: { mimetype?: string; size?: number } | null;
}

export interface MatrixMessages {
  end: string | null;
  messages: MatrixMessage[];
}

export interface MatrixSelf {
  userId: string | null;
}

// -- EinDAV (D54) -------------------------------------------------------------

export interface EinDavAddressbook {
  href: string;
  name: string;
}

export interface EinDavContact {
  href: string;
  etag: string | null;
  uid: string | null;
  fn: string;
  emails: string[];
  tels: string[];
  note: string | null;
  vcard: string;
}

export interface EinDavContactInput {
  book: string;
  href?: string;
  uid?: string;
  fn: string;
  emails: string[];
  tels: string[];
  note?: string;
}

export interface EinDavCalendar {
  href: string;
  name: string;
  color: string | null;
}

export interface EinDavEvent {
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

export interface EinDavEventInput {
  cal: string;
  href?: string;
  uid?: string;
  summary: string;
  description?: string;
  location?: string;
  start: string;
  end?: string;
}

export interface EinDavFileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
  mtime: string | null;
}

// -- Recipes (D55) ------------------------------------------------------------

export interface RecipeListItem {
  id: string;
  name: string;
  description: string | null;
  hasImage: boolean;
  keywords: string[];
  category: string | null;
  cuisine: string | null;
  servings: string | null;
  totalTime: string | null;
  ingredients: string[];
}

export interface Recipe extends RecipeListItem {
  prepTime: string | null;
  cookTime: string | null;
  instructions: string[];
}

// -- School (D56) -------------------------------------------------------------

export type SchoolRole = "admin" | "teacher" | "parent" | "student";
export type SchoolPersonKind = "student" | "guardian" | "teacher" | "staff";

export interface SchoolPerson {
  id: string;
  sub: string | null;
  kind: SchoolPersonKind;
  name: string;
  email: string | null;
  phone: string | null;
  birthdate: string | null;
  matrixId: string | null;
  active: number;
  notes: string | null;
  billingMode: "flat" | "per_lesson" | "per_scheduled" | "none";
  flatCents: number | null;
  lessonCents: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface SchoolMe {
  roles: SchoolRole[];
  person: SchoolPerson | null;
  peers: string[];
}

export interface SchoolUser {
  sub: string;
  name: string | null;
  email: string | null;
  lastSeen: string;
  personId: string | null;
}

export interface SchoolHousehold {
  id: string;
  name: string;
  address: string | null;
  iban: string | null;
  discount_pct: number;
  discountPct?: number;
  notes: string | null;
  members?: { personId: string; relation: "guardian" | "student"; name?: string }[];
}

export interface SchoolLessonType {
  id: string;
  name: string;
  durationMin: number;
  defaultRateCents: number;
  active: number;
}

export interface SchoolSeries {
  id: string;
  teacherId: string;
  teacherName?: string;
  lessonTypeId: string | null;
  typeName?: string | null;
  weekday: number;
  startTime: string;
  durationMin: number;
  validFrom: string;
  validUntil: string | null;
  location: string | null;
  title: string | null;
  notes: string | null;
  students?: { id: string; name: string }[];
}

export type SchoolAttendance = "attended" | "absent_excused" | "absent_unexcused" | "cancelled";

export interface SchoolLessonStudent {
  studentId: string;
  studentName?: string;
  attendance: SchoolAttendance | null;
  privateNote?: string | null;
  publicNote?: string | null;
  practice?: string | null;
}

export interface SchoolLesson {
  id: string;
  seriesId: string | null;
  teacherId: string;
  teacherName?: string;
  substituteTeacherId: string | null;
  substituteName?: string | null;
  lessonTypeId: string | null;
  typeName?: string | null;
  date: string;
  startTime: string;
  durationMin: number;
  location: string | null;
  status: "scheduled" | "cancelled_school" | "cancelled_teacher" | "cancelled_parent" | "done";
  cancelReason: string | null;
  isMakeup: number;
  notes: string | null;
  students: SchoolLessonStudent[];
}

export interface SchoolConflict {
  kind:
    | "teacher_double_booking"
    | "student_double_booking"
    | "teacher_absent"
    | "holiday"
    | "outside_availability";
  detail: string;
}

export interface SchoolHoliday {
  id: string;
  name: string;
  startDate?: string;
  endDate?: string;
  start_date?: string;
  end_date?: string;
  kind: "holiday" | "closure";
}

export interface SchoolInstrument {
  id: string;
  name: string;
  category: string | null;
  serialNo?: string | null;
  serial_no?: string | null;
  monthlyRateCents?: number;
  monthly_rate_cents?: number;
  status: string;
  condition?: string | null;
  notes: string | null;
}

export interface SchoolRental {
  id: string;
  instrumentId?: string;
  instrument_id?: string;
  studentId?: string;
  student_id?: string;
  instrumentName?: string;
  studentName?: string;
  startDate?: string;
  start_date?: string;
  endDate?: string | null;
  end_date?: string | null;
  monthlyRateCents?: number;
  monthly_rate_cents?: number;
  status: string;
}

export interface SchoolInvoice {
  id: string;
  householdId: string;
  householdName?: string;
  period: string;
  number: string;
  status: "draft" | "issued" | "paid" | "cancelled";
  totalCents: number;
  issuedAt: string | null;
  dueDate: string | null;
}

export interface SchoolInvoiceLine {
  id: string;
  kind: string;
  description: string;
  amountCents: number;
}

export interface SchoolPayment {
  id: string;
  paidAt: string;
  amountCents: number;
  method: string | null;
  note: string | null;
}

export interface SchoolInvoiceDetail extends SchoolInvoice {
  lines: SchoolInvoiceLine[];
  payments: SchoolPayment[];
  paidCents?: number;
  notes?: string | null;
}

export interface SchoolThread {
  id: string;
  kind: "direct" | "announcement";
  title: string | null;
  audience: string | null;
  createdAt: string;
  lastBody: string | null;
  lastAt: string | null;
  memberCount: number;
  unread: boolean;
}

export interface SchoolMessage {
  id: string;
  senderSub: string;
  senderName?: string | null;
  body: string;
  createdAt: string;
}

export interface SchoolContact {
  sub: string;
  name: string | null;
}

export interface SchoolEvent {
  id: string;
  kind: "concert" | "recital" | "exam" | "other";
  title: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  location: string | null;
  description: string | null;
  teacherId: string | null;
  teacherName: string | null;
  participants: {
    studentId: string;
    studentName: string;
    piece: string | null;
    status: "invited" | "confirmed" | "declined";
    note: string | null;
  }[];
  rehearsals: {
    id: string;
    date: string;
    startTime: string;
    durationMin: number;
    location: string | null;
    note: string | null;
  }[];
}

export interface SchoolMakeupRequest {
  id: string;
  lessonId: string;
  studentId: string;
  studentName?: string;
  reason: string | null;
  status: "open" | "scheduled" | "declined";
  createdAt?: string;
}

export interface SchoolHomework {
  id: string;
  teacherId: string;
  teacherName: string | null;
  title: string;
  body: string;
  musicxml?: string | null;
  musicxmlName: string | null;
  hasMusicxml?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SchoolHomeworkSubmission {
  id: string;
  message: string;
  mediaName: string | null;
  mediaMime: string | null;
  mediaBytes: number | null;
  createdAt: string;
}

export interface SchoolHomeworkAssignment {
  id: string;
  homeworkId: string;
  homeworkTitle: string;
  teacherId: string;
  teacherName: string | null;
  studentId: string;
  studentName: string;
  note: string | null;
  dueDate: string | null;
  status: "assigned" | "submitted" | "reviewed";
  feedback: string | null;
  createdAt: string;
  submissions: SchoolHomeworkSubmission[];
}
