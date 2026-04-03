import { useState } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import { useStorefront } from "../hooks/useStorefront";
import { useAvailability } from "../hooks/useAvailability";
import { useCreateBooking } from "../hooks/useCreateBooking";
import { SlotTakenError } from "../services/bookingService";
import { formatAmount } from "../lib/stripe";
import PaymentElement from "../components/stripe/PaymentElement";
import type { CreateBookingClient, Slot } from "../types/api";

type Step = "service" | "datetime" | "details" | "payment" | "confirmed";

export default function SalonBooking() {
  const { slug = "" } = useParams<{ slug: string }>();
  const [searchParams] = useSearchParams();

  const { data: storefront, isLoading: storefrontLoading } =
    useStorefront(slug);

  // ── Local state ───────────────────────────────────────────
  const [step, setStep] = useState<Step>("service");
  const [selectedServiceId, setSelectedServiceId] = useState(
    searchParams.get("service") ?? "",
  );
  const [selectedDate, setSelectedDate] = useState(
    () => new Date().toISOString().split("T")[0],
  );
  const [selectedStaffId, setSelectedStaffId] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<
    "deposit" | "full" | "later"
  >("later");
  const [clientInfo, setClientInfo] = useState<CreateBookingClient>({
    name: "",
    email: "",
    phone: "",
    notes: "",
  });
  const [bookingRef, setBookingRef] = useState("");
  const [clientSecret, setClientSecret] = useState<string | null>(null);

  // ── Hooks ─────────────────────────────────────────────────
  const {
    data: availability,
    isLoading: slotsLoading,
    isFetching: slotsFetching,
  } = useAvailability({
    business_id: storefront?.businessId,
    service_id: selectedServiceId,
    date: selectedDate,
    staff_id: selectedStaffId ?? undefined,
  });

  const createBooking = useCreateBooking();

  // ── Derived ───────────────────────────────────────────────
  const selectedService = storefront?.services.find(
    (s) => s.id === selectedServiceId,
  );
  const currency = storefront?.currencyCode ?? "EUR";

  // ── Handlers ──────────────────────────────────────────────
  function handleSelectService(id: string) {
    setSelectedServiceId(id);
    setSelectedSlot(null);
    setStep("datetime");
  }

  function handleSelectSlot(slot: Slot) {
    setSelectedSlot(slot);
    // If slot has exactly one staff, auto-select
    if (slot.staff.length === 1) {
      setSelectedStaffId(slot.staff[0].id);
    }
    setStep("details");
  }

  async function handleConfirm() {
    if (!storefront || !selectedService || !selectedSlot) return;

    createBooking.mutate(
      {
        business_id: storefront.businessId,
        service_id: selectedServiceId,
        staff_profile_id: selectedStaffId,
        date: selectedDate,
        time: selectedSlot.time,
        client: clientInfo,
        payment_method: paymentMethod,
      },
      {
        onSuccess: (result) => {
          setBookingRef(result.booking_reference);
          if (result.payment_intent_client_secret) {
            setClientSecret(result.payment_intent_client_secret);
            setStep("payment");
          } else {
            setStep("confirmed");
          }
        },
      },
    );
  }

  // ── Loading / error states ────────────────────────────────
  if (storefrontLoading) {
    return (
      <div className="animate-pulse space-y-4 px-4 py-8">
        <div className="h-8 w-48 rounded bg-muted" />
        <div className="h-64 rounded-lg bg-muted" />
      </div>
    );
  }

  if (!storefront) {
    return (
      <div className="py-20 text-center">
        <h1 className="text-2xl font-bold">Salon not found</h1>
        <Link
          to="/"
          className="mt-4 inline-block text-sm text-primary hover:underline"
        >
          Back to marketplace
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8 px-4 py-8">
      {/* Back link */}
      <Link
        to={`/salon/${slug}`}
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← {storefront.name}
      </Link>

      {/* ── Step indicator ───────────────────────────────────── */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {(["service", "datetime", "details", "payment", "confirmed"] as Step[]).map(
          (s, i) => (
            <span
              key={s}
              className={
                step === s ? "font-semibold text-primary" : ""
              }
            >
              {i > 0 && " → "}
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </span>
          ),
        )}
      </div>

      {/* ────────────────────────────────────────────────────── */}
      {/*  STEP 1 — Service selection                            */}
      {/* ────────────────────────────────────────────────────── */}
      {step === "service" && (
        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Choose a service</h2>
          {storefront.services.map((service) => (
            <button
              key={service.id}
              onClick={() => handleSelectService(service.id)}
              className={`w-full rounded-lg border p-4 text-left transition-colors hover:border-primary ${
                selectedServiceId === service.id
                  ? "border-primary bg-primary/5"
                  : "bg-card"
              }`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-medium">{service.name}</h3>
                  <p className="text-sm text-muted-foreground">
                    {service.duration}
                  </p>
                </div>
                <span className="text-sm font-semibold">
                  {formatAmount(service.price, service.currency)}
                </span>
              </div>
            </button>
          ))}
        </section>
      )}

      {/* ────────────────────────────────────────────────────── */}
      {/*  STEP 2 — Date & time                                  */}
      {/* ────────────────────────────────────────────────────── */}
      {step === "datetime" && selectedService && (
        <section className="space-y-4">
          <h2 className="text-xl font-semibold">
            Pick a date &amp; time for {selectedService.name}
          </h2>

          {/* Date picker */}
          <div>
            <label className="text-sm font-medium">Date</label>
            <input
              type="date"
              value={selectedDate}
              min={new Date().toISOString().split("T")[0]}
              onChange={(e) => {
                setSelectedDate(e.target.value);
                setSelectedSlot(null);
              }}
              className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>

          {/* Staff filter (optional) */}
          {storefront.team.length > 1 && (
            <div>
              <label className="text-sm font-medium">
                Preferred stylist (optional)
              </label>
              <select
                value={selectedStaffId ?? ""}
                onChange={(e) =>
                  setSelectedStaffId(e.target.value || null)
                }
                className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
              >
                <option value="">Any available</option>
                {storefront.team
                  .filter((m) => m.serviceIds.includes(selectedServiceId))
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
            </div>
          )}

          {/* Slots */}
          {slotsLoading || slotsFetching ? (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={i}
                  className="h-10 animate-pulse rounded-md bg-muted"
                />
              ))}
            </div>
          ) : availability && !availability.isAvailable ? (
            <p className="rounded-md bg-muted p-4 text-sm text-muted-foreground">
              {availability.reason === "DAY_OFF"
                ? "This day is a day off."
                : availability.reason === "FULLY_BOOKED"
                  ? "Fully booked for this day."
                  : availability.reason === "DATE_IN_PAST"
                    ? "This date is in the past."
                    : "No availability for this date."}
            </p>
          ) : availability && availability.slots.length > 0 ? (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {availability.slots.map((slot) => (
                <button
                  key={slot.time}
                  onClick={() => handleSelectSlot(slot)}
                  className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                    selectedSlot?.time === slot.time
                      ? "border-primary bg-primary text-primary-foreground"
                      : "hover:border-primary"
                  }`}
                >
                  {slot.time}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Select a date to see available times.
            </p>
          )}

          {/* Navigation */}
          <div className="flex gap-3 pt-2">
            <button
              onClick={() => setStep("service")}
              className="rounded-md border px-4 py-2 text-sm hover:bg-muted"
            >
              Back
            </button>
          </div>
        </section>
      )}

      {/* ────────────────────────────────────────────────────── */}
      {/*  STEP 3 — Client details                               */}
      {/* ────────────────────────────────────────────────────── */}
      {step === "details" && selectedService && selectedSlot && (
        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Your details</h2>

          {/* Summary */}
          <div className="rounded-lg border bg-card p-4 text-sm">
            <p>
              <span className="font-medium">Service:</span>{" "}
              {selectedService.name}
            </p>
            <p>
              <span className="font-medium">Date:</span> {selectedDate}
            </p>
            <p>
              <span className="font-medium">Time:</span> {selectedSlot.time}
            </p>
            <p>
              <span className="font-medium">Price:</span>{" "}
              {formatAmount(selectedService.price, currency)}
            </p>
          </div>

          {/* Client form */}
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium">Full name *</label>
              <input
                type="text"
                value={clientInfo.name}
                onChange={(e) =>
                  setClientInfo({ ...clientInfo, name: e.target.value })
                }
                className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Email *</label>
              <input
                type="email"
                value={clientInfo.email}
                onChange={(e) =>
                  setClientInfo({ ...clientInfo, email: e.target.value })
                }
                className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Phone *</label>
              <input
                type="tel"
                value={clientInfo.phone}
                onChange={(e) =>
                  setClientInfo({ ...clientInfo, phone: e.target.value })
                }
                className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Notes (optional)</label>
              <textarea
                value={clientInfo.notes ?? ""}
                onChange={(e) =>
                  setClientInfo({ ...clientInfo, notes: e.target.value })
                }
                rows={2}
                className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
              />
            </div>
          </div>

          {/* Payment method */}
          <div>
            <label className="text-sm font-medium">Payment</label>
            <div className="mt-2 space-y-2">
              {(["later", "deposit", "full"] as const).map((method) => (
                <label
                  key={method}
                  className={`flex cursor-pointer items-center gap-3 rounded-md border p-3 text-sm ${
                    paymentMethod === method ? "border-primary bg-primary/5" : ""
                  }`}
                >
                  <input
                    type="radio"
                    name="payment"
                    checked={paymentMethod === method}
                    onChange={() => setPaymentMethod(method)}
                    className="accent-primary"
                  />
                  {method === "later" && "Pay at salon"}
                  {method === "deposit" && "Pay deposit now"}
                  {method === "full" && "Pay in full now"}
                </label>
              ))}
            </div>
          </div>

          {/* Slot taken alternatives */}
          {createBooking.alternatives.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-950">
              <p className="font-medium text-amber-800 dark:text-amber-200">
                This time slot is no longer available. Try one of these:
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {createBooking.alternatives.map((time) => (
                  <button
                    key={time}
                    onClick={() => {
                      setSelectedSlot({ time, staff: selectedSlot.staff });
                      createBooking.clearAlternatives();
                    }}
                    className="rounded-md border border-amber-300 px-3 py-1 text-sm hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900"
                  >
                    {time}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Error */}
          {createBooking.error &&
            !(createBooking.error instanceof SlotTakenError) && (
              <p className="text-sm text-destructive">
                {createBooking.error.message}
              </p>
            )}

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <button
              onClick={() => setStep("datetime")}
              className="rounded-md border px-4 py-2 text-sm hover:bg-muted"
            >
              Back
            </button>
            <button
              onClick={handleConfirm}
              disabled={
                !clientInfo.name ||
                !clientInfo.email ||
                !clientInfo.phone ||
                createBooking.isPending
              }
              className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
            >
              {createBooking.isPending ? "Booking…" : "Confirm booking"}
            </button>
          </div>
        </section>
      )}

      {/* ────────────────────────────────────────────────────── */}
      {/*  STEP 4 — Payment (Stripe)                             */}
      {/* ────────────────────────────────────────────────────── */}
      {step === "payment" && clientSecret && selectedService && (
        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Payment</h2>
          <p className="text-sm text-muted-foreground">
            Complete your payment for {selectedService.name}
          </p>
          <PaymentElement
            clientSecret={clientSecret}
            amount={selectedService.price}
            currency={currency}
            onSuccess={() => setStep("confirmed")}
            onError={(msg) =>
              createBooking.mutate(
                {} as never, // won't fire — just need the error setter
                { onError: () => {} },
              ) || alert(msg)
            }
          />
        </section>
      )}

      {/* ────────────────────────────────────────────────────── */}
      {/*  STEP 5 — Confirmed                                    */}
      {/* ────────────────────────────────────────────────────── */}
      {step === "confirmed" && (
        <section className="space-y-4 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100 text-3xl dark:bg-green-900">
            ✓
          </div>
          <h2 className="text-2xl font-bold">Booking confirmed!</h2>
          <p className="text-muted-foreground">
            Your booking reference is{" "}
            <span className="font-mono font-semibold text-foreground">
              {bookingRef}
            </span>
          </p>
          <p className="text-sm text-muted-foreground">
            We've sent a confirmation to {clientInfo.email}
          </p>
          <div className="flex justify-center gap-3 pt-4">
            <Link
              to={`/salon/${slug}`}
              className="rounded-md border px-4 py-2 text-sm hover:bg-muted"
            >
              Back to salon
            </Link>
            <Link
              to="/bookings"
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              View my bookings
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}
