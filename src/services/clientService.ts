import { supabase } from "../lib/supabase";
import { NetworkError } from "../types/api";
import type {
  ClientDetail,
  ClientFilters,
  ClientWithStats,
  CreateClientData,
  ImportResult,
  ImportRow,
  PaginatedClients,
} from "../types/api";

// ---------------------------------------------------------------------------
// getClients — paginated list with search, tags, and aggregated stats
// ---------------------------------------------------------------------------

export async function getClients(
  businessId: string,
  filters: ClientFilters = {},
): Promise<PaginatedClients> {
  const { search, tags, page = 1, limit = 25 } = filters;

  let query = supabase
    .from("clients")
    .select(
      `
      *,
      appointments(id, starts_at, status, price)
    `,
      { count: "exact" },
    )
    .eq("business_id", businessId)
    .order("created_at", { ascending: false });

  if (search) {
    query = query.or(
      `first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%`,
    );
  }

  if (tags?.length) {
    query = query.overlaps("tags", tags);
  }

  const from = (page - 1) * limit;
  query = query.range(from, from + limit - 1);

  const { data, error, count } = await query;
  if (error) throw new NetworkError(error.message, 500);

  const clients: ClientWithStats[] = (data ?? []).map((row: any) => {
    const appts = (row.appointments ?? []) as {
      id: string;
      starts_at: string;
      status: string;
      price: number;
    }[];
    const completed = appts.filter((a) => a.status === "completed");

    const { appointments: _, ...clientFields } = row;
    return {
      ...clientFields,
      appointment_count: appts.length,
      last_visit:
        completed.length > 0
          ? completed.sort(
              (a, b) =>
                new Date(b.starts_at).getTime() -
                new Date(a.starts_at).getTime(),
            )[0].starts_at
          : null,
      total_spent: completed.reduce((sum, a) => sum + a.price, 0),
    } as ClientWithStats;
  });

  return { clients, total: count ?? 0 };
}

// ---------------------------------------------------------------------------
// getClient — single client with last 10 appointments
// ---------------------------------------------------------------------------

export interface ClientDetailWithAppointments extends ClientDetail {
  recent_appointments: {
    id: string;
    starts_at: string;
    ends_at: string;
    status: string;
    booking_reference: string;
    price: number;
    service: { id: string; name: string; duration_minutes: number; price: number };
    staff: { id: string; display_name: string; avatar_url: string | null } | null;
    payment: { status: string; amount: number; method: string; paid_at: string | null } | null;
  }[];
  preferred_staff: { id: string; display_name: string; avatar_url: string | null } | null;
}

export async function getClient(
  id: string,
): Promise<ClientDetailWithAppointments> {
  const { data, error } = await supabase
    .from("clients")
    .select(
      `
      *,
      preferred_staff:staff_profiles!clients_preferred_staff_id_fkey(id, display_name, avatar_url)
    `,
    )
    .eq("id", id)
    .single();

  if (error)
    throw new NetworkError(
      error.message,
      error.code === "PGRST116" ? 404 : 500,
    );

  const { data: appointments, error: apptErr } = await supabase
    .from("appointments")
    .select(
      `
      id, starts_at, ends_at, status, booking_reference, price,
      service:services!inner(id, name, duration_minutes, price),
      staff:staff_profiles(id, display_name, avatar_url),
      payment:payments(status, amount, method, paid_at)
    `,
    )
    .eq("client_id", id)
    .order("starts_at", { ascending: false })
    .limit(10);

  if (apptErr) throw new NetworkError(apptErr.message, 500);

  const recentAppointments = (appointments ?? []).map((row: any) => ({
    ...row,
    payment: row.payment?.[0] ?? null,
  }));

  return {
    ...data,
    preferred_staff: data.preferred_staff ?? null,
    recent_appointments: recentAppointments,
  } as ClientDetailWithAppointments;
}

