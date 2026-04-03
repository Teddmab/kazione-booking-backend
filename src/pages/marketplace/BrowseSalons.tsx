import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { useMarketplaceSalons } from "../../hooks/useMarketplace";
import { formatAmount } from "../../lib/stripe";

// ---------------------------------------------------------------------------
// Category pill data
// ---------------------------------------------------------------------------

const CATEGORIES = [
  "All",
  "Hair",
  "Nails",
  "Spa",
  "Barber",
  "Beauty",
  "Massage",
  "Skincare",
  "Makeup",
] as const;

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function SalonCardSkeleton() {
  return (
    <div className="animate-pulse overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="h-40 bg-muted" />
      <div className="space-y-2 p-4">
        <div className="h-5 w-3/4 rounded bg-muted" />
        <div className="h-3 w-1/2 rounded bg-muted" />
        <div className="mt-3 flex gap-2">
          <div className="h-3 w-12 rounded bg-muted" />
          <div className="h-3 w-12 rounded bg-muted" />
        </div>
      </div>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <SalonCardSkeleton key={i} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ search }: { search: string }) {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center text-center">
      <div className="rounded-full bg-muted p-4">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          className="h-8 w-8 text-muted-foreground"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
        </svg>
      </div>
      <h3 className="mt-4 text-lg font-semibold">No salons found</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {search
          ? `No results for "${search}". Try a different search term.`
          : "No salons are available in this category yet."}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Star rating display
// ---------------------------------------------------------------------------

function Stars({ rating, count }: { rating: number; count: number }) {
  return (
    <span className="inline-flex items-center gap-1 text-sm">
      <span className="text-yellow-500">★</span>
      <span className="font-medium">{rating.toFixed(1)}</span>
      <span className="text-muted-foreground">({count})</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function BrowseSalons() {
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("All");
  const [page, setPage] = useState(1);

  const filters = useMemo(
    () => ({
      search: search || undefined,
      categories: selectedCategory !== "All" ? [selectedCategory] : undefined,
      page,
      limit: 12,
    }),
    [search, selectedCategory, page],
  );

  const { data, isLoading } = useMarketplaceSalons(filters);
  const salons = data?.storefronts ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / 12);

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-4 py-10">
      {/* ── Header ──────────────────────────────────────────── */}
      <div className="text-center">
        <h1 className="text-3xl font-bold sm:text-4xl">Find Your Perfect Salon</h1>
        <p className="mt-2 text-muted-foreground">
          Browse top-rated salons and book your next appointment.
        </p>
      </div>

      {/* ── Search bar ──────────────────────────────────────── */}
      <div className="mx-auto max-w-lg">
        <div className="relative">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          >
            <path
              fillRule="evenodd"
              d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z"
              clipRule="evenodd"
            />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search salons by name, tag, or headline…"
            className="w-full rounded-lg border bg-background py-2.5 pl-10 pr-4 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </div>

      {/* ── Category pills ──────────────────────────────────── */}
      <div className="flex flex-wrap justify-center gap-2">
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => {
              setSelectedCategory(cat);
              setPage(1);
            }}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              selectedCategory === cat
                ? "bg-primary text-primary-foreground"
                : "bg-accent text-accent-foreground hover:bg-accent/80"
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* ── Grid ────────────────────────────────────────────── */}
      {isLoading ? (
        <SkeletonGrid />
      ) : salons.length === 0 ? (
        <EmptyState search={search} />
      ) : (
        <>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {salons.map((salon) => (
              <Link
                key={salon.id}
                to={`/salon/${salon.slug}`}
                className="group overflow-hidden rounded-xl border bg-card shadow-sm transition-shadow hover:shadow-md"
              >
                {/* Cover */}
                {salon.cover_image_url ? (
                  <img
                    src={salon.cover_image_url}
                    alt={salon.title}
                    className="h-40 w-full object-cover transition-transform group-hover:scale-105"
                  />
                ) : (
                  <div className="h-40 bg-gradient-to-br from-primary/10 to-primary/5" />
                )}

                <div className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {salon.logo_url && (
                        <img
                          src={salon.logo_url}
                          alt=""
                          className="h-8 w-8 rounded-full border object-cover"
                        />
                      )}
                      <h3 className="font-semibold group-hover:text-primary">
                        {salon.title}
                      </h3>
                    </div>
                    {salon.review_count > 0 && (
                      <Stars rating={salon.avg_rating} count={salon.review_count} />
                    )}
                  </div>

                  {salon.tagline && (
                    <p className="mt-1 line-clamp-1 text-sm text-muted-foreground">
                      {salon.tagline}
                    </p>
                  )}

                  {salon.city && (
                    <p className="mt-1 text-xs text-muted-foreground">📍 {salon.city}</p>
                  )}

                  {/* Services preview */}
                  {salon.services_preview.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {salon.services_preview.map((svc) => (
                        <span
                          key={svc.id}
                          className="inline-flex items-center rounded-md bg-accent px-2 py-0.5 text-xs"
                        >
                          {svc.name}{" "}
                          <span className="ml-1 font-medium text-primary">
                            {formatAmount(svc.price, "EUR")}
                          </span>
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Category tags */}
                  {salon.marketplace_categories.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {salon.marketplace_categories.map((cat) => (
                        <span
                          key={cat}
                          className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
                        >
                          {cat}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </Link>
            ))}
          </div>

          {/* ── Pagination ────────────────────────────────────── */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
              >
                Previous
              </button>
              <span className="text-sm text-muted-foreground">
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                className="rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
