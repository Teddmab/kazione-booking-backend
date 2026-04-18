import { Resend } from "resend";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

const DEFAULT_FROM = "KaziOne Booking <noreply@kazionebooking.com>";

/**
 * Send a transactional email via Resend.
 */
export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  from?: string,
) {
  if (!resend) {
    console.warn("RESEND_API_KEY is not configured; skipping transactional email send");
    return;
  }

  const { error } = await resend.emails.send({
    from: from ?? DEFAULT_FROM,
    to,
    subject,
    html,
  });

  if (error) {
    throw new Error(`Resend error: ${JSON.stringify(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Locale-aware email templates
// ---------------------------------------------------------------------------

type Locale = "en" | "et" | "fr";

interface BookingEmailData {
  clientName: string;
  salonName: string;
  serviceName: string;
  staffName: string;
  date: string;       // formatted date
  time: string;       // formatted time
  reference: string;  // KZB-XXXXX
  price: string;      // e.g. "€120.00"
  manageUrl: string;  // link to view / cancel / reschedule
}

interface StaffInviteData {
  salonName: string;
  inviterName: string;
  acceptUrl: string;
}

interface ReviewRequestData {
  clientName: string;
  salonName: string;
  serviceName: string;
  reviewUrl: string;
}

// ── Booking confirmation ──────────────────────────────────────────────────

const bookingConfirmationTemplates: Record<Locale, (d: BookingEmailData) => { subject: string; html: string }> = {
  en: (d) => ({
    subject: `Booking Confirmed — ${d.reference}`,
    html: `
      <h2>Your booking is confirmed!</h2>
      <p>Hi ${d.clientName},</p>
      <p>Your appointment at <strong>${d.salonName}</strong> has been confirmed.</p>
      <table style="border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:4px 12px 4px 0;color:#666">Service</td><td><strong>${d.serviceName}</strong></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Stylist</td><td>${d.staffName}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Date</td><td>${d.date}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Time</td><td>${d.time}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Price</td><td>${d.price}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Reference</td><td><code>${d.reference}</code></td></tr>
      </table>
      <p><a href="${d.manageUrl}" style="display:inline-block;padding:10px 24px;background:#C9873E;color:#fff;text-decoration:none;border-radius:6px">Manage Booking</a></p>
      <p style="color:#999;font-size:12px">If you need to reschedule or cancel, please do so at least 24 hours in advance.</p>
    `,
  }),
  et: (d) => ({
    subject: `Broneering kinnitatud — ${d.reference}`,
    html: `
      <h2>Teie broneering on kinnitatud!</h2>
      <p>Tere ${d.clientName},</p>
      <p>Teie kohtumine kohas <strong>${d.salonName}</strong> on kinnitatud.</p>
      <table style="border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:4px 12px 4px 0;color:#666">Teenus</td><td><strong>${d.serviceName}</strong></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Stilist</td><td>${d.staffName}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Kuupäev</td><td>${d.date}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Kellaaeg</td><td>${d.time}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Hind</td><td>${d.price}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Viide</td><td><code>${d.reference}</code></td></tr>
      </table>
      <p><a href="${d.manageUrl}" style="display:inline-block;padding:10px 24px;background:#C9873E;color:#fff;text-decoration:none;border-radius:6px">Halda broneeringut</a></p>
    `,
  }),
  fr: (d) => ({
    subject: `Réservation confirmée — ${d.reference}`,
    html: `
      <h2>Votre réservation est confirmée !</h2>
      <p>Bonjour ${d.clientName},</p>
      <p>Votre rendez-vous chez <strong>${d.salonName}</strong> a été confirmé.</p>
      <table style="border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:4px 12px 4px 0;color:#666">Service</td><td><strong>${d.serviceName}</strong></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Styliste</td><td>${d.staffName}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Date</td><td>${d.date}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Heure</td><td>${d.time}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Prix</td><td>${d.price}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Référence</td><td><code>${d.reference}</code></td></tr>
      </table>
      <p><a href="${d.manageUrl}" style="display:inline-block;padding:10px 24px;background:#C9873E;color:#fff;text-decoration:none;border-radius:6px">Gérer la réservation</a></p>
    `,
  }),
};

// ── Booking reminder ──────────────────────────────────────────────────────

const bookingReminderTemplates: Record<Locale, (d: BookingEmailData) => { subject: string; html: string }> = {
  en: (d) => ({
    subject: `Reminder: Your appointment tomorrow — ${d.reference}`,
    html: `
      <h2>Appointment Reminder</h2>
      <p>Hi ${d.clientName}, just a reminder that you have an appointment tomorrow:</p>
      <p><strong>${d.serviceName}</strong> with ${d.staffName} at ${d.time} on ${d.date}.</p>
      <p><a href="${d.manageUrl}" style="display:inline-block;padding:10px 24px;background:#C9873E;color:#fff;text-decoration:none;border-radius:6px">View Booking</a></p>
    `,
  }),
  et: (d) => ({
    subject: `Meeldetuletus: Teie kohtumine homme — ${d.reference}`,
    html: `
      <h2>Kohtumise meeldetuletus</h2>
      <p>Tere ${d.clientName}, tuletame meelde, et Teil on homme kohtumine:</p>
      <p><strong>${d.serviceName}</strong> stilistiga ${d.staffName} kell ${d.time}, ${d.date}.</p>
      <p><a href="${d.manageUrl}" style="display:inline-block;padding:10px 24px;background:#C9873E;color:#fff;text-decoration:none;border-radius:6px">Vaata broneeringut</a></p>
    `,
  }),
  fr: (d) => ({
    subject: `Rappel : Votre rendez-vous demain — ${d.reference}`,
    html: `
      <h2>Rappel de rendez-vous</h2>
      <p>Bonjour ${d.clientName}, un rappel de votre rendez-vous demain :</p>
      <p><strong>${d.serviceName}</strong> avec ${d.staffName} à ${d.time} le ${d.date}.</p>
      <p><a href="${d.manageUrl}" style="display:inline-block;padding:10px 24px;background:#C9873E;color:#fff;text-decoration:none;border-radius:6px">Voir la réservation</a></p>
    `,
  }),
};

// ── Booking cancellation ──────────────────────────────────────────────────

const bookingCancellationTemplates: Record<Locale, (d: BookingEmailData) => { subject: string; html: string }> = {
  en: (d) => ({
    subject: `Booking Cancelled — ${d.reference}`,
    html: `
      <h2>Booking Cancelled</h2>
      <p>Hi ${d.clientName},</p>
      <p>Your appointment for <strong>${d.serviceName}</strong> at ${d.salonName} on ${d.date} at ${d.time} has been cancelled.</p>
      <p>Reference: <code>${d.reference}</code></p>
      <p>If this was a mistake, you can book a new appointment at any time.</p>
    `,
  }),
  et: (d) => ({
    subject: `Broneering tühistatud — ${d.reference}`,
    html: `
      <h2>Broneering tühistatud</h2>
      <p>Tere ${d.clientName},</p>
      <p>Teie kohtumine teenusele <strong>${d.serviceName}</strong> kohas ${d.salonName}, ${d.date} kell ${d.time}, on tühistatud.</p>
      <p>Viide: <code>${d.reference}</code></p>
    `,
  }),
  fr: (d) => ({
    subject: `Réservation annulée — ${d.reference}`,
    html: `
      <h2>Réservation annulée</h2>
      <p>Bonjour ${d.clientName},</p>
      <p>Votre rendez-vous pour <strong>${d.serviceName}</strong> chez ${d.salonName} le ${d.date} à ${d.time} a été annulé.</p>
      <p>Référence : <code>${d.reference}</code></p>
    `,
  }),
};

// ── Booking reschedule ────────────────────────────────────────────────────

const bookingRescheduleTemplates: Record<Locale, (d: BookingEmailData) => { subject: string; html: string }> = {
  en: (d) => ({
    subject: `Booking Rescheduled — ${d.reference}`,
    html: `
      <h2>Booking Rescheduled</h2>
      <p>Hi ${d.clientName},</p>
      <p>Your appointment has been rescheduled to:</p>
      <p><strong>${d.serviceName}</strong> with ${d.staffName}<br>${d.date} at ${d.time}</p>
      <p><a href="${d.manageUrl}" style="display:inline-block;padding:10px 24px;background:#C9873E;color:#fff;text-decoration:none;border-radius:6px">View Updated Booking</a></p>
    `,
  }),
  et: (d) => ({
    subject: `Broneering muudetud — ${d.reference}`,
    html: `
      <h2>Broneering muudetud</h2>
      <p>Tere ${d.clientName},</p>
      <p>Teie kohtumine on ümber planeeritud:</p>
      <p><strong>${d.serviceName}</strong> stilistiga ${d.staffName}<br>${d.date} kell ${d.time}</p>
      <p><a href="${d.manageUrl}" style="display:inline-block;padding:10px 24px;background:#C9873E;color:#fff;text-decoration:none;border-radius:6px">Vaata uuendatud broneeringut</a></p>
    `,
  }),
  fr: (d) => ({
    subject: `Réservation reprogrammée — ${d.reference}`,
    html: `
      <h2>Réservation reprogrammée</h2>
      <p>Bonjour ${d.clientName},</p>
      <p>Votre rendez-vous a été reprogrammé :</p>
      <p><strong>${d.serviceName}</strong> avec ${d.staffName}<br>${d.date} à ${d.time}</p>
      <p><a href="${d.manageUrl}" style="display:inline-block;padding:10px 24px;background:#C9873E;color:#fff;text-decoration:none;border-radius:6px">Voir la réservation mise à jour</a></p>
    `,
  }),
};

// ── Staff invite ──────────────────────────────────────────────────────────

const staffInviteTemplates: Record<Locale, (d: StaffInviteData) => { subject: string; html: string }> = {
  en: (d) => ({
    subject: `You've been invited to join ${d.salonName}`,
    html: `
      <h2>Team Invitation</h2>
      <p>${d.inviterName} has invited you to join <strong>${d.salonName}</strong> on KaziOne Booking.</p>
      <p><a href="${d.acceptUrl}" style="display:inline-block;padding:10px 24px;background:#C9873E;color:#fff;text-decoration:none;border-radius:6px">Accept Invitation</a></p>
    `,
  }),
  et: (d) => ({
    subject: `Teid kutsuti liituma saloniga ${d.salonName}`,
    html: `
      <h2>Meeskonna kutse</h2>
      <p>${d.inviterName} kutsus Teid liituma saloniga <strong>${d.salonName}</strong> KaziOne Booking platvormil.</p>
      <p><a href="${d.acceptUrl}" style="display:inline-block;padding:10px 24px;background:#C9873E;color:#fff;text-decoration:none;border-radius:6px">Nõustu kutsega</a></p>
    `,
  }),
  fr: (d) => ({
    subject: `Vous avez été invité(e) à rejoindre ${d.salonName}`,
    html: `
      <h2>Invitation d'équipe</h2>
      <p>${d.inviterName} vous a invité(e) à rejoindre <strong>${d.salonName}</strong> sur KaziOne Booking.</p>
      <p><a href="${d.acceptUrl}" style="display:inline-block;padding:10px 24px;background:#C9873E;color:#fff;text-decoration:none;border-radius:6px">Accepter l'invitation</a></p>
    `,
  }),
};

