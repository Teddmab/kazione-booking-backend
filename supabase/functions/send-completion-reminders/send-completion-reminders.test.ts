// supabase/functions/send-completion-reminders/send-completion-reminders.test.ts
//
// First test coverage for this function (S62). Mirrors send-reminders.test.ts's
// minimal auth + well-formed-response pattern — this endpoint has no
// business_id-scoped manual-trigger path to target a specific fixture, so
// the notification_delivery_log write path itself is covered indirectly
// (type-checked, code-reviewed, and exercised by the same sendEmail() call
// path invite-staff.test.ts asserts on directly) rather than through a
// dedicated overdue-appointment fixture here.
import { assertEquals } from "std/assert"

const BASE = "http://127.0.0.1:54321/functions/v1"
// Local dev secret from .env — safe to hardcode (dev-only secret), same
// value used by send-reminders.test.ts.
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "270d13cee3e549b6a57996077c1185a137f5b4f2b955dc9c504d9ec017186944"

function callFn(token?: string) {
  const headers: Record<string, string> = {}
  if (token) headers["Authorization"] = `Bearer ${token}`
  return fetch(`${BASE}/send-completion-reminders`, { method: "POST", headers })
}

Deno.test("send-completion-reminders: wrong CRON_SECRET → 401", async () => {
  const res = await callFn("wrongsecret")
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test("send-completion-reminders: correct CRON_SECRET → 200 with well-formed body", async () => {
  if (!CRON_SECRET) return
  const res = await callFn(CRON_SECRET)
  assertEquals(res.status, 200)
  const body = await res.json()
  if (typeof body.sent !== "number" || typeof body.skipped !== "number" || typeof body.checked !== "number") {
    throw new Error(`Expected {sent, skipped, checked} numbers, got: ${JSON.stringify(body)}`)
  }
})
