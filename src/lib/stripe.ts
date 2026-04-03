import { loadStripe, type Stripe } from "@stripe/stripe-js";

let stripePromise: Promise<Stripe | null> | null = null;

/**
 * Lazy-loaded Stripe singleton. Loads the Stripe.js script once on first call.
 */
export function getStripe(): Promise<Stripe | null> {
  if (!stripePromise) {
    const key = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY;
    if (!key) {
      console.error("Missing VITE_STRIPE_PUBLISHABLE_KEY environment variable");
      return Promise.resolve(null);
    }
    stripePromise = loadStripe(key);
  }
  return stripePromise;
}

/**
 * Format a numeric amount as a locale-aware currency string.
 * e.g. formatAmount(30, 'EUR') → '€30.00'
 */
export function formatAmount(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(amount);
}
