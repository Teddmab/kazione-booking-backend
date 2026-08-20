import { Resend } from "resend";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

const DEFAULT_FROM = Deno.env.get("BUSINESS_EMAIL_FROM") ??
  "KaziOne Booking <onboarding@resend.dev>";

export interface EmailAttachment {
  filename: string;
  content: string; // base64-encoded
}

/**
 * Send a transactional email via Resend.
 */
export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  from?: string,
  attachments?: EmailAttachment[],
) {
  if (!resend) {
    console.warn(
      "RESEND_API_KEY is not configured; skipping transactional email send",
    );
    return;
  }

  const payload = {
    from: from ?? DEFAULT_FROM,
    to,
    subject,
    html,
    ...(attachments && attachments.length > 0
      ? { attachments: attachments.map((a) => ({ filename: a.filename, content: a.content })) }
      : {}),
  };

  const { error } = await resend.emails.send(payload as Parameters<typeof resend.emails.send>[0]);

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
}

interface StaffInviteData {
  salonName: string;
  salonLogoUrl?: string;
  inviterName: string;
  acceptUrl: string;
  isEstonia?: boolean;
}

interface ReviewRequestData {
  clientName: string;
  salonName: string;
  salonLogoUrl?: string;
  serviceName: string;
  reviewUrl: string;
}

