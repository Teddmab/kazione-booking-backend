import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, notFound, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";

// ---------------------------------------------------------------------------
// StorefrontData interfaces — mirrors frontend src/data/storefrontData.ts
// ---------------------------------------------------------------------------

interface StorefrontService {
  id: string;
  name: string;
  category: string;
  categoryId: string | null;
  description: string;
  duration: string;
  durationMin: number;
  price: number;
  currency: string;
  popular: boolean;
  imageUrl: string | null;
  displayOrder: number;
}

interface StaffMember {
  id: string;
  name: string;
  role: string;
  bio: string;
  avatar: string | null;
  specialties: string[];
  serviceIds: string[];
}

interface Promotion {
  id: string;
  title: string;
  description: string;
  discountType: string;
  discountValue: number;
  badge: string | null;
  validFrom: string | null;
  validUntil: string | null;
  appliesTo: string[];
}

interface GalleryImage {
  id: string;
  imageUrl: string;
  caption: string | null;
  displayOrder: number;
}

interface Review {
  id: string;
  rating: number;
  comment: string | null;
  ownerReply: string | null;
  repliedAt: string | null;
  clientName: string;
  clientAvatar: string | null;
  createdAt: string;
}

interface StorefrontContact {
  address: string | null;
  city: string | null;
  countryCode: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
}

interface StorefrontSections {
  hero: boolean;
  about: boolean;
  services: boolean;
  promotions: boolean;
  gallery: boolean;
  team: boolean;
  reviews: boolean;
  booking: boolean;
}

interface StorefrontData {
  id: string;
  businessId: string;
  slug: string;
  name: string;
  tagline: string | null;
  description: string | null;
  extendedDescription: string | null;
  logoUrl: string | null;
  coverImageUrl: string | null;
  accentColor: string;
  verified: boolean;
  currencyCode: string;
  countryCode: string | null;

  // Marketplace
  headline: string | null;
  tags: string[];
  categories: string[];
  featured: boolean;

  // Policies
  bookingPolicy: string | null;
  cancellationPolicy: string | null;

  // Sections
  sections: StorefrontSections;

  // SEO
  seoTitle: string | null;
  seoDescription: string | null;

  // Aggregates
  rating: number;
  reviewCount: number;

