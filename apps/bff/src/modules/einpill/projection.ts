export interface EinpillRevisionInput {
  id?: string;
  effectiveDate: string;
  pillsPerPackage: number;
  usageMilli: number;
  createdAt?: string;
}

export interface EinpillPackageInput {
  id: string;
  addedDate: string;
  createdAt?: string;
}

export interface EinpillProjection {
  state: "untracked" | "active" | "exhausted";
  currentPackageId: string | null;
  currentStartedDate: string | null;
  currentRemainingPills: number;
  sparePackages: number;
  totalRemainingPills: number;
  remainingDays: number;
  runoutDate: string | null;
}

const DAY_MS = 86_400_000;

/** UTC calendar-date number; input is validated as YYYY-MM-DD by the caller. */
export function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

export function dayDate(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function sortRevisions(revisions: EinpillRevisionInput[]) {
  return [...revisions].sort(
    (a, b) =>
      dayNumber(a.effectiveDate) - dayNumber(b.effectiveDate) ||
      (a.createdAt ?? "").localeCompare(b.createdAt ?? "") ||
      (a.id ?? "").localeCompare(b.id ?? ""),
  );
}

function sortPackages(packages: EinpillPackageInput[]) {
  return [...packages].sort(
    (a, b) =>
      dayNumber(a.addedDate) - dayNumber(b.addedDate) ||
      (a.createdAt ?? "").localeCompare(b.createdAt ?? "") ||
      a.id.localeCompare(b.id),
  );
}

interface NormalizedRevision extends EinpillRevisionInput {
  effectiveDay: number;
}

function normalizeRevisions(revisions: EinpillRevisionInput[]): NormalizedRevision[] {
  const sorted = sortRevisions(revisions);
  if (sorted.length === 0) throw new Error("einpill projection requires at least one revision");
  return sorted.map((r) => ({ ...r, effectiveDay: dayNumber(r.effectiveDate) }));
}

/**
 * Latest revision effective on `day`; the earliest revision applies backward so
 * users can backdate packages before entering the medication into einring.
 */
function requiredAt<T>(rows: T[], index: number): T {
  const value = rows[index];
  if (value === undefined) throw new Error("einpill projection index out of range");
  return value;
}

function revisionIndexAt(revisions: NormalizedRevision[], day: number): number {
  let lo = 0;
  let hi = revisions.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (requiredAt(revisions, mid).effectiveDay <= day) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** The revision effective on a UTC date string — used for the table's current values. */
export function revisionForDate(
  revisions: EinpillRevisionInput[],
  date: string,
): EinpillRevisionInput {
  const normalized = normalizeRevisions(revisions);
  return requiredAt(normalized, revisionIndexAt(normalized, dayNumber(date)));
}

/** Milli-pills consumed on the complete calendar days in `[startDay, endDay)`. */
export function consumptionMilli(
  startDay: number,
  endDay: number,
  revisionInput: EinpillRevisionInput[],
): number {
  if (endDay <= startDay) return 0;
  const revisions = normalizeRevisions(revisionInput);
  let total = 0;
  let cursor = startDay;
  while (cursor < endDay) {
    const index = revisionIndexAt(revisions, cursor);
    const revision = requiredAt(revisions, index);
    const nextBoundary =
      index + 1 < revisions.length ? requiredAt(revisions, index + 1).effectiveDay : endDay;
    const segmentEnd = Math.min(endDay, nextBoundary);
    if (segmentEnd <= cursor) {
      // Defensive guard against malformed duplicate boundaries; persisted input cannot produce one.
      cursor += 1;
      continue;
    }
    total += (segmentEnd - cursor) * revision.usageMilli;
    cursor = segmentEnd;
  }
  return total;
}

/** First UTC calendar day on which `quantityMilli` is fully consumed, walking revision segments. */
export function exhaustionAfter(
  startDay: number,
  quantityMilli: number,
  revisionInput: EinpillRevisionInput[],
): number {
  const revisions = normalizeRevisions(revisionInput);
  let cursor = startDay;
  let remaining = quantityMilli;
  while (remaining > 0) {
    const index = revisionIndexAt(revisions, cursor);
    const revision = requiredAt(revisions, index);
    const daysNeeded = Math.ceil(remaining / revision.usageMilli);
    if (index + 1 >= revisions.length) return cursor + daysNeeded;
    const nextBoundary = requiredAt(revisions, index + 1).effectiveDay;
    const daysInSegment = nextBoundary - cursor;
    if (daysNeeded <= daysInSegment) return cursor + daysNeeded;
    remaining -= daysInSegment * revision.usageMilli;
    cursor = nextBoundary;
  }
  return cursor;
}

/**
 * Perfect-usage stock projection. Dates are UTC calendar dates; evaluation on
 * `today` consumes only complete days before today. Package format is read at
 * each package's addition date, while usage is piecewise by consumption date.
 */
export function projectInventory(
  revisionInput: EinpillRevisionInput[],
  packageInput: EinpillPackageInput[],
  today: string,
): EinpillProjection {
  const revisions = normalizeRevisions(revisionInput);
  const packages = sortPackages(packageInput);
  const todayDay = dayNumber(today);
  if (packages.length === 0) {
    return {
      state: "untracked",
      currentPackageId: null,
      currentStartedDate: null,
      currentRemainingPills: 0,
      sparePackages: 0,
      totalRemainingPills: 0,
      remainingDays: 0,
      runoutDate: null,
    };
  }

  interface PackageState {
    pkg: EinpillPackageInput;
    quantityMilli: number;
    startDay: number;
    endDay: number;
  }

  const states: PackageState[] = [];
  let previousEnd: number | null = null;
  for (const pkg of packages) {
    const addedDay = dayNumber(pkg.addedDate);
    const revision = requiredAt(revisions, revisionIndexAt(revisions, addedDay));
    const quantityMilli = revision.pillsPerPackage * 1000;
    const startDay = previousEnd === null ? addedDay : Math.max(addedDay, previousEnd);
    const endDay = exhaustionAfter(startDay, quantityMilli, revisions);
    states.push({ pkg, quantityMilli, startDay, endDay });
    previousEnd = endDay;
  }

  const currentIndex = states.findIndex((s) => s.endDay > todayDay);
  const finalRunoutDay = requiredAt(states, states.length - 1).endDay;
  if (currentIndex === -1) {
    return {
      state: "exhausted",
      currentPackageId: null,
      currentStartedDate: null,
      currentRemainingPills: 0,
      sparePackages: 0,
      totalRemainingPills: 0,
      remainingDays: 0,
      runoutDate: dayDate(finalRunoutDay),
    };
  }

  const current = requiredAt(states, currentIndex);
  const currentRemainingMilli =
    current.quantityMilli - consumptionMilli(current.startDay, todayDay, revisions);
  const spareMilli = states.slice(currentIndex + 1).reduce((sum, s) => sum + s.quantityMilli, 0);
  return {
    state: "active",
    currentPackageId: current.pkg.id,
    currentStartedDate: dayDate(current.startDay),
    currentRemainingPills: currentRemainingMilli / 1000,
    sparePackages: states.length - currentIndex - 1,
    totalRemainingPills: (currentRemainingMilli + spareMilli) / 1000,
    remainingDays: Math.max(0, finalRunoutDay - todayDay),
    runoutDate: dayDate(finalRunoutDay),
  };
}
