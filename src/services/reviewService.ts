import { supabase } from "../lib/supabase";
import { NetworkError } from "../types/api";
import type {
  PaginatedReviews,
  ReviewRow,
  SubmitReviewData,
} from "../types/api";

// ---------------------------------------------------------------------------
// getBusinessReviews — paginated reviews with client info
// ---------------------------------------------------------------------------

export async function getBusinessReviews(
  businessId: string,
  page = 1,
  limit = 20,
): Promise<PaginatedReviews> {
  const from = (page - 1) * limit;

  const { data, error, count } = await supabase
    .from("reviews")
    .select(
      `
      *,
      client:clients(first_name, last_name, avatar_url)
    `,
      { count: "exact" },
    )
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .range(from, from + limit - 1);

  if (error) throw new NetworkError(error.message, 500);
  return { reviews: (data ?? []) as ReviewRow[], total: count ?? 0 };
}

// ---------------------------------------------------------------------------
// submitReview — verify appointment is completed & belongs to client
// ---------------------------------------------------------------------------

export async function submitReview(
  data: SubmitReviewData,
): Promise<ReviewRow> {
  // 1. Get authenticated user
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) throw new NetworkError("Not authenticated", 401);

  // 2. Verify appointment exists, is completed, and belongs to the requesting client
  const { data: appt, error: apptErr } = await supabase
    .from("appointments")
    .select("id, business_id, client_id, status, clients!inner(user_id)")
    .eq("id", data.appointmentId)
    .single();

  if (apptErr || !appt) {
    throw new NetworkError("Appointment not found", 404);
  }

  const client = appt.clients as unknown as { user_id: string | null };
  if (client.user_id !== user.id) {
    throw new NetworkError("This appointment does not belong to you", 403);
  }

  if (appt.status !== "completed") {
    throw new NetworkError(
      "Reviews can only be submitted for completed appointments",
      400,
    );
  }

  // 3. Check for existing review on this appointment
  const { data: existing } = await supabase
    .from("reviews")
    .select("id")
    .eq("appointment_id", data.appointmentId)
    .maybeSingle();

  if (existing) {
    throw new NetworkError("A review already exists for this appointment", 409);
  }

  // 4. Insert review
  const { data: review, error: insertErr } = await supabase
    .from("reviews")
    .insert({
      business_id: appt.business_id,
      client_id: appt.client_id,
      appointment_id: data.appointmentId,
      rating: data.rating,
      comment: data.comment ?? null,
    })
    .select(
      `
      *,
      client:clients(first_name, last_name, avatar_url)
    `,
    )
    .single();

  if (insertErr) throw new NetworkError(insertErr.message, 500);
  return review as ReviewRow;
}

// ---------------------------------------------------------------------------
// replyToReview — owner/manager sets owner_reply
// ---------------------------------------------------------------------------

export async function replyToReview(
  reviewId: string,
  reply: string,
): Promise<ReviewRow> {
  const { data, error } = await supabase
    .from("reviews")
    .update({
      owner_reply: reply,
      replied_at: new Date().toISOString(),
    })
    .eq("id", reviewId)
    .select(
      `
      *,
      client:clients(first_name, last_name, avatar_url)
    `,
    )
    .single();

  if (error) throw new NetworkError(error.message, 500);
  return data as ReviewRow;
}