// ── Review request ────────────────────────────────────────────────────────

const reviewRequestTemplates: Record<Locale, (d: ReviewRequestData) => { subject: string; html: string }> = {
  en: (d) => ({
    subject: `How was your visit to ${d.salonName}?`,
    html: `
      <h2>We'd love your feedback!</h2>
      <p>Hi ${d.clientName},</p>
      <p>Thank you for visiting <strong>${d.salonName}</strong> for your <strong>${d.serviceName}</strong> appointment.</p>
      <p>Would you take a moment to leave a review?</p>
      <p><a href="${d.reviewUrl}" style="display:inline-block;padding:10px 24px;background:#C9873E;color:#fff;text-decoration:none;border-radius:6px">Leave a Review</a></p>
    `,
  }),
  et: (d) => ({
    subject: `Kuidas oli Teie külastus salongis ${d.salonName}?`,
    html: `
      <h2>Ootame Teie tagasisidet!</h2>
      <p>Tere ${d.clientName},</p>
      <p>Täname, et külastasite salongi <strong>${d.salonName}</strong> teenusele <strong>${d.serviceName}</strong>.</p>
      <p><a href="${d.reviewUrl}" style="display:inline-block;padding:10px 24px;background:#C9873E;color:#fff;text-decoration:none;border-radius:6px">Jäta arvustus</a></p>
    `,
  }),
  fr: (d) => ({
    subject: `Comment s'est passée votre visite chez ${d.salonName} ?`,
    html: `
      <h2>Votre avis nous intéresse !</h2>
      <p>Bonjour ${d.clientName},</p>
      <p>Merci d'avoir visité <strong>${d.salonName}</strong> pour votre rendez-vous <strong>${d.serviceName}</strong>.</p>
      <p><a href="${d.reviewUrl}" style="display:inline-block;padding:10px 24px;background:#C9873E;color:#fff;text-decoration:none;border-radius:6px">Laisser un avis</a></p>
    `,
  }),
};

// ---------------------------------------------------------------------------
// Public template accessors
// ---------------------------------------------------------------------------

function resolveLocale(locale?: string): Locale {
  if (locale === "et" || locale === "fr") return locale;
  return "en";
}

export function bookingConfirmationEmail(data: BookingEmailData, locale?: string) {
  return bookingConfirmationTemplates[resolveLocale(locale)](data);
}

export function bookingReminderEmail(data: BookingEmailData, locale?: string) {
  return bookingReminderTemplates[resolveLocale(locale)](data);
}

export function bookingCancellationEmail(data: BookingEmailData, locale?: string) {
  return bookingCancellationTemplates[resolveLocale(locale)](data);
}

export function bookingRescheduleEmail(data: BookingEmailData, locale?: string) {
  return bookingRescheduleTemplates[resolveLocale(locale)](data);
}

export function staffInviteEmail(data: StaffInviteData, locale?: string) {
  return staffInviteTemplates[resolveLocale(locale)](data);
}

export function reviewRequestEmail(data: ReviewRequestData, locale?: string) {
  return reviewRequestTemplates[resolveLocale(locale)](data);
}