interface OwnerBookingNotificationData {
  clientName: string;
  clientEmail?: string | null;
  clientPhone?: string | null;
  salonName: string;
  salonLogoUrl?: string | null;
  serviceName: string;
  staffName: string;
  date: string;
  time: string;
  reference: string;
  price: string;
  manageUrl: string;
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
    const subject = `Reminder: Your appointment tomorrow — ${d.reference}`;
    return {
      subject,
      html: renderEmail({
        salonLogoUrl: d.salonLogoUrl,
        salonName: d.salonName,
        subject,
        body: `
          ${heading("See you tomorrow!")}
          ${paragraph(`Hi <strong style="color:${B.textDark};">${d.clientName}</strong>, just a friendly reminder about your appointment tomorrow.`)}
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
    const subject = `Meeldetuletus: Teie kohtumine homme — ${d.reference}`;
    return {
      subject,
      html: renderEmail({
        salonLogoUrl: d.salonLogoUrl,
        salonName: d.salonName,
        subject,
        body: `
          ${heading("Kohtumiseni homme!")}
          ${paragraph(`Tere <strong style="color:${B.textDark};">${d.clientName}</strong>, tuletame meelde Teie kohtumist homme.`)}
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
    const subject = `Rappel : Votre rendez-vous demain — ${d.reference}`;
    return {
      subject,
      html: renderEmail({
        salonLogoUrl: d.salonLogoUrl,
        salonName: d.salonName,
        subject,
        body: `
          ${heading("À demain !")}
          ${paragraph(`Bonjour <strong style="color:${B.textDark};">${d.clientName}</strong>, un rappel pour votre rendez-vous de demain.`)}
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
// Estonia entrepreneur notice block (FIE / LHV requirement)
// ---------------------------------------------------------------------------

function estoniaEntrepreneurNotice(locale: Locale): string {
  const amber = "#D97706";
  const amberBg = "#FFFBEB";
  const amberBorder = "#FDE68A";

  const texts: Record<Locale, { heading: string; body: string; lhv: string }> = {
    en: {
      heading: "Important — Entrepreneur Account Required",
      body: "As a freelance professional working in Estonia, you are legally required to operate as a registered <strong>sole trader (FIE — Füüsilisest isikust ettevõtja)</strong>. All payments on this platform are made to entrepreneur accounts.",
      lhv: "We recommend opening an <strong>LHV Entrepreneur Account (Ettevõtjakonto)</strong> if you haven't already. You can register online at lhv.ee.",
    },
    et: {
      heading: "Oluline — Ettevõtjakonto nõue",
      body: "Eestis töötava vabakutselise spetsialistina peate seaduse järgi tegutsema registreeritud <strong>füüsilisest isikust ettevõtjana (FIE)</strong>. Kõik maksed sellel platvormil tehakse ettevõtjakontodele.",
      lhv: "Soovitame avada <strong>LHV Ettevõtjakonto</strong>, kui seda veel ei ole. Registreerida saab veebis aadressil lhv.ee.",
    },
    fr: {
      heading: "Important — Compte entrepreneur requis",
      body: "En tant que professionnel indépendant travaillant en Estonie, vous êtes légalement tenu(e) d'exercer en tant qu'<strong>entrepreneur individuel (FIE — Füüsilisest isikust ettevõtja)</strong>. Tous les paiements sur cette plateforme sont effectués sur des comptes entrepreneurs.",
      lhv: "Nous recommandons d'ouvrir un <strong>compte entrepreneur LHV (Ettevõtjakonto)</strong> si ce n'est pas encore fait. Vous pouvez vous inscrire en ligne sur lhv.ee.",
    },
  };

  const t = texts[locale];
  return `
    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation"
      style="margin:24px 0 8px;border-radius:8px;border:1px solid ${amberBorder};background-color:${amberBg};border-collapse:separate;overflow:hidden;">
      <tr>
        <td width="4" style="width:4px;background-color:${amber};font-size:0;line-height:0;">&nbsp;</td>
        <td style="padding:14px 18px;">
          <p style="margin:0 0 6px;font-family:'Plus Jakarta Sans',Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;color:${amber};letter-spacing:0.1px;">
            ⚠ ${t.heading}
          </p>
          <p style="margin:0 0 8px;font-family:'Plus Jakarta Sans',Helvetica,Arial,sans-serif;font-size:13px;color:#78350F;line-height:1.6;">
            ${t.body}
          </p>
          <p style="margin:0;font-family:'Plus Jakarta Sans',Helvetica,Arial,sans-serif;font-size:13px;color:#78350F;line-height:1.6;">
            ${t.lhv}
          </p>
        </td>
      </tr>
    </table>`;
}

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
          ${d.isEstonia ? estoniaEntrepreneurNotice("en") : ""}
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
          ${d.isEstonia ? estoniaEntrepreneurNotice("et") : ""}
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
          ${d.isEstonia ? estoniaEntrepreneurNotice("fr") : ""}
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
// Staff appointment reminder (internal — English only)
// ---------------------------------------------------------------------------

interface StaffReminderData {
  staffName: string;
  salonName: string;
  salonLogoUrl?: string;
  clientName: string;
  serviceName: string;
  date: string;
  time: string;
  reference: string;
}

export function staffAppointmentReminderEmail(
  data: StaffReminderData,
): { subject: string; html: string } {
  const subject = `Tomorrow: ${data.clientName} — ${data.serviceName}`;
  return {
    subject,
    html: renderEmail({
      salonLogoUrl: data.salonLogoUrl,
      salonName: data.salonName,
      subject,
      body: `
        ${heading("Appointment reminder")}
        ${paragraph(`Hi <strong style="color:${B.textDark};">${data.staffName}</strong>, you have an appointment tomorrow at <strong style="color:${B.textDark};">${data.salonName}</strong>.`)}
        ${detailTable([
          ["Client",  `<strong>${data.clientName}</strong>`],
          ["Service", `<strong>${data.serviceName}</strong>`],
          ["Date",    data.date],
          ["Time",    data.time],
          ["Reference", referenceChip(data.reference)],
        ])}
        ${paragraph(`Please make sure you are prepared for this appointment.`, `font-size:13px;color:${B.textDim};`)}
      `,
    }),
  };
}

// ---------------------------------------------------------------------------
// Owner upcoming appointment reminder (internal — English only)
// ---------------------------------------------------------------------------

interface OwnerReminderData {
  salonName: string;
  salonLogoUrl?: string;
  clientName: string;
  clientEmail?: string | null;
  clientPhone?: string | null;
  serviceName: string;
  staffName: string;
  date: string;
  time: string;
  reference: string;
  manageUrl: string;
}

export function ownerAppointmentReminderEmail(
  data: OwnerReminderData,
): { subject: string; html: string } {
  const subject = `Upcoming tomorrow: ${data.clientName} — ${data.reference}`;
  const contactLines: [string, string][] = [];
  if (data.clientEmail) contactLines.push(["Client email", data.clientEmail]);
  if (data.clientPhone) contactLines.push(["Client phone", data.clientPhone]);

  return {
    subject,
    html: renderEmail({
      salonLogoUrl: data.salonLogoUrl,
      salonName: data.salonName,
      subject,
      body: `
        ${heading("Appointment tomorrow")}
        ${paragraph(`A confirmed appointment is scheduled for tomorrow at <strong style="color:${B.textDark};">${data.salonName}</strong>.`)}
        ${detailTable([
          ["Client",  `<strong>${data.clientName}</strong>`],
          ...contactLines,
          ["Service", `<strong>${data.serviceName}</strong>`],
          ["Staff",   data.staffName],
          ["Date",    data.date],
          ["Time",    data.time],
          ["Reference", referenceChip(data.reference)],
        ])}
        ${ctaButton("View in Dashboard", data.manageUrl)}
      `,
    }),
  };
}

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

// ---------------------------------------------------------------------------
// Staff new-booking notification (internal — English only)
// ---------------------------------------------------------------------------

interface StaffNewBookingData {
  staffName: string;
  salonName: string;
  salonLogoUrl?: string | null;
  clientName: string;
  clientPhone?: string | null;
  serviceName: string;
  date: string;
  time: string;
  reference: string;
  googleCalendarUrl: string;
}

export function staffNewBookingEmail(
  data: StaffNewBookingData,
): { subject: string; html: string } {
  const subject = `New appointment — ${data.clientName} (${data.reference})`;
  const contactLines: [string, string][] = [];
  if (data.clientPhone) contactLines.push(["Client phone", data.clientPhone]);

  return {
    subject,
    html: renderEmail({
      salonLogoUrl: data.salonLogoUrl ?? undefined,
      salonName: data.salonName,
      subject,
      body: `
        ${heading("New appointment booked")}
        ${paragraph(`Hi <strong style="color:${B.textDark};">${data.staffName}</strong>, a new appointment has been booked with you at <strong style="color:${B.textDark};">${data.salonName}</strong>.`)}
        ${detailTable([
          ["Client", `<strong>${data.clientName}</strong>`],
          ...contactLines,
          ["Service", `<strong>${data.serviceName}</strong>`],
          ["Date", data.date],
          ["Time", data.time],
          ["Reference", referenceChip(data.reference)],
        ])}
        ${ctaButton("Add to Google Calendar", data.googleCalendarUrl)}
        ${paragraph(`A calendar invite (.ics) is attached to this email so you can also add it directly to your preferred calendar app.`, `font-size:13px;color:${B.textDim};margin-top:4px;`)}
      `,
    }),
  };
}

// ---------------------------------------------------------------------------
// Staff booking cancellation notification (internal — English only)
// ---------------------------------------------------------------------------

interface StaffCancellationData {
  staffName: string;
  salonName: string;
  salonLogoUrl?: string | null;
  clientName: string;
  serviceName: string;
  date: string;
  time: string;
  reference: string;
  reason?: string | null;
}

export function staffBookingCancellationEmail(
  data: StaffCancellationData,
): { subject: string; html: string } {
  const subject = `Appointment cancelled — ${data.reference}`;
  const reasonRows: [string, string][] = data.reason
    ? [["Reason", data.reason]]
    : [];

  return {
    subject,
    html: renderEmail({
      salonLogoUrl: data.salonLogoUrl ?? undefined,
      salonName: data.salonName,
      subject,
      body: `
        ${heading("Appointment cancelled")}
        ${paragraph(`Hi <strong style="color:${B.textDark};">${data.staffName}</strong>, the following appointment at <strong style="color:${B.textDark};">${data.salonName}</strong> has been cancelled.`)}
        ${detailTable([
          ["Client", `<strong>${data.clientName}</strong>`],
          ["Service", `<strong>${data.serviceName}</strong>`],
          ["Date", data.date],
          ["Time", data.time],
          ...reasonRows,
          ["Reference", referenceChip(data.reference)],
        ])}
        ${paragraph(`This slot is now free. The calendar event has been updated automatically if you added it to your calendar.`, `font-size:13px;color:${B.textDim};`)}
      `,
    }),
  };
}

// ---------------------------------------------------------------------------
// Staff service offer accepted confirmation (internal — English only)
// ---------------------------------------------------------------------------

interface StaffServiceOfferAcceptedData {
  staffName: string;
  salonName: string;
  salonLogoUrl?: string | null;
  serviceName: string;
  serviceDescription?: string | null;
  price: string;
  commissionText?: string | null;
}

export function staffServiceOfferAcceptedEmail(
  data: StaffServiceOfferAcceptedData,
): { subject: string; html: string } {
  const subject = `You've accepted "${data.serviceName}" at ${data.salonName}`;
  const extraRows: [string, string][] = [];
  if (data.commissionText) extraRows.push(["Commission", data.commissionText]);

  return {
    subject,
    html: renderEmail({
      salonLogoUrl: data.salonLogoUrl ?? undefined,
      salonName: data.salonName,
      subject,
      body: `
        ${heading("Service offer accepted")}
        ${paragraph(`Hi <strong style="color:${B.textDark};">${data.staffName}</strong>, you have accepted the service offer from <strong style="color:${B.textDark};">${data.salonName}</strong>.`)}
        ${detailTable([
          ["Service", `<strong>${data.serviceName}</strong>`],
          ["Client price", data.price],
          ...extraRows,
        ])}
        ${data.serviceDescription ? paragraph(`<em style="color:${B.textDim};">${data.serviceDescription}</em>`, `font-size:13px;`) : ""}
        ${paragraph(`Clients can now book appointments with you for this service. You'll receive email notifications for every new booking, reschedule, or cancellation.`, `font-size:13px;color:${B.textDim};`)}
      `,
    }),
  };
}

// ---------------------------------------------------------------------------
// Staff appointment offer notification (internal — English only)
// ---------------------------------------------------------------------------

interface StaffAppointmentOfferData {
  staffName: string;
  salonName: string;
  salonLogoUrl?: string | null;
  clientName: string;
  serviceName: string;
  date: string;
  time: string;
  reference: string;
  dashboardUrl: string;
}

export function staffAppointmentOfferEmail(data: StaffAppointmentOfferData): { subject: string; html: string } {
  const subject = `Appointment offer — ${data.serviceName} (${data.reference})`;
  return {
    subject,
    html: renderEmail({
      salonLogoUrl: data.salonLogoUrl ?? undefined,
      salonName: data.salonName,
      subject,
      body: `
        ${heading("You have a new appointment offer")}
        ${paragraph(`Hi <strong style="color:${B.textDark};">${data.staffName}</strong>, ${data.salonName} would like you to take the following appointment. Please accept or decline in your dashboard.`)}
        ${detailTable([
          ["Client", `<strong>${data.clientName}</strong>`],
          ["Service", `<strong>${data.serviceName}</strong>`],
          ["Date", data.date],
          ["Time", data.time],
          ["Reference", referenceChip(data.reference)],
        ])}
        ${ctaButton("Accept or Decline", data.dashboardUrl)}
      `,
    }),
  };
}

// ---------------------------------------------------------------------------
// Staff service offer notification (internal — English only)
// ---------------------------------------------------------------------------

interface StaffServiceOfferData {
  staffName: string;
  salonName: string;
  salonLogoUrl?: string | null;
  serviceNames: string[];
  dashboardUrl: string;
}

export function staffServiceOfferEmail(data: StaffServiceOfferData): { subject: string; html: string } {
  const count = data.serviceNames.length;
  const subject = `${count} service offer${count !== 1 ? "s" : ""} from ${data.salonName}`;
  const serviceRows: [string, string][] = data.serviceNames.map((name, i) => [
    i === 0 ? "Services" : "",
    `<strong>${name}</strong>`,
  ]);
  return {
    subject,
    html: renderEmail({
      salonLogoUrl: data.salonLogoUrl ?? undefined,
      salonName: data.salonName,
      subject,
      body: `
        ${heading("New service offers")}
        ${paragraph(`Hi <strong style="color:${B.textDark};">${data.staffName}</strong>, <strong style="color:${B.textDark};">${data.salonName}</strong> has offered you ${count === 1 ? "a new service" : `${count} new services`}. Review and accept or decline in your dashboard.`)}
        ${detailTable(serviceRows)}
        ${ctaButton("Review Offers", data.dashboardUrl)}
      `,
    }),
  };
}

// ---------------------------------------------------------------------------
// Owner pending-completion notification (internal — English only)
// ---------------------------------------------------------------------------

interface OwnerPendingCompletionData {
  salonName: string;
  salonLogoUrl?: string | null;
  staffName: string;
  clientName: string;
  serviceName: string;
  date: string;
  time: string;
  reference: string;
  paymentMethod: string;
  dashboardUrl: string;
}

export function ownerPendingCompletionEmail(data: OwnerPendingCompletionData): { subject: string; html: string } {
  const subject = `Completion request — ${data.reference} (${data.staffName})`;
  return {
    subject,
    html: renderEmail({
      salonLogoUrl: data.salonLogoUrl ?? undefined,
      salonName: data.salonName,
      subject,
      body: `
        ${heading("Staff marked appointment complete")}
        ${paragraph(`<strong style="color:${B.textDark};">${data.staffName}</strong> has marked the following appointment as complete and is waiting for your confirmation.`)}
        ${detailTable([
          ["Client", `<strong>${data.clientName}</strong>`],
          ["Service", `<strong>${data.serviceName}</strong>`],
          ["Date", data.date],
          ["Time", data.time],
          ["Payment", data.paymentMethod],
          ["Reference", referenceChip(data.reference)],
        ])}
        ${ctaButton("Confirm in Dashboard", data.dashboardUrl)}
      `,
    }),
  };
}

// ---------------------------------------------------------------------------
// Staff completion confirmed notification (internal — English only)
// ---------------------------------------------------------------------------

interface StaffCompletionConfirmedData {
  staffName: string;
  salonName: string;
  salonLogoUrl?: string | null;
  clientName: string;
  serviceName: string;
  date: string;
  reference: string;
}

export function staffCompletionConfirmedEmail(data: StaffCompletionConfirmedData): { subject: string; html: string } {
  const subject = `Appointment confirmed complete — ${data.reference}`;
  return {
    subject,
    html: renderEmail({
      salonLogoUrl: data.salonLogoUrl ?? undefined,
      salonName: data.salonName,
      subject,
      body: `
        ${heading("Appointment confirmed complete")}
        ${paragraph(`Hi <strong style="color:${B.textDark};">${data.staffName}</strong>, the owner has confirmed the following appointment as completed. Your earnings have been recorded.`)}
        ${detailTable([
          ["Client", `<strong>${data.clientName}</strong>`],
          ["Service", `<strong>${data.serviceName}</strong>`],
          ["Date", data.date],
          ["Reference", referenceChip(data.reference)],
        ])}
      `,
    }),
  };
}

// ---------------------------------------------------------------------------
// Owner booking notification (internal alert — always in English)
// ---------------------------------------------------------------------------

export function bookingReceivedOwnerEmail(data: OwnerBookingNotificationData): { subject: string; html: string } {
  const subject = `New booking — ${data.reference}`;
  const contactLines: [string, string][] = [];
  if (data.clientEmail) contactLines.push(["Email", data.clientEmail]);
  if (data.clientPhone) contactLines.push(["Phone", data.clientPhone]);

  return {
    subject,
    html: renderEmail({
      salonName: data.salonName,
      salonLogoUrl: data.salonLogoUrl ?? undefined,
      subject,
      body: `
        ${heading("New booking received")}
        ${paragraph(`A new appointment has been booked at <strong style="color:${B.textDark};">${data.salonName}</strong>.`)}
        ${detailTable([
          ["Client", `<strong>${data.clientName}</strong>`],
          ...contactLines,
          ["Service", `<strong>${data.serviceName}</strong>`],
          ["Staff", data.staffName],
          ["Date", data.date],
          ["Time", data.time],
          ["Price", data.price],
          ["Reference", referenceChip(data.reference)],
        ])}
        ${ctaButton("View in Dashboard", data.manageUrl)}
      `,
    }),
  };
}

// ---------------------------------------------------------------------------
// Overdue appointment completion reminder (sent to owner every 6 hours, max 5×)
// ---------------------------------------------------------------------------

interface OverdueCompletionReminderData {
  salonName: string;
  salonLogoUrl?: string | null;
  clientName: string;
  serviceName: string;
  date: string;
  time: string;
  reference: string;
  staffName: string | null;
  reminderNumber: number;
  dashboardUrl: string;
}

// ---------------------------------------------------------------------------
// Offer / entitlement assigned to client
// ---------------------------------------------------------------------------

interface OfferAssignedData {
  clientName: string;
  salonName: string;
  salonLogoUrl?: string | null;
  offerName: string;
  offerDescription: string; // e.g. "10% off your next visit" or "5 sessions remaining"
  expiresAt?: string | null; // ISO date string, optional
}

export function offerAssignedEmail(data: OfferAssignedData): { subject: string; html: string } {
  const subject = `You received ${data.offerName} from ${data.salonName}`;
  const expiryLine = data.expiresAt
    ? `<br/>Valid until: <strong>${new Date(data.expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}</strong>`
    : "";
  return {
    subject,
    html: renderEmail({
      salonName: data.salonName,
      salonLogoUrl: data.salonLogoUrl ?? undefined,
      subject,
      body: `
        ${heading(`You've got a gift, ${data.clientName}!`)}
        ${paragraph(`<strong>${data.salonName}</strong> has given you the following offer:`)}
        ${detailTable([
          ["Offer", `<strong>${data.offerName}</strong>`],
          ["Details", `${data.offerDescription}${expiryLine}`],
        ])}
        ${paragraph("Show this to your stylist at your next visit or it will be applied automatically when you book online.")}
      `,
    }),
  };
}

interface StaffMagicLinkIssuedData {
  staffName: string;
  salonName: string;
  salonLogoUrl?: string | null;
  issuedByName: string;
  issuedAt: string; // ISO datetime
}

/**
 * Sent to a staff member whenever an owner/manager generates a one-time
 * sign-in link for their account, so this is never silent to them.
 */
export function staffMagicLinkIssuedEmail(data: StaffMagicLinkIssuedData): { subject: string; html: string } {
  const subject = `A sign-in link for your account was generated`;
  return {
    subject,
    html: renderEmail({
      salonName: data.salonName,
      salonLogoUrl: data.salonLogoUrl ?? undefined,
      subject,
      body: `
        ${heading(`Hi ${data.staffName},`)}
        ${paragraph(`${data.issuedByName} at <strong>${data.salonName}</strong> just generated a one-time sign-in link for your staff account.`)}
        ${detailTable([
          ["When", new Date(data.issuedAt).toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })],
          ["Requested by", data.issuedByName],
        ])}
        ${paragraph("If you weren't expecting this, contact your salon owner or manager.")}
      `,
    }),
  };
}

export function overdueCompletionReminderEmail(data: OverdueCompletionReminderData): { subject: string; html: string } {
  const subject = `[Reminder ${data.reminderNumber}/5] Appointment not yet completed — ${data.reference}`;
  return {
    subject,
    html: renderEmail({
      salonName: data.salonName,
      salonLogoUrl: data.salonLogoUrl ?? undefined,
      subject,
      body: `
        ${heading("Appointment completion overdue")}
        ${paragraph(`The following appointment has passed its scheduled end time and has not been marked as completed yet. Please update the status in your dashboard.`)}
        ${detailTable([
          ["Client", `<strong>${data.clientName}</strong>`],
          ["Service", `<strong>${data.serviceName}</strong>`],
          ["Staff", data.staffName ?? "Unassigned"],
          ["Date", data.date],
          ["Time", data.time],
          ["Reference", referenceChip(data.reference)],
        ])}
        ${ctaButton("Mark as Completed", data.dashboardUrl)}
        ${paragraph(`This is reminder ${data.reminderNumber} of 5. Reminders are sent every 6 hours until the appointment is marked complete.`)}
      `,
    }),
  };
}
