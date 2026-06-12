import { Resend } from "resend";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

const DEFAULT_FROM = Deno.env.get("BUSINESS_EMAIL_FROM") ??
  "KaziOne Booking <onboarding@resend.dev>";

/**
 * Send a transactional email via Resend.
 */
export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  from?: string,
  replyTo?: string,
) {
  if (!resend) {
    console.warn(
      "RESEND_API_KEY is not configured; skipping transactional email send",
    );
    return;
  }

  const { error } = await resend.emails.send({
    from: from ?? DEFAULT_FROM,
    to,
    subject,
    html,
    reply_to: replyTo,
  });

  if (error) {
    throw new Error(`Resend error: ${JSON.stringify(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Brand tokens (kept in sync with the app's Tailwind config)
// ---------------------------------------------------------------------------

const B = {
  bg: "#FDF3F0",         // warm off-white — email outer background
  card: "#FFFFFF",
  border: "#F0DDD8",
  rowBg: "#FDF3F0",
  orange: "#E84E26",     // brand primary (#E84E26 from BRAND_ANALYSIS.md)
  orangeDark: "#C43D1A",
  textDark: "#1A0F0A",
  textMid: "#6B4C42",
  textDim: "#9B7B72",
  textLight: "#C4B5B0",
};

// ---------------------------------------------------------------------------
// Shared layout builder
// ---------------------------------------------------------------------------

interface LayoutOptions {
  /** Salon logo URL — shown large in the header when present */
  salonLogoUrl?: string;
  /** Salon name — used as text fallback when no logo */
  salonName: string;
  /** Subject line (used in <title> only) */
  subject: string;
  /** Main body HTML (heading, paragraphs, table, CTA, etc.) */
  body: string;
}

function renderEmail({ salonLogoUrl, salonName, subject, body }: LayoutOptions): string {
  const year = new Date().getFullYear();

  const headerContent = salonLogoUrl
    ? `<img src="${salonLogoUrl}" alt="${salonName}" width="auto" height="56"
         style="max-height:56px;max-width:200px;object-fit:contain;display:block;margin:0 auto;" />`
    : `<div style="display:inline-block;padding:8px 20px;background:${B.rowBg};border-radius:8px;border:1px solid ${B.border};">
         <span style="font-family:'Plus Jakarta Sans',Helvetica,Arial,sans-serif;font-size:18px;font-weight:700;color:${B.textDark};letter-spacing:-0.3px;">${salonName}</span>
       </div>`;

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>${subject}</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
  <![endif]-->
  <style>
    body, table, td { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
    table, td { mso-table-lspace:0pt; mso-table-rspace:0pt; }
    img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
    @media only screen and (max-width:600px) {
      .outer-td { padding: 16px 8px !important; }
      .card { border-radius: 0 !important; }
      .card-padding { padding: 24px 20px !important; }
      .card-header { padding: 24px 20px 20px !important; }
      .card-footer { padding: 16px 20px 24px !important; }
      .detail-row td { display: block !important; width: 100% !important; padding: 4px 0 !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:${B.bg};">

<!-- Outer wrapper -->
<table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation"
  style="background-color:${B.bg};min-height:100vh;">
  <tr>
    <td class="outer-td" align="center" valign="top" style="padding:40px 16px;">

      <!-- Card -->
      <table class="card" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation"
        style="max-width:560px;background-color:${B.card};border-radius:12px;overflow:hidden;border:1px solid ${B.border};">

        <!-- Orange accent line -->
        <tr>
          <td height="3" style="background-color:${B.orange};font-size:0;line-height:0;">&nbsp;</td>
        </tr>

        <!-- Salon header -->
        <tr>
          <td class="card-header" align="center"
            style="padding:28px 40px 24px;border-bottom:1px solid ${B.border};">
            ${headerContent}
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td class="card-padding" style="padding:32px 40px;">
            ${body}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td class="card-footer" align="center"
            style="padding:18px 40px 28px;border-top:1px solid ${B.border};background-color:${B.rowBg};">

            <!-- KaziOne mark -->
            <table align="center" border="0" cellpadding="0" cellspacing="0" role="presentation">
              <tr>
                <td width="24" height="24" align="center" valign="middle"
                  style="width:24px;height:24px;">
                  <img src="https://kazione.app/logo.png" alt="KaziOne"
                    width="24" height="24"
                    style="display:block;width:24px;height:24px;" />
                </td>
                <td width="7" style="width:7px;">&nbsp;</td>
                <td valign="middle">
                  <span style="font-family:'Plus Jakarta Sans',Helvetica,Arial,sans-serif;font-size:12px;color:${B.textDim};font-weight:600;letter-spacing:-0.1px;">
                    KaziOne Booking
                  </span>
                </td>
              </tr>
            </table>

            <p style="margin:10px 0 0;font-family:'Plus Jakarta Sans',Helvetica,Arial,sans-serif;font-size:11px;color:${B.textLight};line-height:1.5;">
              &copy; ${year} KaziOne Booking. All rights reserved.
            </p>
          </td>
        </tr>

      </table>
      <!-- /Card -->

    </td>
  </tr>
</table>

</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Reusable email building blocks
// ---------------------------------------------------------------------------

function heading(text: string): string {
  return `<h1 style="margin:0 0 8px;font-family:'Plus Jakarta Sans',Helvetica,Arial,sans-serif;font-size:22px;font-weight:700;color:${B.textDark};letter-spacing:-0.4px;line-height:1.3;">${text}</h1>`;
}

function paragraph(text: string, style = ""): string {
  return `<p style="margin:0 0 16px;font-family:'Plus Jakarta Sans',Helvetica,Arial,sans-serif;font-size:15px;color:${B.textMid};line-height:1.65;${style}">${text}</p>`;
}

function detailTable(rows: [string, string][]): string {
  const rowsHtml = rows.map(([label, value]) => `
    <tr class="detail-row">
      <td style="padding:9px 16px 9px 0;font-family:'Plus Jakarta Sans',Helvetica,Arial,sans-serif;font-size:12px;color:${B.textDim};font-weight:500;white-space:nowrap;vertical-align:top;text-transform:uppercase;letter-spacing:0.5px;">
        ${label}
      </td>
      <td style="padding:9px 0;font-family:'Plus Jakarta Sans',Helvetica,Arial,sans-serif;font-size:14px;color:${B.textDark};font-weight:500;vertical-align:top;">
        ${value}
      </td>
    </tr>`).join("");

  return `
    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation"
      style="background-color:${B.rowBg};border-radius:8px;border:1px solid ${B.border};margin:20px 0 24px;border-collapse:separate;">
      <tr>
        <td style="padding:4px 16px;">
          <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
            ${rowsHtml}
          </table>
        </td>
      </tr>
    </table>`;
}

function ctaButton(label: string, url: string): string {
  return `
    <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="margin:24px 0 8px;">
      <tr>
        <td align="center" style="border-radius:8px;background-color:${B.orange};">
          <a href="${url}" target="_blank"
            style="display:inline-block;padding:13px 28px;font-family:'Plus Jakarta Sans',Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;letter-spacing:-0.1px;mso-padding-alt:0;">
            ${label}
          </a>
        </td>
      </tr>
    </table>`;
}

function referenceChip(ref: string): string {
  return `<span style="display:inline-block;padding:3px 10px;background-color:${B.rowBg};border:1px solid ${B.border};border-radius:5px;font-family:'Plus Jakarta Sans',Helvetica,Arial,sans-serif;font-size:12px;color:${B.textMid};font-weight:600;letter-spacing:0.5px;">${ref}</span>`;
}

// ---------------------------------------------------------------------------
// Template data types
// ---------------------------------------------------------------------------

type Locale = "en" | "et" | "fr";

interface BookingEmailData {
  clientName: string;
  salonName: string;
  salonLogoUrl?: string;
  serviceName: string;
  staffName: string;
  date: string;
  time: string;
  reference: string;
  price: string;
  manageUrl: string;
  daysUntil?: string; // "0" = today, "1" = tomorrow, "7" = in 7 days etc.
}

interface StaffInviteData {
  salonName: string;
  salonLogoUrl?: string;
  inviterName: string;
  acceptUrl: string;
}

interface ReviewRequestData {
  clientName: string;
  salonName: string;
  salonLogoUrl?: string;
  serviceName: string;
  reviewUrl: string;
}

// ---------------------------------------------------------------------------
// Booking confirmation
// ---------------------------------------------------------------------------

const bookingConfirmationTemplates: Record<
  Locale,
  (d: BookingEmailData) => { subject: string; html: string }
> = {
  en: (d) => {
    const subject = `Booking Confirmed — ${d.reference}`;
    return {
      subject,
      html: renderEmail({
        salonLogoUrl: d.salonLogoUrl,
        salonName: d.salonName,
        subject,
        body: `
          ${heading("Your booking is confirmed!")}
          ${paragraph(`Hi <strong style="color:${B.textDark};">${d.clientName}</strong>, your appointment at <strong style="color:${B.textDark};">${d.salonName}</strong> is all set.`)}
          ${detailTable([
            ["Service", `<strong>${d.serviceName}</strong>`],
            ["Stylist", d.staffName],
            ["Date", d.date],
            ["Time", d.time],
            ["Price", d.price],
            ["Reference", referenceChip(d.reference)],
          ])}
          ${ctaButton("Manage Booking", d.manageUrl)}
          ${paragraph(`Need to reschedule or cancel? Please do so at least 24 hours in advance.`, `font-size:13px;color:${B.textDim};margin-top:16px;`)}
        `,
      }),
    };
  },
  et: (d) => {
    const subject = `Broneering kinnitatud — ${d.reference}`;
    return {
      subject,
      html: renderEmail({
        salonLogoUrl: d.salonLogoUrl,
        salonName: d.salonName,
        subject,
        body: `
          ${heading("Teie broneering on kinnitatud!")}
          ${paragraph(`Tere <strong style="color:${B.textDark};">${d.clientName}</strong>, Teie kohtumine kohas <strong style="color:${B.textDark};">${d.salonName}</strong> on kinnitatud.`)}
          ${detailTable([
            ["Teenus", `<strong>${d.serviceName}</strong>`],
            ["Stilist", d.staffName],
            ["Kuupäev", d.date],
            ["Kellaaeg", d.time],
            ["Hind", d.price],
            ["Viide", referenceChip(d.reference)],
          ])}
          ${ctaButton("Halda broneeringut", d.manageUrl)}
          ${paragraph(`Ümberplaneerimiseks või tühistamiseks palume seda teha vähemalt 24 tundi ette.`, `font-size:13px;color:${B.textDim};margin-top:16px;`)}
        `,
      }),
    };
  },
  fr: (d) => {
    const subject = `Réservation confirmée — ${d.reference}`;
    return {
      subject,
      html: renderEmail({
        salonLogoUrl: d.salonLogoUrl,
        salonName: d.salonName,
        subject,
        body: `
          ${heading("Votre réservation est confirmée !")}
          ${paragraph(`Bonjour <strong style="color:${B.textDark};">${d.clientName}</strong>, votre rendez-vous chez <strong style="color:${B.textDark};">${d.salonName}</strong> est confirmé.`)}
          ${detailTable([
            ["Service", `<strong>${d.serviceName}</strong>`],
            ["Styliste", d.staffName],
            ["Date", d.date],
            ["Heure", d.time],
            ["Prix", d.price],
            ["Référence", referenceChip(d.reference)],
          ])}
          ${ctaButton("Gérer la réservation", d.manageUrl)}
          ${paragraph(`Pour reprogrammer ou annuler, merci de le faire au moins 24 heures à l'avance.`, `font-size:13px;color:${B.textDim};margin-top:16px;`)}
        `,
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// Booking reminder
// ---------------------------------------------------------------------------

const bookingReminderTemplates: Record<
  Locale,
  (d: BookingEmailData) => { subject: string; html: string }
> = {
  en: (d) => {
    const days = d.daysUntil !== undefined ? parseInt(d.daysUntil) : 1;
    const when = days === 0 ? "today" : days === 1 ? "tomorrow" : `on ${d.date}`;
    const heading_ = days === 0 ? "See you today!" : days === 1 ? "See you tomorrow!" : `See you on ${d.date}!`;
    const subject = `Reminder: Your appointment ${when} — ${d.reference}`;
    return {
      subject,
      html: renderEmail({
        salonLogoUrl: d.salonLogoUrl,
        salonName: d.salonName,
        subject,
        body: `
          ${heading(heading_)}
          ${paragraph(`Hi <strong style="color:${B.textDark};">${d.clientName}</strong>, just a friendly reminder about your appointment ${when}.`)}
          ${detailTable([
            ["Service", `<strong>${d.serviceName}</strong>`],
            ["Stylist", d.staffName],
            ["Date", d.date],
            ["Time", d.time],
            ["Price", d.price],
            ["Reference", referenceChip(d.reference)],
          ])}
          ${ctaButton("View Booking", d.manageUrl)}
        `,
      }),
    };
  },
  et: (d) => {
    const days = d.daysUntil !== undefined ? parseInt(d.daysUntil) : 1;
    const when = days === 0 ? "täna" : days === 1 ? "homme" : `${d.date}`;
    const heading_ = days === 0 ? "Kohtumiseni täna!" : days === 1 ? "Kohtumiseni homme!" : `Kohtumiseni ${d.date}!`;
    const subject = `Meeldetuletus: Teie kohtumine ${when} — ${d.reference}`;
    return {
      subject,
      html: renderEmail({
        salonLogoUrl: d.salonLogoUrl,
        salonName: d.salonName,
        subject,
        body: `
          ${heading(heading_)}
          ${paragraph(`Tere <strong style="color:${B.textDark};">${d.clientName}</strong>, tuletame meelde Teie kohtumist ${when}.`)}
          ${detailTable([
            ["Teenus", `<strong>${d.serviceName}</strong>`],
            ["Stilist", d.staffName],
            ["Kuupäev", d.date],
            ["Kellaaeg", d.time],
            ["Hind", d.price],
            ["Viide", referenceChip(d.reference)],
          ])}
          ${ctaButton("Vaata broneeringut", d.manageUrl)}
        `,
      }),
    };
  },
  fr: (d) => {
    const days = d.daysUntil !== undefined ? parseInt(d.daysUntil) : 1;
    const when = days === 0 ? "aujourd'hui" : days === 1 ? "demain" : `le ${d.date}`;
    const heading_ = days === 0 ? "À tout à l'heure !" : days === 1 ? "À demain !" : `À ${when} !`;
    const subject = `Rappel : Votre rendez-vous ${when} — ${d.reference}`;
    return {
      subject,
      html: renderEmail({
        salonLogoUrl: d.salonLogoUrl,
        salonName: d.salonName,
        subject,
        body: `
          ${heading(heading_)}
          ${paragraph(`Bonjour <strong style="color:${B.textDark};">${d.clientName}</strong>, un rappel pour votre rendez-vous ${when}.`)}
          ${detailTable([
            ["Service", `<strong>${d.serviceName}</strong>`],
            ["Styliste", d.staffName],
            ["Date", d.date],
            ["Heure", d.time],
            ["Prix", d.price],
            ["Référence", referenceChip(d.reference)],
          ])}
          ${ctaButton("Voir la réservation", d.manageUrl)}
        `,
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// Booking cancellation
// ---------------------------------------------------------------------------

const bookingCancellationTemplates: Record<
  Locale,
  (d: BookingEmailData) => { subject: string; html: string }
> = {
  en: (d) => {
    const subject = `Booking Cancelled — ${d.reference}`;
    return {
      subject,
      html: renderEmail({
        salonLogoUrl: d.salonLogoUrl,
        salonName: d.salonName,
        subject,
        body: `
          ${heading("Your booking has been cancelled")}
          ${paragraph(`Hi <strong style="color:${B.textDark};">${d.clientName}</strong>, your appointment has been cancelled.`)}
          ${detailTable([
            ["Service", `<strong>${d.serviceName}</strong>`],
            ["Date", d.date],
            ["Time", d.time],
            ["Reference", referenceChip(d.reference)],
          ])}
          ${paragraph(`If this was a mistake or you'd like to rebook, you can do so at any time.`)}
          ${ctaButton("Book Again", d.manageUrl)}
        `,
      }),
    };
  },
  et: (d) => {
    const subject = `Broneering tühistatud — ${d.reference}`;
    return {
      subject,
      html: renderEmail({
        salonLogoUrl: d.salonLogoUrl,
        salonName: d.salonName,
        subject,
        body: `
          ${heading("Teie broneering on tühistatud")}
          ${paragraph(`Tere <strong style="color:${B.textDark};">${d.clientName}</strong>, Teie kohtumine on tühistatud.`)}
          ${detailTable([
            ["Teenus", `<strong>${d.serviceName}</strong>`],
            ["Kuupäev", d.date],
            ["Kellaaeg", d.time],
            ["Viide", referenceChip(d.reference)],
          ])}
          ${paragraph(`Kui soovite uuesti broneerida, saate seda igal ajal teha.`)}
          ${ctaButton("Broneeri uuesti", d.manageUrl)}
        `,
      }),
    };
  },
  fr: (d) => {
    const subject = `Réservation annulée — ${d.reference}`;
    return {
      subject,
      html: renderEmail({
        salonLogoUrl: d.salonLogoUrl,
        salonName: d.salonName,
        subject,
        body: `
          ${heading("Votre réservation a été annulée")}
          ${paragraph(`Bonjour <strong style="color:${B.textDark};">${d.clientName}</strong>, votre rendez-vous a été annulé.`)}
          ${detailTable([
            ["Service", `<strong>${d.serviceName}</strong>`],
            ["Date", d.date],
            ["Heure", d.time],
            ["Référence", referenceChip(d.reference)],
          ])}
          ${paragraph(`Si vous souhaitez reprendre rendez-vous, vous pouvez le faire à tout moment.`)}
          ${ctaButton("Reprendre rendez-vous", d.manageUrl)}
        `,
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// Booking reschedule
// ---------------------------------------------------------------------------

const bookingRescheduleTemplates: Record<
  Locale,
  (d: BookingEmailData) => { subject: string; html: string }
> = {
  en: (d) => {
    const subject = `Booking Rescheduled — ${d.reference}`;
    return {
      subject,
      html: renderEmail({
        salonLogoUrl: d.salonLogoUrl,
        salonName: d.salonName,
        subject,
        body: `
          ${heading("Your booking has been rescheduled")}
          ${paragraph(`Hi <strong style="color:${B.textDark};">${d.clientName}</strong>, your appointment has been moved to a new time.`)}
          ${detailTable([
            ["Service", `<strong>${d.serviceName}</strong>`],
            ["Stylist", d.staffName],
            ["New date", d.date],
            ["New time", d.time],
            ["Price", d.price],
            ["Reference", referenceChip(d.reference)],
          ])}
          ${ctaButton("View Updated Booking", d.manageUrl)}
        `,
      }),
    };
  },
  et: (d) => {
    const subject = `Broneering muudetud — ${d.reference}`;
    return {
      subject,
      html: renderEmail({
        salonLogoUrl: d.salonLogoUrl,
        salonName: d.salonName,
        subject,
        body: `
          ${heading("Teie broneering on ümber planeeritud")}
          ${paragraph(`Tere <strong style="color:${B.textDark};">${d.clientName}</strong>, Teie kohtumine on viidud uuele ajale.`)}
          ${detailTable([
            ["Teenus", `<strong>${d.serviceName}</strong>`],
            ["Stilist", d.staffName],
            ["Uus kuupäev", d.date],
            ["Uus kellaaeg", d.time],
            ["Hind", d.price],
            ["Viide", referenceChip(d.reference)],
          ])}
          ${ctaButton("Vaata uuendatud broneeringut", d.manageUrl)}
        `,
      }),
    };
  },
  fr: (d) => {
    const subject = `Réservation reprogrammée — ${d.reference}`;
    return {
      subject,
      html: renderEmail({
        salonLogoUrl: d.salonLogoUrl,
        salonName: d.salonName,
        subject,
        body: `
          ${heading("Votre rendez-vous a été reprogrammé")}
          ${paragraph(`Bonjour <strong style="color:${B.textDark};">${d.clientName}</strong>, votre rendez-vous a été déplacé.`)}
          ${detailTable([
            ["Service", `<strong>${d.serviceName}</strong>`],
            ["Styliste", d.staffName],
            ["Nouvelle date", d.date],
            ["Nouvelle heure", d.time],
            ["Prix", d.price],
            ["Référence", referenceChip(d.reference)],
          ])}
          ${ctaButton("Voir la réservation mise à jour", d.manageUrl)}
        `,
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// Staff invite
// ---------------------------------------------------------------------------

const staffInviteTemplates: Record<
  Locale,
  (d: StaffInviteData) => { subject: string; html: string }
> = {
  en: (d) => {
    const subject = `You've been invited to join ${d.salonName}`;
    return {
      subject,
      html: renderEmail({
        salonLogoUrl: d.salonLogoUrl,
        salonName: d.salonName,
        subject,
        body: `
          ${heading("You're invited to join the team")}
          ${paragraph(`<strong style="color:${B.textDark};">${d.inviterName}</strong> has invited you to join <strong style="color:${B.textDark};">${d.salonName}</strong> on KaziOne Booking as a staff member.`)}
          ${paragraph(`Accept the invitation to set up your account and start managing your schedule.`)}
          ${ctaButton("Accept Invitation", d.acceptUrl)}
          ${paragraph(`This invitation link expires in 7 days. If you weren't expecting this, you can safely ignore this email.`, `font-size:13px;color:${B.textDim};margin-top:16px;`)}
        `,
      }),
    };
  },
  et: (d) => {
    const subject = `Teid kutsuti liituma saloniga ${d.salonName}`;
    return {
      subject,
      html: renderEmail({
        salonLogoUrl: d.salonLogoUrl,
        salonName: d.salonName,
        subject,
        body: `
          ${heading("Teid kutsutakse meeskonda")}
          ${paragraph(`<strong style="color:${B.textDark};">${d.inviterName}</strong> kutsus Teid liituma saloniga <strong style="color:${B.textDark};">${d.salonName}</strong> KaziOne Booking platvormil.`)}
          ${paragraph(`Nõustuge kutsega, et luua konto ja hakata oma ajakava haldama.`)}
          ${ctaButton("Nõustu kutsega", d.acceptUrl)}
          ${paragraph(`See kutse kehtib 7 päeva. Kui Te seda ei oodanud, võite selle kirja ignoreerida.`, `font-size:13px;color:${B.textDim};margin-top:16px;`)}
        `,
      }),
    };
  },
  fr: (d) => {
    const subject = `Vous avez été invité(e) à rejoindre ${d.salonName}`;
    return {
      subject,
      html: renderEmail({
        salonLogoUrl: d.salonLogoUrl,
        salonName: d.salonName,
        subject,
        body: `
          ${heading("Vous êtes invité(e) à rejoindre l'équipe")}
          ${paragraph(`<strong style="color:${B.textDark};">${d.inviterName}</strong> vous a invité(e) à rejoindre <strong style="color:${B.textDark};">${d.salonName}</strong> sur KaziOne Booking en tant que membre du personnel.`)}
          ${paragraph(`Acceptez l'invitation pour créer votre compte et commencer à gérer votre planning.`)}
          ${ctaButton("Accepter l'invitation", d.acceptUrl)}
          ${paragraph(`Ce lien expire dans 7 jours. Si vous n'attendiez pas cette invitation, vous pouvez ignorer cet e-mail.`, `font-size:13px;color:${B.textDim};margin-top:16px;`)}
        `,
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// Review request
// ---------------------------------------------------------------------------

const reviewRequestTemplates: Record<
  Locale,
  (d: ReviewRequestData) => { subject: string; html: string }
> = {
  en: (d) => {
    const subject = `How was your visit to ${d.salonName}?`;
    return {
      subject,
      html: renderEmail({
        salonLogoUrl: d.salonLogoUrl,
        salonName: d.salonName,
        subject,
        body: `
          ${heading("We'd love your feedback")}
          ${paragraph(`Hi <strong style="color:${B.textDark};">${d.clientName}</strong>, thank you for visiting <strong style="color:${B.textDark};">${d.salonName}</strong> for your <strong style="color:${B.textDark};">${d.serviceName}</strong> appointment.`)}
          ${paragraph(`Your review helps ${d.salonName} and helps other clients find great salons. It only takes a minute.`)}
          ${ctaButton("Leave a Review", d.reviewUrl)}
        `,
      }),
    };
  },
  et: (d) => {
    const subject = `Kuidas oli Teie külastus salongis ${d.salonName}?`;
    return {
      subject,
      html: renderEmail({
        salonLogoUrl: d.salonLogoUrl,
        salonName: d.salonName,
        subject,
        body: `
          ${heading("Ootame Teie tagasisidet")}
          ${paragraph(`Tere <strong style="color:${B.textDark};">${d.clientName}</strong>, täname, et külastasite salongi <strong style="color:${B.textDark};">${d.salonName}</strong> teenusele <strong style="color:${B.textDark};">${d.serviceName}</strong>.`)}
          ${paragraph(`Teie arvustus aitab teistel klientidel leida parimaid salonge. See võtab vaid minuti.`)}
          ${ctaButton("Jäta arvustus", d.reviewUrl)}
        `,
      }),
    };
  },
  fr: (d) => {
    const subject = `Comment s'est passée votre visite chez ${d.salonName} ?`;
    return {
      subject,
      html: renderEmail({
        salonLogoUrl: d.salonLogoUrl,
        salonName: d.salonName,
        subject,
        body: `
          ${heading("Votre avis nous intéresse")}
          ${paragraph(`Bonjour <strong style="color:${B.textDark};">${d.clientName}</strong>, merci d'avoir visité <strong style="color:${B.textDark};">${d.salonName}</strong> pour votre rendez-vous <strong style="color:${B.textDark};">${d.serviceName}</strong>.`)}
          ${paragraph(`Votre avis aide ${d.salonName} et aide d'autres clients à trouver de bons salons. Cela ne prend qu'une minute.`)}
          ${ctaButton("Laisser un avis", d.reviewUrl)}
        `,
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// Locale resolver
// ---------------------------------------------------------------------------

function resolveLocale(locale?: string): Locale {
  if (locale === "et" || locale === "fr") return locale;
  return "en";
}

// ---------------------------------------------------------------------------
// Public accessors
// ---------------------------------------------------------------------------

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
