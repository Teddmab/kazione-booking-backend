import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  useCancelBooking,
  useRescheduleBooking,
} from "../hooks/useCustomerBookings";
import { lookupBookingByReference } from "../services/bookingService";
import { NotFoundError } from "../services/bookingService";
import { formatAmount } from "../lib/stripe";
import { supabase } from "../lib/supabase";
import type { LookupBookingResult } from "../types/api";

/* ------------------------------------------------------------------ */
/*  Reschedule dialog (inline)                                         */
/* ------------------------------------------------------------------ */

function RescheduleForm({
  booking,
  onDone,
}: {
  booking: LookupBookingResult;
  onDone: () => void;
}) {
  const [newDate, setNewDate] = useState(booking.date);
  const [newTime, setNewTime] = useState(booking.time);
  const reschedule = useRescheduleBooking();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    reschedule.mutate(
      {
        booking_reference: booking.bookingReference,
        email: booking.salon.email ?? undefined,
        new_date: newDate,
        new_time: newTime,
      },
      { onSuccess: onDone },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border p-4">
      <h3 className="font-medium">Reschedule booking</h3>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-sm font-medium">New date</label>
          <input
            type="date"
            value={newDate}
            min={new Date().toISOString().split("T")[0]}
            onChange={(e) => setNewDate(e.target.value)}
            className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-sm font-medium">New time</label>
          <input
            type="time"
            value={newTime}
            onChange={(e) => setNewTime(e.target.value)}
            className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
      </div>
      {reschedule.error && (
        <p className="text-sm text-destructive">{reschedule.error.message}</p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onDone}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={reschedule.isPending}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {reschedule.isPending ? "Rescheduling…" : "Confirm reschedule"}
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function BookingDetail() {
  const { reference = "" } = useParams<{ reference: string }>();
  const navigate = useNavigate();
  const [showReschedule, setShowReschedule] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  // Get the user's email for lookup
  const {
    data: booking,
    isLoading,
    error,
  } = useQuery<LookupBookingResult>({
    queryKey: ["booking-detail", reference],
    queryFn: async () => {
      // Try authenticated user's email first
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const email = user?.email;
      if (!email) throw new NotFoundError("Please log in or use the lookup form");
      return lookupBookingByReference(email, reference);
    },
    enabled: !!reference,
    retry: false,
  });

  const cancelBookingMutation = useCancelBooking();

  function handleCancel() {
    if (!booking) return;
    cancelBookingMutation.mutate(
      {
        booking_reference: booking.bookingReference,
        reason: cancelReason || undefined,
      },
      {
        onSuccess: () => {
          setShowCancelConfirm(false);
          navigate("/bookings");
        },
      },
    );
  }

  // ── Loading ───────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="mx-auto max-w-2xl animate-pulse space-y-4 px-4 py-8">
        <div className="h-8 w-48 rounded bg-muted" />
        <div className="h-64 rounded-lg bg-muted" />
      </div>
    );
  }

  // ── Error / not found ─────────────────────────────────────
  if (error || !booking) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 px-4 py-20 text-center">
        <h1 className="text-2xl font-bold">Booking not found</h1>
        <p className="text-muted-foreground">
          {error instanceof NotFoundError
            ? error.message
            : "We couldn't find this booking."}
        </p>
        <Link
          to="/bookings"
          className="inline-block rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Back to my bookings
        </Link>
      </div>
    );
  }

  const isPast = new Date(booking.endsAt) < new Date();
  const isCancelled = booking.status === "cancelled";
  const canModify = !isPast && !isCancelled;

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-8">
      {/* Back */}
      <Link
        to="/bookings"
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← My bookings
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">{booking.service.name}</h1>
          <p className="text-muted-foreground">
            at{" "}
            <Link
              to={`/salon/${booking.salon.slug}`}
              className="text-primary hover:underline"
            >
              {booking.salon.name}
            </Link>
          </p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-sm font-medium ${
            isCancelled
              ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
              : isPast
                ? "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200"
                : "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
          }`}
        >
          {booking.status.replace(/_/g, " ")}
        </span>
      </div>

      {/* Details card */}
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="font-medium text-muted-foreground">Date</dt>
            <dd>{booking.date}</dd>
          </div>
          <div>
            <dt className="font-medium text-muted-foreground">Time</dt>
            <dd>{booking.time}</dd>
          </div>
          <div>
            <dt className="font-medium text-muted-foreground">Duration</dt>
            <dd>{booking.durationMinutes} minutes</dd>
          </div>
          <div>
            <dt className="font-medium text-muted-foreground">Stylist</dt>
            <dd className="flex items-center gap-2">
              {booking.staff.avatar && (
                <img
                  src={booking.staff.avatar}
                  alt=""
                  className="h-6 w-6 rounded-full object-cover"
                />
              )}
              {booking.staff.name}
            </dd>
          </div>
          <div>
            <dt className="font-medium text-muted-foreground">Price</dt>
            <dd>
              {formatAmount(
                booking.price,
                booking.service.currency,
              )}
            </dd>
          </div>
          <div>
            <dt className="font-medium text-muted-foreground">Reference</dt>
            <dd className="font-mono">{booking.bookingReference}</dd>
          </div>
        </dl>

        {/* Payment info */}
        {booking.payment && (
          <div className="mt-4 border-t pt-4">
            <h3 className="text-sm font-medium">Payment</h3>
            <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
              <div>
                <dt className="text-muted-foreground">Status</dt>
                <dd className="capitalize">{booking.payment.status}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Method</dt>
                <dd className="capitalize">{booking.payment.method}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Amount</dt>
                <dd>
                  {formatAmount(
                    booking.payment.amount,
                    booking.service.currency,
                  )}
                </dd>
              </div>
              {booking.payment.depositAmount > 0 && (
                <div>
                  <dt className="text-muted-foreground">Deposit</dt>
                  <dd>
                    {formatAmount(
                      booking.payment.depositAmount,
                      booking.service.currency,
                    )}
                  </dd>
                </div>
              )}
            </dl>
          </div>
        )}

        {/* Notes */}
        {booking.notes && (
          <div className="mt-4 border-t pt-4">
            <h3 className="text-sm font-medium">Notes</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {booking.notes}
            </p>
          </div>
        )}
      </div>

      {/* Salon contact */}
      <div className="rounded-lg border bg-card p-4 text-sm">
        <h3 className="font-medium">{booking.salon.name}</h3>
        {booking.salon.address && (
          <p className="text-muted-foreground">{booking.salon.address}</p>
        )}
        {booking.salon.phone && (
          <p className="text-muted-foreground">Tel: {booking.salon.phone}</p>
        )}
      </div>

      {/* ── Actions ──────────────────────────────────────────── */}
      {canModify && (
        <div className="space-y-3">
          {/* Reschedule */}
          {showReschedule ? (
            <RescheduleForm
              booking={booking}
              onDone={() => setShowReschedule(false)}
            />
          ) : (
            <button
              onClick={() => setShowReschedule(true)}
              className="w-full rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              Reschedule
            </button>
          )}

          {/* Cancel */}
          {showCancelConfirm ? (
            <div className="space-y-3 rounded-lg border border-destructive/30 p-4">
              <h3 className="font-medium text-destructive">Cancel booking</h3>
              <p className="text-sm text-muted-foreground">
                Are you sure? This action may be subject to the salon's
                cancellation policy.
              </p>
              <div>
                <label className="text-sm font-medium">
                  Reason (optional)
                </label>
                <textarea
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                  rows={2}
                  className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
                />
              </div>
              {cancelBookingMutation.error && (
                <p className="text-sm text-destructive">
                  {cancelBookingMutation.error.message}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => setShowCancelConfirm(false)}
                  className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                >
                  Keep booking
                </button>
                <button
                  onClick={handleCancel}
                  disabled={cancelBookingMutation.isPending}
                  className="rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
                >
                  {cancelBookingMutation.isPending
                    ? "Cancelling…"
                    : "Yes, cancel"}
                </button>
              </div>
              {cancelBookingMutation.isSuccess && (
                <p className="text-sm text-muted-foreground">
                  Refund amount:{" "}
                  {formatAmount(
                    cancelBookingMutation.data.refundAmount,
                    booking.service.currency,
                  )}
                </p>
              )}
            </div>
          ) : (
            <button
              onClick={() => setShowCancelConfirm(true)}
              className="w-full rounded-md border border-destructive/30 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10"
            >
              Cancel booking
            </button>
          )}
        </div>
      )}
    </div>
  );
}
