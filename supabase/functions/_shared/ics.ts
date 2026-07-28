/**
 * Minimal RFC 5545 iCalendar (.ics) generator.
 * Generates VCALENDAR / VEVENT strings suitable for email attachments.
 */

function fmtDt(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function fold(line: string): string {
  // RFC 5545 §3.1 — content lines MUST NOT exceed 75 octets; fold with CRLF + space.
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const chunks: string[] = [];
  let pos = 0;
  let first = true;
  while (pos < bytes.length) {
    const maxBytes = first ? 75 : 74;
    const slice = bytes.slice(pos, pos + maxBytes);
    chunks.push((first ? "" : " ") + new TextDecoder().decode(slice));
    pos += maxBytes;
    first = false;
  }
  return chunks.join("\r\n");
}

function escVal(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

export interface IcsEvent {
  uid: string;
  summary: string;
  description?: string;
  location?: string;
  startAt: Date;
  endAt: Date;
  organizerEmail?: string;
  organizerName?: string;
  attendeeEmail?: string;
  /** Cancel an existing event (for cancellation notifications). Default: false */
  cancel?: boolean;
  /** Reminder minutes before the event. Default 1440 (24 h). */
  reminderMinutes?: number;
}

export function generateIcs(event: IcsEvent): string {
  const method = event.cancel ? "CANCEL" : "REQUEST";
  const status = event.cancel ? "CANCELLED" : "CONFIRMED";
  const reminderMins = event.reminderMinutes ?? 1440;

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//KaziOne//Booking//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${escVal(event.uid)}`,
    `DTSTAMP:${fmtDt(new Date())}`,
    `DTSTART:${fmtDt(event.startAt)}`,
    `DTEND:${fmtDt(event.endAt)}`,
    `SUMMARY:${escVal(event.summary)}`,
    `STATUS:${status}`,
  ];

  if (event.description) lines.push(`DESCRIPTION:${escVal(event.description)}`);
  if (event.location) lines.push(`LOCATION:${escVal(event.location)}`);
  if (event.organizerEmail) {
    const cn = event.organizerName ? `CN="${escVal(event.organizerName)}":` : ":";
    lines.push(`ORGANIZER;${cn}mailto:${event.organizerEmail}`);
  }
  if (event.attendeeEmail) {
    lines.push(`ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:${event.attendeeEmail}`);
  }

  if (!event.cancel) {
    lines.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `TRIGGER:-PT${reminderMins}M`,
      "DESCRIPTION:Appointment reminder",
      "END:VALARM",
    );
  }

  lines.push("END:VEVENT", "END:VCALENDAR");

  return lines.map(fold).join("\r\n");
}

/** Base64-encode an ICS string for use as a Resend attachment. */
export function icsToBase64(ics: string): string {
  return btoa(unescape(encodeURIComponent(ics)));
}

/** Build an "Add to Google Calendar" URL from an ICS event. */
export function googleCalendarUrl(event: IcsEvent): string {
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.summary,
    dates: `${fmt(event.startAt)}/${fmt(event.endAt)}`,
    details: event.description ?? "",
    location: event.location ?? "",
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
