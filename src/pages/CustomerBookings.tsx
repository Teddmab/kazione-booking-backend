import { useState } from "react";
import { Link } from "react-router-dom";
import {
  useCustomerBookings,
  useLookupBooking,
} from "../hooks/useCustomerBookings";
import type { AppointmentWithRelations } from "../types/api";

/* ------------------------------------------------------------------ */
/*  Booking card                                                       */
/* ------------------------------------------------------------------ */

function BookingCard({ booking }: { booking: AppointmentWithRelations }) {
  const isPast = new Date(booking.ends_at) < new Date();
  const statusColors: Record<string, string> = {
    confirmed: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    pending_payment: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
    completed: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
    cancelled: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
    no_show: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200",
  };

  return (
    <Link
      to={`/bookings/${booking.booking_reference}`}
      className="block rounded-lg border bg-card p-4 shadow-sm transition-shadow hover:shadow-md"
    >
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-medium">{booking.service.name}</h3>
          {booking.staff && (
            <p className="text-sm text-muted-foreground">
              with {booking.staff.display_name}
            </p>
          )}
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            statusColors[booking.status] ?? "bg-muted"
          }`}
        >
          {booking.status.replace(/_/g, " ")}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-4 text-sm text-muted-foreground">
        <span>
          {new Date(booking.starts_at).toLocaleDateString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
          })}
        </span>
        <span>
          {new Date(booking.starts_at).toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
        <span>{booking.duration_minutes} min</span>
      </div>
      <p className="mt-1 font-mono text-xs text-muted-foreground">
        Ref: {booking.booking_reference}
      </p>
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/*  Guest lookup form                                                  */
/* ------------------------------------------------------------------ */

function GuestLookup() {
  const [email, setEmail] = useState("");
  const [reference, setReference] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const {
    data: booking,
    isLoading,
    error,
  } = useLookupBooking(
    submitted ? email : "",
    submitted ? reference : "",
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Look up a booking</h2>
      <p className="text-sm text-muted-foreground">
        Booked as a guest? Enter your email and booking reference to find your
        appointment.
      </p>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="text-sm font-medium">Email</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setSubmitted(false);
            }}
            className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="you@example.com"
          />
        </div>
        <div>
          <label className="text-sm font-medium">Booking reference</label>
          <input
            type="text"
            required
            value={reference}
            onChange={(e) => {
              setReference(e.target.value);
              setSubmitted(false);
            }}
            className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="KZ-XXXXXX"
          />
        </div>
        <button
          type="submit"
          disabled={isLoading}
          className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {isLoading ? "Looking up…" : "Find booking"}
        </button>
      </form>

      {submitted && error && (
        <p className="text-sm text-destructive">
          No booking found. Check your email and reference.
        </p>
      )}

      {booking && (
        <Link
          to={`/bookings/${booking.bookingReference}`}
          className="block rounded-lg border bg-card p-4 shadow-sm transition-shadow hover:shadow-md"
        >
          <div className="flex items-start justify-between">
            <div>
              <h3 className="font-medium">{booking.service.name}</h3>
              <p className="text-sm text-muted-foreground">
                with {booking.staff.name} at {booking.salon.name}
              </p>
            </div>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
              {booking.status}
            </span>
          </div>
          <div className="mt-2 text-sm text-muted-foreground">
            {booking.date} at {booking.time}
          </div>
          <p className="mt-1 text-xs text-primary">View details →</p>
        </Link>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function CustomerBookings() {
  const { data: bookings, isLoading, error } = useCustomerBookings();

  const upcoming = (bookings ?? []).filter(
    (b) =>
      new Date(b.starts_at) >= new Date() &&
      b.status !== "cancelled" &&
      b.status !== "no_show",
  );
  const past = (bookings ?? []).filter(
    (b) =>
      new Date(b.starts_at) < new Date() ||
      b.status === "cancelled" ||
      b.status === "no_show",
  );

  return (
    <div className="mx-auto max-w-2xl space-y-8 px-4 py-8">
      <h1 className="text-2xl font-bold">My Bookings</h1>

      {/* Authenticated bookings */}
      {isLoading ? (
        <div className="space-y-3 animate-pulse">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-24 rounded-lg bg-muted" />
          ))}
        </div>
      ) : error ? (
        <p className="text-sm text-destructive">
          Failed to load bookings. Please try again.
        </p>
      ) : bookings && bookings.length > 0 ? (
        <>
          {/* Upcoming */}
          {upcoming.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold">
                Upcoming ({upcoming.length})
              </h2>
              <div className="mt-3 space-y-3">
                {upcoming.map((b) => (
                  <BookingCard key={b.id} booking={b} />
                ))}
              </div>
            </section>
          )}

          {/* Past */}
          {past.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold">
                Past ({past.length})
              </h2>
              <div className="mt-3 space-y-3">
                {past.map((b) => (
                  <BookingCard key={b.id} booking={b} />
                ))}
              </div>
            </section>
          )}
        </>
      ) : (
        <p className="text-muted-foreground">
          No bookings yet.{" "}
          <Link to="/" className="text-primary hover:underline">
            Browse salons
          </Link>{" "}
          to book your first appointment.
        </p>
      )}

      {/* Divider */}
      <div className="border-t" />

      {/* Guest lookup */}
      <GuestLookup />
    </div>
  );
}
