import { supabase } from "../lib/supabase";
import type {
  ApiError,
  AvailabilityParams,
  AvailabilityResult,
  CancelBookingParams,
  CancelBookingResult,
  CreateBookingParams,
  CreateBookingResult,
  LookupBookingResult,
  NetworkError as NetworkErrorType,
  RescheduleBookingParams,
  RescheduleBookingResult,
  StorefrontData,
  AppointmentWithRelations,
} from "../types/api";
import { NetworkError } from "../types/api";

// ---------------------------------------------------------------------------
// Base URL
// ---------------------------------------------------------------------------

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

export class NotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class SlotTakenError extends Error {
  alternatives: string[];
  constructor(alternatives: string[] = []) {
    super("This time slot is no longer available");
    this.name = "SlotTakenError";
    this.alternatives = alternatives;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (session?.access_token) {
    headers["Authorization"] = `Bearer ${session.access_token}`;
  }
  return headers;
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (res.ok) return res.json() as Promise<T>;

  let body: ApiError | undefined;
  try {
    body = (await res.json()) as ApiError;
  } catch {
    // non-JSON response
  }

  throw new NetworkError(
    body?.error?.message ?? res.statusText,
    res.status,
    body,
  );
}

// ---------------------------------------------------------------------------
// get-storefront
// ---------------------------------------------------------------------------

export async function getStorefront(slug: string): Promise<StorefrontData> {
  const headers = await authHeaders();
  // Forward i18n locale via Accept-Language if available
  if (typeof document !== "undefined") {
    headers["Accept-Language"] = document.documentElement.lang || navigator.language;
  }

  const res = await fetch(
    `${FUNCTIONS_URL}/get-storefront?slug=${encodeURIComponent(slug)}`,
    { headers },
  );

  if (res.status === 404) {
    throw new NotFoundError("Salon not found");
  }

  return handleResponse<StorefrontData>(res);
}

// ---------------------------------------------------------------------------
// get-availability
// ---------------------------------------------------------------------------

export async function getAvailability(
  params: AvailabilityParams,
): Promise<AvailabilityResult> {
  const headers = await authHeaders();
  const qs = new URLSearchParams({
    business_id: params.business_id,
    service_id: params.service_id,
    date: params.date,
    ...(params.staff_id ? { staff_id: params.staff_id } : {}),
  });

  const res = await fetch(`${FUNCTIONS_URL}/get-availability?${qs}`, {
    headers,
  });
  return handleResponse<AvailabilityResult>(res);
}

// ---------------------------------------------------------------------------
// create-booking
// ---------------------------------------------------------------------------

export async function createBooking(
  params: CreateBookingParams,
): Promise<CreateBookingResult> {
  const headers = await authHeaders();

  const res = await fetch(`${FUNCTIONS_URL}/create-booking`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });

  if (res.status === 409) {
    const body = (await res.json()) as ApiError;
    if (body?.error?.code === "SLOT_TAKEN") {
      const alternatives =
        (body.error.details as { available_alternatives?: string[] })
          ?.available_alternatives ?? [];
      throw new SlotTakenError(alternatives);
    }
    throw new NetworkError(body?.error?.message ?? "Conflict", 409, body);
  }

  return handleResponse<CreateBookingResult>(res);
}

// ---------------------------------------------------------------------------
// cancel-booking
// ---------------------------------------------------------------------------

export async function cancelBooking(
  params: CancelBookingParams,
): Promise<{ refundAmount: number }> {
  const headers = await authHeaders();

  const res = await fetch(`${FUNCTIONS_URL}/cancel-booking`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });

  const data = await handleResponse<CancelBookingResult>(res);
  return { refundAmount: data.refund_amount };
}

// ---------------------------------------------------------------------------
// reschedule-booking
// ---------------------------------------------------------------------------

export async function rescheduleBooking(
  params: RescheduleBookingParams,
): Promise<RescheduleBookingResult> {
  const headers = await authHeaders();

  const res = await fetch(`${FUNCTIONS_URL}/reschedule-booking`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });

  return handleResponse<RescheduleBookingResult>(res);
}

// ---------------------------------------------------------------------------
// lookup-booking
// ---------------------------------------------------------------------------

export async function lookupBookingByReference(
  email: string,
  reference: string,
): Promise<LookupBookingResult> {
  const headers = await authHeaders();

  const res = await fetch(
    `${FUNCTIONS_URL}/lookup-booking?email=${encodeURIComponent(email)}&reference=${encodeURIComponent(reference)}`,
    { headers },
  );

  if (res.status === 404) {
    throw new NotFoundError("Booking not found");
  }

  return handleResponse<LookupBookingResult>(res);
}

// ---------------------------------------------------------------------------
// getCustomerBookings — direct Supabase query
// ---------------------------------------------------------------------------

export async function getCustomerBookings(
  userId: string,
): Promise<AppointmentWithRelations[]> {
  // Find client records for this user
  const { data: clients, error: clientErr } = await supabase
    .from("clients")
    .select("id")
    .eq("user_id", userId);

  if (clientErr) throw new NetworkError(clientErr.message, 500);
  if (!clients?.length) return [];

  const clientIds = clients.map((c) => c.id);

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
    .in("client_id", clientIds)
    .order("starts_at", { ascending: false });

  if (error) throw new NetworkError(error.message, 500);

  return (data ?? []).map((row) => ({
    ...row,
    payment: row.payment?.[0] ?? null,
  })) as AppointmentWithRelations[];
}
