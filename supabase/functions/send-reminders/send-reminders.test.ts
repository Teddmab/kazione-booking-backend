// supabase/functions/send-reminders/send-reminders.test.ts
import { assertEquals } from "https://deno.land/std/testing/asserts.ts"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
// Local dev secret from .env — safe to hardcode (dev-only secret)
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "270d13cee3e549b6a57996077c1185a137f5b4f2b955dc9c504d9ec017186944"

async function callFn(token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json", "apikey": ANON_KEY }
  if (token) headers["Authorization"] = `Bearer ${token}`
  return fetch(`${BASE}/send-reminders`, { method: "POST", headers })
}

Deno.test("send-reminders: missing Authorization header", async () => {
  const res = await fetch(`${BASE}/send-reminders`, { method: "POST", headers: { "apikey": ANON_KEY } })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test("send-reminders: wrong CRON_SECRET", async () => {
  const res = await callFn("wrongsecret")
  assertEquals(res.status, 401)
  await res.body?.cancel()
})


Deno.test("send-reminders: correct CRON_SECRET", async () => {
  if (!CRON_SECRET || CRON_SECRET === "invalid") return;
  const res = await callFn(CRON_SECRET);
  assertEquals(res.status, 200);
  const body = await res.json();
  if (!body || typeof body !== "object") throw new Error("No JSON body");
  if (!("sent" in body || (body.reminders && "sent" in body.reminders))) throw new Error("Missing sent field");
});

Deno.test("send-reminders: no upcoming appointments", async () => {
  if (!CRON_SECRET || CRON_SECRET === "invalid") return;
  const res = await callFn(CRON_SECRET);
  assertEquals(res.status, 200);
  const body = await res.json();
  // Accept sent: 0, errors: 0 either at top level or in reminders field
  const sent = body.sent ?? (body.reminders && body.reminders.sent);
  const errors = body.errors ?? (body.reminders && body.reminders.errors);
  if (sent !== 0 || errors !== 0) throw new Error(`Expected sent:0, errors:0, got sent:${sent}, errors:${errors}`);
});
