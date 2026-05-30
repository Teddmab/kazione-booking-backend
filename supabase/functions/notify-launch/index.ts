import { sendEmail } from "../_shared/resend.ts";

// Public endpoint — no auth, wildcard CORS (lead capture only)
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

type Locale = "fr" | "en" | "et" | "ru";

const NOTIFY_TO = "contact@afrotouch.ee";

const confirmationTemplates: Record<
  Locale,
  { subject: string; html: string }
> = {
  fr: {
    subject: "KaziOne — Vous êtes sur la liste !",
    html: `
      <div style="font-family:'Plus Jakarta Sans',sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0A0705;color:#F5EDE8;border-radius:12px">
        <p style="font-size:22px;font-weight:800;color:#E84E26;margin:0 0 24px">KaziOne</p>
        <h2 style="font-size:20px;font-weight:700;margin:0 0 12px;color:#F5EDE8">Vous êtes sur la liste !</h2>
        <p style="color:rgba(245,237,232,0.7);line-height:1.7;margin:0 0 24px">
          Merci de votre intérêt pour KaziOne. Nous vous enverrons un email dès que la plateforme sera disponible au lancement.
        </p>
        <p style="color:rgba(245,237,232,0.4);font-size:12px;margin:0;border-top:1px solid rgba(245,237,232,0.1);padding-top:20px">
          © 2026 KaziOne · Afrotouch OÜ · Tallinn, Estonia
        </p>
      </div>
    `,
  },
  en: {
    subject: "KaziOne — You're on the list!",
    html: `
      <div style="font-family:'Plus Jakarta Sans',sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0A0705;color:#F5EDE8;border-radius:12px">
        <p style="font-size:22px;font-weight:800;color:#E84E26;margin:0 0 24px">KaziOne</p>
        <h2 style="font-size:20px;font-weight:700;margin:0 0 12px;color:#F5EDE8">You're on the list!</h2>
        <p style="color:rgba(245,237,232,0.7);line-height:1.7;margin:0 0 24px">
          Thanks for your interest in KaziOne. We'll reach out as soon as the platform goes live.
        </p>
        <p style="color:rgba(245,237,232,0.4);font-size:12px;margin:0;border-top:1px solid rgba(245,237,232,0.1);padding-top:20px">
          © 2026 KaziOne · Afrotouch OÜ · Tallinn, Estonia
        </p>
      </div>
    `,
  },
  et: {
    subject: "KaziOne — Olete nimekirjas!",
    html: `
      <div style="font-family:'Plus Jakarta Sans',sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0A0705;color:#F5EDE8;border-radius:12px">
        <p style="font-size:22px;font-weight:800;color:#E84E26;margin:0 0 24px">KaziOne</p>
        <h2 style="font-size:20px;font-weight:700;margin:0 0 12px;color:#F5EDE8">Olete nimekirjas!</h2>
        <p style="color:rgba(245,237,232,0.7);line-height:1.7;margin:0 0 24px">
          Täname huvi KaziOne vastu. Saadame teile e-kirja kohe, kui platvorm on käivitatud.
        </p>
        <p style="color:rgba(245,237,232,0.4);font-size:12px;margin:0;border-top:1px solid rgba(245,237,232,0.1);padding-top:20px">
          © 2026 KaziOne · Afrotouch OÜ · Tallinn, Estonia
        </p>
      </div>
    `,
  },
  ru: {
    subject: "KaziOne — Вы в списке!",
    html: `
      <div style="font-family:'Plus Jakarta Sans',sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0A0705;color:#F5EDE8;border-radius:12px">
        <p style="font-size:22px;font-weight:800;color:#E84E26;margin:0 0 24px">KaziOne</p>
        <h2 style="font-size:20px;font-weight:700;margin:0 0 12px;color:#F5EDE8">Вы в списке!</h2>
        <p style="color:rgba(245,237,232,0.7);line-height:1.7;margin:0 0 24px">
          Спасибо за интерес к KaziOne. Мы напишем вам, как только платформа будет запущена.
        </p>
        <p style="color:rgba(245,237,232,0.4);font-size:12px;margin:0;border-top:1px solid rgba(245,237,232,0.1);padding-top:20px">
          © 2026 KaziOne · Afrotouch OÜ · Tallinn, Estonia
        </p>
      </div>
    `,
  },
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body: { email?: string; locale?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const email = (body.email ?? "").trim().toLowerCase();
  const locale: Locale = (["fr", "en", "et", "ru"].includes(body.locale ?? "")
    ? body.locale
    : "en") as Locale;

  if (!email || !isValidEmail(email)) {
    return json({ error: "Invalid email address" }, 400);
  }

  try {
    // Notify the team
    await sendEmail(
      NOTIFY_TO,
      `New launch signup: ${email}`,
      `<p style="font-family:sans-serif">New subscriber on the coming-soon page:</p>
       <p style="font-family:sans-serif;font-size:18px"><strong>${email}</strong></p>
       <p style="font-family:sans-serif;color:#666">Language: ${locale}</p>`,
    );

    // Confirm to the subscriber
    const tpl = confirmationTemplates[locale];
    await sendEmail(email, tpl.subject, tpl.html);

    return json({ success: true });
  } catch (err) {
    console.error("notify-launch email error:", err);
    return json({ error: "Failed to send email" }, 500);
  }
});
