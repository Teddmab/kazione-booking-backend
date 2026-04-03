import { useParams, Link } from "react-router-dom";
import { useStorefront } from "../hooks/useStorefront";
import { NotFoundError } from "../services/bookingService";
import { formatAmount } from "../lib/stripe";

export default function SalonServices() {
  const { slug = "" } = useParams<{ slug: string }>();
  const { data: storefront, isLoading, error } = useStorefront(slug);

  if (isLoading) {
    return (
      <div className="animate-pulse space-y-4 px-4 py-8">
        <div className="h-8 w-48 rounded bg-muted" />
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-24 rounded-lg bg-muted" />
        ))}
      </div>
    );
  }

  if (error instanceof NotFoundError || !storefront) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
        <h1 className="text-4xl font-bold">Salon not found</h1>
        <Link
          to="/"
          className="mt-6 rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Back to marketplace
        </Link>
      </div>
    );
  }

  // Group services by category
  const categories = storefront.services.reduce<
    Record<string, typeof storefront.services>
  >((acc, service) => {
    const cat = service.category || "Other";
    (acc[cat] ??= []).push(service);
    return acc;
  }, {});

  return (
    <div className="space-y-8 px-4 py-8">
      {/* Header */}
      <div>
        <Link
          to={`/salon/${slug}`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Back to {storefront.name}
        </Link>
        <h1 className="mt-2 text-2xl font-bold">Services</h1>
        <p className="text-muted-foreground">
          {storefront.services.length} services available
        </p>
      </div>

      {/* Services by category */}
      {Object.entries(categories).map(([category, services]) => (
        <section key={category}>
          <h2 className="text-lg font-semibold">{category}</h2>
          <div className="mt-3 space-y-3">
            {services.map((service) => (
              <div
                key={service.id}
                className="flex items-center justify-between rounded-lg border bg-card p-4 shadow-sm"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium">{service.name}</h3>
                    {service.popular && (
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        Popular
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground line-clamp-2">
                    {service.description}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {service.duration}
                  </p>
                </div>
                <div className="ml-4 flex flex-col items-end gap-2">
                  <span className="text-sm font-semibold">
                    {formatAmount(service.price, service.currency)}
                  </span>
                  <Link
                    to={`/salon/${slug}/book?service=${service.id}`}
                    className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    Book
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