// ---------------------------------------------------------------------------
// createClient — with duplicate email check
// ---------------------------------------------------------------------------

export async function createClient(
  businessId: string,
  data: CreateClientData,
): Promise<ClientDetail> {
  if (data.email) {
    const { data: existing } = await supabase
      .from("clients")
      .select("id")
      .eq("business_id", businessId)
      .eq("email", data.email)
      .maybeSingle();

    if (existing) {
      throw new NetworkError(
        `A client with email ${data.email} already exists`,
        409,
      );
    }
  }

  const { data: client, error } = await supabase
    .from("clients")
    .insert({
      business_id: businessId,
      first_name: data.first_name,
      last_name: data.last_name,
      email: data.email ?? null,
      phone: data.phone ?? null,
      date_of_birth: data.date_of_birth ?? null,
      notes: data.notes ?? null,
      tags: data.tags ?? [],
      preferred_staff_id: data.preferred_staff_id ?? null,
      preferred_locale: data.preferred_locale ?? "en",
      source: data.source ?? "manual",
    })
    .select("*")
    .single();

  if (error) throw new NetworkError(error.message, 500);
  return client as ClientDetail;
}

// ---------------------------------------------------------------------------
// updateClient
// ---------------------------------------------------------------------------

export async function updateClient(
  id: string,
  data: Partial<CreateClientData>,
): Promise<ClientDetail> {
  const { data: client, error } = await supabase
    .from("clients")
    .update(data)
    .eq("id", id)
    .select("*")
    .single();

  if (error) throw new NetworkError(error.message, 500);
  return client as ClientDetail;
}

// ---------------------------------------------------------------------------
// updateClientNotes
// ---------------------------------------------------------------------------

export async function updateClientNotes(
  id: string,
  notes: string,
): Promise<ClientDetail> {
  const { data: client, error } = await supabase
    .from("clients")
    .update({ notes })
    .eq("id", id)
    .select("*")
    .single();

  if (error) throw new NetworkError(error.message, 500);
  return client as ClientDetail;
}

// ---------------------------------------------------------------------------
// importClients — batch upsert with conflict handling
// ---------------------------------------------------------------------------

export async function importClients(
  businessId: string,
  rows: ImportRow[],
): Promise<ImportResult> {
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  const errors: { row: number; reason: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    if (!row.first_name || !row.last_name) {
      errors.push({ row: i + 1, reason: "Missing first_name or last_name" });
      skipped++;
      continue;
    }

    try {
      if (row.email) {
        const { data: existing } = await supabase
          .from("clients")
          .select("id")
          .eq("business_id", businessId)
          .eq("email", row.email)
          .maybeSingle();

        if (existing) {
          const { error: updateErr } = await supabase
            .from("clients")
            .update({
              first_name: row.first_name,
              last_name: row.last_name,
              phone: row.phone ?? undefined,
              date_of_birth: row.date_of_birth ?? undefined,
              notes: row.notes ?? undefined,
              tags: row.tags ?? undefined,
            })
            .eq("id", existing.id);

          if (updateErr) {
            errors.push({ row: i + 1, reason: updateErr.message });
            skipped++;
          } else {
            updated++;
          }
          continue;
        }
      }

      const { error: insertErr } = await supabase.from("clients").insert({
        business_id: businessId,
        first_name: row.first_name,
        last_name: row.last_name,
        email: row.email ?? null,
        phone: row.phone ?? null,
        date_of_birth: row.date_of_birth ?? null,
        notes: row.notes ?? null,
        tags: row.tags ?? [],
        source: row.source ?? "import",
      });

      if (insertErr) {
        errors.push({ row: i + 1, reason: insertErr.message });
        skipped++;
      } else {
        imported++;
      }
    } catch (err) {
      errors.push({
        row: i + 1,
        reason: err instanceof Error ? err.message : "Unknown error",
      });
      skipped++;
    }
  }

  return { imported, updated, skipped, errors };
}
