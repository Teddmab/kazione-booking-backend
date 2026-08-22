// supabase/functions/_shared/timezone.ts
//
// Converts between a business's local wall-clock date/time and true UTC.
// Uses Intl.DateTimeFormat().formatToParts() rather than Temporal — deno.json
// declares no unstable lib, so Temporal isn't guaranteed to be available.

const DOW_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function partsToMap(parts: Intl.DateTimeFormatPart[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  return map;
}

function formatInZone(instant: Date, ianaTimeZone: string) {
  const parts = partsToMap(
    new Intl.DateTimeFormat("en-US", {
      timeZone: ianaTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    }).formatToParts(instant),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    dayOfWeek: DOW_INDEX[parts.weekday] ?? 0,
    epochMs: Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    ),
  };
}

/**
 * Converts a business-local wall-clock date+time into a true UTC ISO string.
 * Two-pass guess-and-correct: forms a UTC guess from the raw digits, reads
 * back what wall-clock that instant shows in the target zone, shifts by the
 * delta, then repeats once so a slot landing exactly on a DST transition
 * still resolves correctly.
 */
export function localWallClockToUtcIso(
  dateStr: string,
  timeStr: string,
  ianaTimeZone: string,
): string {
  const targetMs = Date.parse(`${dateStr}T${timeStr}:00.000Z`);
  let guessMs = targetMs;

  for (let i = 0; i < 2; i++) {
    const observed = formatInZone(new Date(guessMs), ianaTimeZone);
    const deltaMs = targetMs - observed.epochMs;
    if (deltaMs === 0) break;
    guessMs += deltaMs;
  }

  return new Date(guessMs).toISOString();
}

/** Inverse of localWallClockToUtcIso — true UTC instant → business-local parts. */
export function utcIsoToLocalParts(
  utcIso: string,
  ianaTimeZone: string,
): { date: string; time: string; dayOfWeek: number } {
  const { date, time, dayOfWeek } = formatInZone(new Date(utcIso), ianaTimeZone);
  return { date, time, dayOfWeek };
}

/** Business-local calendar day → its [start, end) window expressed in true UTC. */
export function localDateRangeToUtcIso(
  dateStr: string,
  ianaTimeZone: string,
): { startUtcIso: string; endUtcIsoExclusive: string } {
  const startUtcIso = localWallClockToUtcIso(dateStr, "00:00", ianaTimeZone);
  const nextDay = new Date(Date.parse(`${dateStr}T00:00:00.000Z`) + 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const endUtcIsoExclusive = localWallClockToUtcIso(nextDay, "00:00", ianaTimeZone);
  return { startUtcIso, endUtcIsoExclusive };
}

export function isValidIanaTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