  // Nested
  contact: StorefrontContact;
  services: StorefrontService[];
  team: StaffMember[];
  promotions: Promotion[];
  gallery: GalleryImage[];
  reviews: Review[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse first language code from Accept-Language header, default "en". */
function parseLocale(req: Request): string {
  const header = req.headers.get("Accept-Language");
  if (!header) return "en";
  // e.g. "et-EE,et;q=0.9,en;q=0.8" → "et"
  const first = header.split(",")[0]?.split(";")[0]?.trim();
  if (!first) return "en";
  const code = first.split("-")[0]?.toLowerCase();
  return code || "en";
}

/** Format minutes to human-readable duration string like "3 hrs" or "1.5 hrs". */
function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hrs = minutes / 60;
  if (Number.isInteger(hrs)) return `${hrs} hrs`;
  return `${hrs.toFixed(1)} hrs`;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(withLogging("get-storefront", async (req: Request) => {
  // CORS preflight
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  if (req.method !== "GET") {
    return badRequest("Only GET is allowed");
  }

  try {
    // 1. Parse slug
    const url = new URL(req.url);
    const slug = url.searchParams.get("slug");
    if (!slug) return badRequest("Missing required query parameter: slug");

    // 2. Parse locale
    const locale = parseLocale(req);

    // 3. Fetch storefront
    const { data: storefront, error: sfErr } = await supabaseAdmin
      .from("storefronts")
      .select("*")
      .eq("slug", slug)
      .eq("is_published", true)
      .maybeSingle();

    if (sfErr) throw sfErr;
    if (!storefront) return notFound("Storefront not found");

    const businessId: string = storefront.business_id;
    const storefrontId: string = storefront.id;

    // 5. Parallel fetches
    const [
      businessResult,
      servicesResult,
      staffResult,
      promotionsResult,
      reviewsResult,
      reviewAggResult,
      galleryResult,
    ] = await Promise.all([
      // Business
      supabaseAdmin
        .from("businesses")
        .select("name, currency_code")
        .eq("id", businessId)
        .single(),

      // Services (active + public) with translations for locale
      supabaseAdmin
        .from("services")
        .select(`
          id, name, description, duration_minutes, price, currency_code,
          is_active, is_public, image_url, display_order,
          category_id,
          service_categories ( name ),
          service_translations ( locale, field, value )
        `)
        .eq("business_id", businessId)
        .eq("is_active", true)
        .eq("is_public", true)
        .order("display_order", { ascending: true }),

      // Staff with services they perform
      supabaseAdmin
        .from("staff_profiles")
        .select(`
          id, display_name, bio, avatar_url, specialties, is_active,
          staff_services ( service_id )
        `)
        .eq("business_id", businessId)
        .eq("is_active", true),

      // Promotions (active, not expired)
      supabaseAdmin
        .from("promotions")
        .select("*")
        .eq("business_id", businessId)
        .eq("is_active", true)
        .or("valid_until.is.null,valid_until.gte." + new Date().toISOString().slice(0, 10)),

      // Reviews (public, newest 10) with client info
      supabaseAdmin
        .from("reviews")
        .select(`
          id, rating, comment, owner_reply, replied_at, created_at,
          clients ( first_name, last_name, avatar_url )
        `)
        .eq("business_id", businessId)
        .eq("is_public", true)
        .order("created_at", { ascending: false })
        .limit(10),

      // Review aggregate
      supabaseAdmin.rpc("get_review_aggregate_for_storefront", {
        p_business_id: businessId,
      }).maybeSingle(),

      // Gallery
      supabaseAdmin
        .from("storefront_gallery")
        .select("id, image_url, caption, display_order")
        .eq("storefront_id", storefrontId)
        .order("display_order", { ascending: true }),
    ]);

    if (businessResult.error) throw businessResult.error;
    if (servicesResult.error) throw servicesResult.error;
    if (staffResult.error) throw staffResult.error;
    if (promotionsResult.error) throw promotionsResult.error;
    if (reviewsResult.error) throw reviewsResult.error;
    if (galleryResult.error) throw galleryResult.error;

    const business = businessResult.data;

    // ── Review aggregate fallback (if RPC doesn't exist, compute inline) ──
    let rating = 0;
    let reviewCount = 0;
    if (reviewAggResult.error || !reviewAggResult.data) {
      // Fallback: compute from fetched reviews list (or re-query)
      const { data: aggRows } = await supabaseAdmin
        .from("reviews")
        .select("rating")
        .eq("business_id", businessId)
        .eq("is_public", true);
      if (aggRows && aggRows.length > 0) {
        reviewCount = aggRows.length;
        rating = +(
          aggRows.reduce((sum: number, r: { rating: number }) => sum + r.rating, 0) /
          reviewCount
        ).toFixed(1);
      }
    } else {
      rating = +(reviewAggResult.data.avg_rating ?? 0);
      reviewCount = +(reviewAggResult.data.review_count ?? 0);
    }

    // ── Map services with translations ────────────────────────────────────
    const services: StorefrontService[] = (servicesResult.data ?? []).map(
      (svc: Record<string, unknown>) => {
        let name = svc.name as string;
        let description = (svc.description ?? "") as string;

        // Apply locale translations if available
        const translations = (svc.service_translations ?? []) as Array<{
          locale: string;
          field: string;
          value: string;
        }>;
        for (const t of translations) {
          if (t.locale === locale) {
            if (t.field === "name") name = t.value;
            if (t.field === "description") description = t.value;
          }
        }

        const durationMin = svc.duration_minutes as number;
        const cat = svc.service_categories as { name: string } | null;

        return {
          id: svc.id as string,
          name,
          category: cat?.name ?? "",
          categoryId: (svc.category_id as string) ?? null,
          description,
          duration: formatDuration(durationMin),
          durationMin,
          price: +(svc.price as number),
          currency: (svc.currency_code as string) ?? business.currency_code,
          popular: (svc.display_order as number) === 0,
          imageUrl: (svc.image_url as string) ?? null,
          displayOrder: svc.display_order as number,
        };
      },
    );

    // ── Map staff ─────────────────────────────────────────────────────────
    const team: StaffMember[] = (staffResult.data ?? []).map(
      (s: Record<string, unknown>) => {
        const staffServices = (s.staff_services ?? []) as Array<{
          service_id: string;
        }>;
        return {
          id: s.id as string,
          name: s.display_name as string,
          role: "Stylist",
          bio: (s.bio ?? "") as string,
          avatar: (s.avatar_url as string) ?? null,
          specialties: (s.specialties ?? []) as string[],
          serviceIds: staffServices.map((ss) => ss.service_id),
        };
      },
    );

    // ── Map promotions ────────────────────────────────────────────────────
    const promotions: Promotion[] = (promotionsResult.data ?? []).map(
      (p: Record<string, unknown>) => ({
        id: p.id as string,
        title: p.title as string,
        description: (p.description ?? "") as string,
        discountType: p.discount_type as string,
        discountValue: +(p.discount_value as number),
        badge: (p.badge as string) ?? null,
        validFrom: (p.valid_from as string) ?? null,
        validUntil: (p.valid_until as string) ?? null,
        appliesTo: (p.applies_to ?? []) as string[],
      }),
    );

    // ── Map gallery ───────────────────────────────────────────────────────
    const gallery: GalleryImage[] = (galleryResult.data ?? []).map(
      (g: Record<string, unknown>) => ({
        id: g.id as string,
        imageUrl: g.image_url as string,
        caption: (g.caption as string) ?? null,
        displayOrder: g.display_order as number,
      }),
    );

    // ── Map reviews ───────────────────────────────────────────────────────
    const reviews: Review[] = (reviewsResult.data ?? []).map(
      (r: Record<string, unknown>) => {
        const client = r.clients as {
          first_name: string;
          last_name: string;
          avatar_url: string | null;
        } | null;
        return {
          id: r.id as string,
          rating: r.rating as number,
          comment: (r.comment as string) ?? null,
          ownerReply: (r.owner_reply as string) ?? null,
          repliedAt: (r.replied_at as string) ?? null,
          clientName: client
            ? `${client.first_name} ${client.last_name.charAt(0)}.`
            : "Anonymous",
          clientAvatar: client?.avatar_url ?? null,
          createdAt: r.created_at as string,
        };
      },
    );

    // ── Build sections ────────────────────────────────────────────────────
    const defaultSections: StorefrontSections = {
      hero: true,
      about: true,
      services: true,
      promotions: true,
      gallery: true,
      team: true,
      reviews: false,
      booking: true,
    };
    const sections: StorefrontSections = {
      ...defaultSections,
      ...((storefront.sections as Partial<StorefrontSections>) ?? {}),
    };

    // ── Assemble response ─────────────────────────────────────────────────
    const response: StorefrontData = {
      id: storefront.id,
      businessId: storefront.business_id,
      slug: storefront.slug,
      name: storefront.title ?? business.name,
      tagline: storefront.tagline ?? null,
      description: storefront.description ?? null,
      extendedDescription: storefront.extended_description ?? null,
      logoUrl: storefront.logo_url ?? null,
      coverImageUrl: storefront.cover_image_url ?? null,
      accentColor: storefront.accent_color ?? "#C9873E",
      verified: storefront.marketplace_featured ?? false,
      currencyCode: business.currency_code ?? "EUR",
      countryCode: storefront.country_code ?? null,

      // Marketplace
      headline: storefront.marketplace_headline ?? null,
      tags: storefront.marketplace_tags ?? [],
      categories: storefront.marketplace_categories ?? [],
      featured: storefront.marketplace_featured ?? false,

      // Policies
      bookingPolicy: storefront.booking_policy ?? null,
      cancellationPolicy: storefront.cancellation_policy ?? null,

      // Sections
      sections,

      // SEO
      seoTitle: storefront.seo_title ?? null,
      seoDescription: storefront.seo_description ?? null,

      // Aggregates
      rating,
      reviewCount,

      // Nested
      contact: {
        address: storefront.address ?? null,
        city: storefront.city ?? null,
        countryCode: storefront.country_code ?? null,
        phone: storefront.phone ?? null,
        email: storefront.email ?? null,
        website: storefront.website ?? null,
      },
      services,
      team,
      promotions,
      gallery,
      reviews,
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60",
      },
    });
  } catch (err) {
    console.error("get-storefront error:", err);
    return serverError("Failed to load storefront");
  }
}));
