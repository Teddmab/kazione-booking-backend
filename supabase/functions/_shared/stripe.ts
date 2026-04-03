import Stripe from "stripe";

export const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-04-10",
  httpClient: Stripe.createFetchHttpClient(),
});

/**
 * Create a Stripe PaymentIntent with standard metadata.
 */
export async function createPaymentIntent(
  amount: number,
  currency: string,
  metadata: Record<string, string>,
  stripeAccountId?: string,
) {
  const params: Stripe.PaymentIntentCreateParams = {
    amount: Math.round(amount * 100), // Stripe uses cents
    currency: currency.toLowerCase(),
    metadata,
    automatic_payment_methods: { enabled: true },
  };

  const options: Stripe.RequestOptions = {};
  if (stripeAccountId) {
    options.stripeAccount = stripeAccountId;
  }

  return await stripe.paymentIntents.create(params, options);
}
