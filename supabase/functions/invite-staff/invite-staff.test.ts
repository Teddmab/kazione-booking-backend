// supabase/functions/invite-staff/invite-staff.test.ts
//
// S62: proves invite-staff's notification_delivery_log retrofit — every
// invite attempt (success or failure) writes a delivery-log row that
// matches the endpoint's own invite_sent/email_error response, without
// changing that response contract.
import { assertEquals } from "std/assert"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
// Well-known local dev service_role key — not a secret, same value used in
// create-booking.test.ts / appointments.test.ts.
const SUPABASE_URL = "http://127.0.0.1:54321"
const SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"
const BUSINESS_ID = "b0000000-0000-4000-8000-000000000001" // from seed
const OWNER_TOKEN = Deno.env.get("TEST_OWNER_TOKEN") || ""

function callFn(token?: string, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json", apikey: ANON_KEY }
  if (token) headers["Authorization"] = `Bearer ${token}`
  return fetch(`${BASE}/invite-staff`, { method: "POST", headers, body: body ? JSON.stringify(body) : undefined })
}

Deno.test("invite-staff: no Authorization header → 401", async () => {
  const res = await callFn(undefined, {
    business_id: BUSINESS_ID,
    email: `nobody-${Date.now()}@example.com`,
    display_name: "Nobody",
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test("invite-staff: successful invite writes a matching notification_delivery_log row", async () => {
  if (!OWNER_TOKEN) return

  const email = `s62-invite-${Date.now()}@example.com`
  const res = await callFn(OWNER_TOKEN, {
    business_id: BUSINESS_ID,
    email,
    display_name: "S62 Test Invite",
    role: "staff",
  })
  if (res.status !== 201) {
    const body = await res.json().catch(() => null)
    throw new Error(`Expected 201, got ${res.status}: ${JSON.stringify(body)}`)
  }
  const body = await res.json()
  if (typeof body.invite_sent !== "boolean") throw new Error("Expected an invite_sent boolean in the response")

  // The delivery-log row deliberately doesn't store the recipient address
  // (avoids duplicating PII beyond what's structurally required) — read
  // back the most recent staff_invite row for this business instead, and
  // confirm its outcome matches the endpoint's own response.
  //
  // logNotificationDelivery is fire-and-forget (never awaited by the
  // handler, by design — a logging failure must never delay or block the
  // actual invite), so the row can land a beat after the HTTP response
  // does. Poll briefly instead of a single immediate query.
  let rows: unknown[] = []
  for (let attempt = 0; attempt < 10 && rows.length === 0; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 200))
    const logRes = await fetch(
      `${SUPABASE_URL}/rest/v1/notification_delivery_log?business_id=eq.${BUSINESS_ID}&purpose=eq.staff_invite&order=created_at.desc&limit=1`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
    )
    assertEquals(logRes.status, 200)
    rows = await logRes.json()
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Expected a staff_invite notification_delivery_log row")
  }
  const row = rows[0] as Record<string, unknown>
  assertEquals(row.channel, "email")
  assertEquals(row.recipient_type, "staff")
  assertEquals(row.appointment_id, null)
  assertEquals(row.status, body.invite_sent ? "sent" : "failed")
  if (!body.invite_sent && !row.error_message) {
    throw new Error("Expected a captured error_message on a failed send")
  }
})
