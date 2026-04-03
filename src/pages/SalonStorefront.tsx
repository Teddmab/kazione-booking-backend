import { useParams, Link } from "react-router-dom";
import { useStorefront } from "../hooks/useStorefront";
import { NotFoundError } from "../services/bookingService";
import { formatAmount } from "../lib/stripe";

/* ------------------------------------------------------------------ */
/*  Loading skeleton                                                   */
/* ------------------------------------------------------------------ */

function StorefrontSkeleton() {
  return (
    <div className="animate-pulse space-y-6">
      {/* Cover */}
      <div className="h-64 rounded-xl bg-muted" />
      {/* Title */}
      <div className="space-y-3 px-4">
        <div className="h-8 w-2/3 rounded bg-muted" />
        <div className="h-4 w-1/2 rounded bg-muted" />
      </div>
      {/* Cards */}
      <div className="grid gap-4 px-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-48 rounded-lg bg-muted" />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  404 state                                                          */
/* ------------------------------------------------------------------ */

function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <h1 className="text-4xl font-bold">Salon not found</h1>
      <p className="mt-2 text-muted-foreground">
        The salon you're looking for doesn't exist or may have been removed.
      </p>
      <Link
        to="/"
        className="mt-6 rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        Back to marketplace
      </Link>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function SalonStorefront() {
  const { slug = "" } = useParams<{ slug: string }>();
  const { data: storefront, isLoading, error } = useStorefront(slug);

  if (isLoading) return <StorefrontSkeleton />;
  if (error instanceof NotFoundError || !storefront) return <NotFound />;
  if (error) {
    return (
      <div className="py-20 text-center text-destructive">
        Something went wrong. Please try again later.
      </div>
    );
  }

  return (
    <div className="space-y-12">
      {/* ── Hero ─────────────────────────────────────────────── */}
      {storefront.sections.hero && (
        <section className="relative overflow-hidden rounded-xl">
          {storefront.coverImageUrl ? (
            <img
              src={storefront.coverImageUrl}
              alt={storefront.name}
              className="h-72 w-full object-cover sm:h-96"
            />
          ) : (
            <div className="h-72 bg-gradient-to-br from-primary/20 to-primary/5 sm:h-96" />
          )}
          <div className="absolute inset-0 flex flex-col items-start justify-end bg-gradient-to-t from-black/60 to-transparent p-6 text-white">
            <div className="flex items-center gap-3">
              {storefront.logoUrl && (
                <img
                  src={storefront.logoUrl}
                  alt=""
                  className="h-14 w-14 rounded-full border-2 border-white object-cover"
                />
              )}
              <div>
                <h1 className="text-2xl font-bold sm:text-3xl">
                  {storefront.name}
                  {storefront.verified && (
                    <span className="ml-2 inline-block rounded-full bg-blue-500 px-2 py-0.5 text-xs font-medium">
                      ✓ Verified
                    </span>
                  )}
                </h1>
                {storefront.tagline && (
                  <p className="mt-1 text-sm text-white/80">
                    {storefront.tagline}
                  </p>
                )}
              </div>
            </div>
            {/* Rating */}
            {storefront.reviewCount > 0 && (
              <p className="mt-2 text-sm text-white/90">
                ★ {storefront.rating.toFixed(1)} ({storefront.reviewCount}{" "}
                reviews)
              </p>
            )}
          </div>
        </section>
      )}

      {/* ── About ────────────────────────────────────────────── */}
      {storefront.sections.about && storefront.description && (
        <section className="px-4">
          <h2 className="text-xl font-semibold">About</h2>
          <p className="mt-2 text-muted-foreground">
            {storefront.description}
          </p>
          {storefront.extendedDescription && (
            <p className="mt-2 text-sm text-muted-foreground">
              {storefront.extendedDescription}
            </p>
          )}
        </section>
      )}

      {/* ── Services ─────────────────────────────────────────── */}
      {storefront.sections.services && storefront.services.length > 0 && (
        <section className="px-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold">Services</h2>
            <Link
              to={`/salon/${slug}/services`}
              className="text-sm font-medium text-primary hover:underline"
            >
              View all
            </Link>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {storefront.services.slice(0, 6).map((service) => (
              <div
                key={service.id}
                className="rounded-lg border bg-card p-4 shadow-sm"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-medium">{service.name}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {service.duration}
                    </p>
                  </div>
                  <span className="text-sm font-semibold">
                    {formatAmount(service.price, service.currency)}
                  </span>
                </div>
                {service.popular && (
                  <span className="mt-2 inline-block rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                    Popular
                  </span>
                )}
                <Link
                  to={`/salon/${slug}/book?service=${service.id}`}
                  className="mt-3 block w-full rounded-md bg-primary py-2 text-center text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  Book now
                </Link>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Promotions ───────────────────────────────────────── */}
      {storefront.sections.promotions && storefront.promotions.length > 0 && (
        <section className="px-4">
          <h2 className="text-xl font-semibold">Promotions</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {storefront.promotions.map((promo) => (
              <div
                key={promo.id}
                className="rounded-lg border border-primary/20 bg-primary/5 p-4"
              >
                <div className="flex items-start justify-between">
                  <h3 className="font-medium">{promo.title}</h3>
                  {promo.badge && (
                    <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
                      {promo.badge}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {promo.description}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Gallery ──────────────────────────────────────────── */}
      {storefront.sections.gallery && storefront.gallery.length > 0 && (
        <section className="px-4">
          <h2 className="text-xl font-semibold">Gallery</h2>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {storefront.gallery.map((img) => (
              <img
                key={img.id}
                src={img.imageUrl}
                alt={img.caption ?? ""}
                className="aspect-square rounded-lg object-cover"
              />
            ))}
          </div>
        </section>
      )}

      {/* ── Team ─────────────────────────────────────────────── */}
      {storefront.sections.team && storefront.team.length > 0 && (
        <section className="px-4">
          <h2 className="text-xl font-semibold">Our Team</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {storefront.team.map((member) => (
              <div
                key={member.id}
                className="flex items-start gap-4 rounded-lg border bg-card p-4"
              >
                {member.avatar ? (
                  <img
                    src={member.avatar}
                    alt={member.name}
                    className="h-12 w-12 rounded-full object-cover"
                  />
                ) : (
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-lg font-semibold">
                    {member.name.charAt(0)}
                  </div>
                )}
                <div>
                  <h3 className="font-medium">{member.name}</h3>
                  <p className="text-sm text-muted-foreground">{member.role}</p>
                  {member.specialties.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {member.specialties.map((s) => (
                        <span
                          key={s}
                          className="rounded bg-muted px-1.5 py-0.5 text-xs"
                        >
                          {s}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Reviews ──────────────────────────────────────────── */}
      {storefront.sections.reviews && storefront.reviews.length > 0 && (
        <section className="px-4">
          <h2 className="text-xl font-semibold">Reviews</h2>
          <div className="mt-4 space-y-4">
            {storefront.reviews.map((review) => (
              <div key={review.id} className="rounded-lg border bg-card p-4">
                <div className="flex items-center gap-3">
                  {review.clientAvatar ? (
                    <img
                      src={review.clientAvatar}
                      alt=""
                      className="h-8 w-8 rounded-full object-cover"
                    />
                  ) : (
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-sm font-semibold">
                      {review.clientName.charAt(0)}
                    </div>
                  )}
                  <div>
                    <p className="text-sm font-medium">{review.clientName}</p>
                    <p className="text-xs text-muted-foreground">
                      {"★".repeat(review.rating)}
                      {"☆".repeat(5 - review.rating)}
                    </p>
                  </div>
                </div>
                {review.comment && (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {review.comment}
                  </p>
                )}
                {review.ownerReply && (
                  <div className="mt-2 rounded bg-muted/50 p-2 text-sm">
                    <span className="font-medium">Reply: </span>
                    {review.ownerReply}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Contact ──────────────────────────────────────────── */}
      <section className="px-4 pb-12">
        <h2 className="text-xl font-semibold">Contact</h2>
        <div className="mt-4 space-y-1 text-sm text-muted-foreground">
          {storefront.contact.address && <p>{storefront.contact.address}</p>}
          {storefront.contact.city && <p>{storefront.contact.city}</p>}
          {storefront.contact.phone && <p>Tel: {storefront.contact.phone}</p>}
          {storefront.contact.email && (
            <p>Email: {storefront.contact.email}</p>
          )}
          {storefront.contact.website && (
            <a
              href={storefront.contact.website}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              {storefront.contact.website}
            </a>
          )}
        </div>

        {/* Policies */}
        {(storefront.bookingPolicy || storefront.cancellationPolicy) && (
          <div className="mt-6 space-y-2 text-sm text-muted-foreground">
            {storefront.bookingPolicy && (
              <div>
                <span className="font-medium text-foreground">
                  Booking policy:{" "}
                </span>
                {storefront.bookingPolicy}
              </div>
            )}
            {storefront.cancellationPolicy && (
              <div>
                <span className="font-medium text-foreground">
                  Cancellation policy:{" "}
                </span>
                {storefront.cancellationPolicy}
              </div>
            )}
          </div>
        )}
      </section>

      {/* ── Floating CTA ─────────────────────────────────────── */}
      {storefront.sections.booking && (
        <div className="fixed inset-x-0 bottom-0 border-t bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <Link
            to={`/salon/${slug}/book`}
            className="block w-full rounded-md bg-primary py-3 text-center text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Book an appointment
          </Link>
        </div>
      )}
    </div>
  );
}
