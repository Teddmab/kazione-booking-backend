import { useState } from "react";
import {
  Elements,
  PaymentElement as StripePaymentElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";
import { getStripe, formatAmount } from "../../lib/stripe";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface PaymentFormProps {
  clientSecret: string;
  amount: number;
  currency: string;
  onSuccess: () => void;
  onError: (message: string) => void;
}

/* ------------------------------------------------------------------ */
/*  Inner form (must be rendered inside <Elements>)                    */
/* ------------------------------------------------------------------ */

function CheckoutForm({
  amount,
  currency,
  onSuccess,
  onError,
}: Omit<PaymentFormProps, "clientSecret">) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [ready, setReady] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (!stripe || !elements) return;

    setSubmitting(true);

    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/booking/confirmation`,
      },
      redirect: "if_required",
    });

    if (error) {
      onError(error.message ?? "Payment failed. Please try again.");
      setSubmitting(false);
    } else {
      onSuccess();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <StripePaymentElement
        onReady={() => setReady(true)}
        options={{ layout: "tabs" }}
      />

      {/* Loading skeleton while Stripe initialises */}
      {!ready && (
        <div className="space-y-3 animate-pulse">
          <div className="h-10 rounded-md bg-muted" />
          <div className="h-10 rounded-md bg-muted" />
          <div className="h-10 rounded-md bg-muted" />
        </div>
      )}

      <button
        type="submit"
        disabled={!stripe || !elements || submitting || !ready}
        className="w-full rounded-md bg-primary px-4 py-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
      >
        {submitting
          ? "Processing…"
          : `Pay ${formatAmount(amount, currency)}`}
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/*  Public wrapper – provides the Elements context                     */
/* ------------------------------------------------------------------ */

export default function PaymentElementWrapper({
  clientSecret,
  amount,
  currency,
  onSuccess,
  onError,
}: PaymentFormProps) {
  return (
    <Elements
      stripe={getStripe()}
      options={{
        clientSecret,
        appearance: {
          theme: "stripe",
          variables: {
            colorPrimary: "hsl(var(--primary))",
            borderRadius: "0.375rem",
          },
        },
      }}
    >
      <CheckoutForm
        amount={amount}
        currency={currency}
        onSuccess={onSuccess}
        onError={onError}
      />
    </Elements>
  );
}
