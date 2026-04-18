import Stripe from "stripe";

export const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-04-10",
  httpClient: Stripe.createFetchHttpClient(),
});

export interface PaymentIntentCustomer {
  email: string;
  name: string;
  phone?: string;
  bookingReference?: string;
  serviceName?: string;
}

/**
 * Create a Stripe PaymentIntent with standard metadata and customer details.
 */
export async function createPaymentIntent(
  amount: number,
  currency: string,
  metadata: Record<string, string>,
  stripeAccountId?: string,
  customer?: PaymentIntentCustomer,
) {
  // Restrict to card only until PayPal and PawaPay are wired.
  // Remove this restriction and re-enable automatic_payment_methods once
  // those providers are integrated.
  const params: Stripe.PaymentIntentCreateParams = {
    amount: Math.round(amount * 100), // Stripe uses cents
    currency: currency.toLowerCase(),
    metadata,
    payment_method_types: ["card"],
    ...(customer?.email ? { receipt_email: customer.email } : {}),
    ...(customer?.bookingReference || customer?.serviceName || customer?.name
      ? {
          description: [
            customer.bookingReference,
            customer.serviceName,
            customer.name ? `for ${customer.name}` : null,
          ].filter(Boolean).join(" — "),
        }
      : {}),
  };

  if (stripeAccountId) {
    return await stripe.paymentIntents.create(params, {
      stripeAccount: stripeAccountId,
    });
  }

  return await stripe.paymentIntents.create(params);
}
