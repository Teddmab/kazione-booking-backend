import { supabase } from "../lib/supabase";
import { NetworkError } from "../types/api";
import type {
  AppointmentFilters,
  AppointmentStatus,
  AppointmentDetail,
  AppointmentWithRelations,
  CalendarEntry,
  CreateAppointmentData,
  DashboardKPIs,
  PaginatedAppointments,
} from "../types/api";

// ---------------------------------------------------------------------------
// getAppointments — paginated list with filters
// ---------------------------------------------------------------------------

export async function getAppointments(
  businessId: string,
  filters: AppointmentFilters = {},
): Promise<PaginatedAppointments> {
  const {
    dateFrom,
    dateTo,
    status,
    staffId,
    search,
    page = 1,
    limit = 25,
  } = filters;

  let query = supabase
    .from("appointments")
    .select(
      `
      *,
      client:clients!inner(id, first_name, last_name, email, phone, avatar_url),
      service:services!inner(id, name, duration_minutes, price),
      staff:staff_profiles(id, display_name, avatar_url),
      payment:payments(status, amount, method, paid_at)
    `,
      { count: "exact" },
    )
    .eq("business_id", businessId)
    .order("starts_at", { ascending: false });

  if (dateFrom) query = query.gte("starts_at", dateFrom);
  if (dateTo) query = query.lte("starts_at", dateTo);
  if (status?.length) query = query.in("status", status);
  if (staffId) query = query.eq("staff_profile_id", staffId);
  if (search) {
    query = query.or(
      `client.first_name.ilike.%${search}%,client.last_name.ilike.%${search}%,client.email.ilike.%${search}%`,
    );
  }

  const from = (page - 1) * limit;
  query = query.range(from, from + limit - 1);

  const { data, error, count } = await query;
  if (error) throw new NetworkError(error.message, 500);

  const appointments = (data ?? []).map((row) => ({
    ...row,
    payment: row.payment?.[0] ?? null,
  })) as AppointmentWithRelations[];

  return { appointments, total: count ?? 0 };
}

// ---------------------------------------------------------------------------
// getAppointment — single with full detail
// ---------------------------------------------------------------------------

export async function getAppointment(
  id: string,
): Promise<AppointmentDetail> {
  const { data, error } = await supabase
    .from("appointments")
    .select(
      `
      *,
      client:clients!inner(id, first_name, last_name, email, phone, avatar_url),
      service:services!inner(id, name, duration_minutes, price),
      staff:staff_profiles(id, display_name, avatar_url),
      payment:payments(status, amount, method, paid_at)
    `,
    )
    .eq("id", id)
    .single();

  if (error) throw new NetworkError(error.message, error.code === "PGRST116" ? 404 : 500);

  const { data: statusLog, error: logErr } = await supabase
    .from("appointment_status_log")
    .select("*")
    .eq("appointment_id", id)
    .order("created_at", { ascending: true });

  if (logErr) throw new NetworkError(logErr.message, 500);

  return {
    ...data,
    payment: data.payment?.[0] ?? null,
    status_log: statusLog ?? [],
  } as AppointmentDetail;
}

// ---------------------------------------------------------------------------
// createAppointment — manual booking by owner/receptionist
// ---------------------------------------------------------------------------

