import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * GET /marketplace-storefronts
 * Public endpoint — no auth required.
 *
 * Query params: search, categories (multi-value), city, page, limit
 * Returns: { storefronts: PublicStorefrontListing[], total: number }
 */
Deno.serve(withLogging("marketplace-storefronts", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  if (req.method !== "GET") {
    return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Only GET is allowed" } }, 405);
  }

  try {
    const url = new URL(req.url);
    const search = url.searchParams.get("search");
    const categories = url.searchParams.getAll("categories");
    const city = url.searchParams.get("city");
    const page = parseInt(url.searchParams.get("page") ?? "1", 10);
    const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);

    // deno-lint-ignore no-explicit-any
    let query: any = supabaseAdmin
      .from("storefronts")
      .select(
        `id, business_id, slug, title, tagline, logo_url, cover_image_url,
         city, marketplace_categories, marketplace_tags, marketplace_headline`,
        { count: "exact" },
      )
      .eq("is_published", true)
      .eq("marketplace_status", "active")
      .order("marketplace_featured", { ascending: false })
      .order("created_at", { ascending: false });

    if (search) {
      query = query.or(
        `title.ilike.%${search}%,marketplace_headline.ilike.%${search}%,marketplace_tags.cs.{${search}}`,
      );
    }
    if (categories?.length) {
      query = query.overlaps("marketplace_categories", categories);
    }
    if (city) {
      query = query.ilike("city", `%${city}%`);
    }

    const from = (page - 1) * limit;
    query = query.range(from, from + limit - 1);

    const { data: storefrontsData, error, count } = await query;
    if (error) return serverError(error.message);

    const businessIds = (storefrontsData ?? []).map((s: Record<string, unknown>) => s.business_id as string);

    const [reviewsRes, servicesRes] = await Promise.all([
      businessIds.length
        ? supabaseAdmin.from("reviews").select("business_id, rating").in("business_id", businessIds).eq("is_public", true)
        : { data: [] as Record<string, unknown>[], error: null },
      businessIds.length
        ? supabaseAdmin.from("services").select("id, name, price, business_id").in("business_id", businessIds).eq("is_active", true).order("display_order", { ascending: true })
        : { data: [] as Record<string, unknown>[], error: null },
    ]);

    const reviewAgg = new Map<string, { sum: number; count: number }>();
    for (const r of reviewsRes.data ?? []) {
      const bid = (r as Record<string, unknown>).business_id as string;
      const agg = reviewAgg.get(bid) ?? { sum: 0, count: 0 };
      agg.sum += (r as Record<string, unknown>).rating as number;
      agg.count += 1;
      reviewAgg.set(bid, agg);
    }

    const servicesMap = new Map<string, { id: string; name: string; price: number }[]>();
    for (const s of servicesRes.data ?? []) {
      const bid = (s as Record<string, unknown>).business_id as string;
      const arr = servicesMap.get(bid) ?? [];
      if (arr.length < 3) arr.push({ id: s.id as string, name: s.name as string, price: s.price as number });
      servicesMap.set(bid, arr);
    }

    const storefronts = (storefrontsData ?? []).map((sf: Record<string, unknown>) => {
      const ra = reviewAgg.get(sf.business_id as string);
      return {
        id: sf.id,
        business_id: sf.business_id,
        slug: sf.slug,
        title: sf.title,
        tagline: sf.tagline,
        logo_url: sf.logo_url,
        cover_image_url: sf.cover_image_url,
        city: sf.city,
        marketplace_categories: sf.marketplace_categories ?? [],
        marketplace_tags: sf.marketplace_tags ?? [],
        marketplace_headline: sf.marketplace_headline,
        avg_rating: ra ? Math.round((ra.sum / ra.count) * 10) / 10 : 0,
        review_count: ra?.count ?? 0,
        services_preview: servicesMap.get(sf.business_id as string) ?? [],
      };
    });

    return new Response(JSON.stringify({ storefronts, total: count ?? 0 }), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60",
      },
    });
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("marketplace-storefronts error:", err);
    return serverError(err instanceof Error ? err.message : "Internal error");
  }
}));