export async function createAppointment(
  businessId: string,
  data: CreateAppointmentData,
): Promise<AppointmentWithRelations> {
  // Generate booking reference
  const { data: refData, error: refErr } = await supabase.rpc(
    "generate_booking_reference",
  );
  if (refErr) throw new NetworkError(refErr.message, 500);
  const bookingReference = refData as string;

  const endsAt = new Date(
    new Date(data.starts_at).getTime() + data.duration_minutes * 60_000,
  ).toISOString();

  const { data: appointment, error } = await supabase
    .from("appointments")
    .insert({
      business_id: businessId,
      client_id: data.client_id,
      service_id: data.service_id,
      staff_profile_id: data.staff_profile_id,
      starts_at: data.starts_at,
      ends_at: endsAt,
      duration_minutes: data.duration_minutes,
      price: data.price,
      deposit_amount: data.deposit_amount ?? 0,
      booking_source: data.booking_source ?? "staff",
      booking_reference: bookingReference,
      is_walk_in: data.is_walk_in ?? false,
      notes: data.notes ?? null,
      internal_notes: data.internal_notes ?? null,
      status: "confirmed",
    })
    .select(
      `
      *,
      client:clients!inner(id, first_name, last_name, email, phone, avatar_url),
      service:services!inner(id, name, duration_minutes, price),
      staff:staff_profiles(id, display_name, avatar_url)
    `,
    )
    .single();

  if (error) throw new NetworkError(error.message, 500);

  // Auto-create payment record if price > 0
  if (data.price > 0) {
    await supabase.from("payments").insert({
      business_id: businessId,
      appointment_id: appointment.id,
      client_id: data.client_id,
      amount: data.price,
      status: "pending",
      method: "cash",
    });
  }

  // Insert initial status log
  await supabase.from("appointment_status_log").insert({
    appointment_id: appointment.id,
    old_status: null,
    new_status: "confirmed",
    reason: "Manual booking created",
  });

  return { ...appointment, payment: null } as AppointmentWithRelations;
}

// ---------------------------------------------------------------------------
// updateAppointmentStatus
// ---------------------------------------------------------------------------

export async function updateAppointmentStatus(
  id: string,
  status: AppointmentStatus,
  reason?: string,
  changedBy?: string,
): Promise<AppointmentWithRelations> {
  // Get current status for the log
  const { data: current, error: fetchErr } = await supabase
    .from("appointments")
    .select("status")
    .eq("id", id)
    .single();

  if (fetchErr) throw new NetworkError(fetchErr.message, 404);

  const updateFields: Record<string, unknown> = { status };
  if (status === "cancelled") {
    updateFields.cancellation_reason = reason ?? null;
    updateFields.cancelled_at = new Date().toISOString();
    updateFields.cancelled_by = changedBy ?? null;
  }
  if (status === "no_show") {
    updateFields.no_show_marked_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from("appointments")
    .update(updateFields)
    .eq("id", id)
    .select(
      `
      *,
      client:clients!inner(id, first_name, last_name, email, phone, avatar_url),
      service:services!inner(id, name, duration_minutes, price),
      staff:staff_profiles(id, display_name, avatar_url),
      payment:payments(status, amount, method, paid_at)
    `,
    )
    .single();

  if (error) throw new NetworkError(error.message, 500);

  // Log status change
  await supabase.from("appointment_status_log").insert({
    appointment_id: id,
    old_status: current.status,
    new_status: status,
    changed_by: changedBy ?? null,
    reason: reason ?? null,
  });

  return { ...data, payment: data.payment?.[0] ?? null } as AppointmentWithRelations;
}

// ---------------------------------------------------------------------------
// getDashboardKPIs
// ---------------------------------------------------------------------------

export async function getDashboardKPIs(
  businessId: string,
): Promise<DashboardKPIs> {
  const { data, error } = await supabase.rpc("get_owner_dashboard_kpis", {
    p_business_id: businessId,
  });

  if (error) throw new NetworkError(error.message, 500);
  return data as DashboardKPIs;
}

// ---------------------------------------------------------------------------
// getCalendar
// ---------------------------------------------------------------------------

export async function getCalendar(
  businessId: string,
  startDate: string,
  endDate: string,
  staffId?: string,
): Promise<CalendarEntry[]> {
  const { data, error } = await supabase.rpc("get_business_calendar", {
    p_business_id: businessId,
    p_start_date: startDate,
    p_end_date: endDate,
    p_staff_id: staffId ?? null,
  });

  if (error) throw new NetworkError(error.message, 500);
  return (data ?? []) as CalendarEntry[];
}
