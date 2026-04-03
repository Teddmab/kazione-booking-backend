import { supabase } from "../lib/supabase";
import { NetworkError } from "../types/api";
import type {
  GalleryItem,
  PaginatedStorefronts,
  PublicStorefrontListing,
  StorefrontRow,
  UpdateStorefrontData,
} from "../types/api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_IMAGE_DIMENSION = 1200;
const LOGO_DIMENSION = 400;

async function resizeToWebp(
  file: File,
  maxDim: number,
): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  return canvas.convertToBlob({ type: "image/webp", quality: 0.82 });
}

// ---------------------------------------------------------------------------
// getOwnerStorefront — full record (no is_published filter)
// ---------------------------------------------------------------------------

export async function getOwnerStorefront(
  businessId: string,
): Promise<StorefrontRow | null> {
  const { data, error } = await supabase
    .from("storefronts")
    .select("*")
    .eq("business_id", businessId)
    .maybeSingle();

  if (error) throw new NetworkError(error.message, 500);
  return data as StorefrontRow | null;
}

// ---------------------------------------------------------------------------
// updateStorefront — UPSERT on business_id
// ---------------------------------------------------------------------------

export async function updateStorefront(
  businessId: string,
  updates: UpdateStorefrontData,
): Promise<StorefrontRow> {
  const { data, error } = await supabase
    .from("storefronts")
    .upsert(
      { business_id: businessId, ...updates, updated_at: new Date().toISOString() },
      { onConflict: "business_id" },
    )
    .select("*")
    .single();

  if (error) throw new NetworkError(error.message, 500);
  return data as StorefrontRow;
}

// ---------------------------------------------------------------------------
// uploadLogo — resize to webp, upload, update storefronts.logo_url
// ---------------------------------------------------------------------------

export async function uploadLogo(
  businessId: string,
  file: File,
): Promise<string> {
  const blob = await resizeToWebp(file, LOGO_DIMENSION);
  const path = `${businessId}/logo.webp`;

  const { error: uploadErr } = await supabase.storage
    .from("business-assets")
    .upload(path, blob, { contentType: "image/webp", upsert: true });
  if (uploadErr) throw new NetworkError(uploadErr.message, 500);

  const { data: urlData } = supabase.storage
    .from("business-assets")
    .getPublicUrl(path);
  const publicUrl = urlData.publicUrl;

  await updateStorefront(businessId, { logo_url: publicUrl });
  return publicUrl;
}

// ---------------------------------------------------------------------------
// uploadCover — resize to webp, upload, update storefronts.cover_image_url
// ---------------------------------------------------------------------------

export async function uploadCover(
  businessId: string,
  file: File,
): Promise<string> {
  const blob = await resizeToWebp(file, MAX_IMAGE_DIMENSION);
  const path = `${businessId}/cover.webp`;

  const { error: uploadErr } = await supabase.storage
    .from("business-assets")
    .upload(path, blob, { contentType: "image/webp", upsert: true });
  if (uploadErr) throw new NetworkError(uploadErr.message, 500);

  const { data: urlData } = supabase.storage
    .from("business-assets")
    .getPublicUrl(path);
  const publicUrl = urlData.publicUrl;

  await updateStorefront(businessId, { cover_image_url: publicUrl });
  return publicUrl;
}

// ---------------------------------------------------------------------------
// uploadGalleryImage — upload, INSERT storefront_gallery
// ---------------------------------------------------------------------------

export async function uploadGalleryImage(
  storefrontId: string,
  businessId: string,
  file: File,
): Promise<GalleryItem> {
  const blob = await resizeToWebp(file, MAX_IMAGE_DIMENSION);
  const imageId = crypto.randomUUID();
  const path = `${businessId}/gallery/${imageId}.webp`;

  const { error: uploadErr } = await supabase.storage
    .from("business-assets")
    .upload(path, blob, { contentType: "image/webp" });
  if (uploadErr) throw new NetworkError(uploadErr.message, 500);

  const { data: urlData } = supabase.storage
    .from("business-assets")
    .getPublicUrl(path);

  const { data, error } = await supabase
    .from("storefront_gallery")
    .insert({
      storefront_id: storefrontId,
      image_url: urlData.publicUrl,
      display_order: 0,
    })
    .select("*")
    .single();

  if (error) throw new NetworkError(error.message, 500);
  return data as GalleryItem;
}

// ---------------------------------------------------------------------------
// deleteGalleryImage — DELETE row + remove from Storage
// ---------------------------------------------------------------------------

export async function deleteGalleryImage(
  galleryId: string,
  imageUrl: string,
): Promise<void> {
  // Extract storage path from public URL
  const marker = "/business-assets/";
  const idx = imageUrl.indexOf(marker);
  if (idx !== -1) {
    const storagePath = imageUrl.slice(idx + marker.length);
    await supabase.storage.from("business-assets").remove([storagePath]);
  }

  const { error } = await supabase
    .from("storefront_gallery")
    .delete()
    .eq("id", galleryId);

  if (error) throw new NetworkError(error.message, 500);
}

// ---------------------------------------------------------------------------
// reorderGallery — batch UPDATE display_order
// ---------------------------------------------------------------------------

export async function reorderGallery(
  storefrontId: string,
  orderedIds: string[],
): Promise<void> {
  // Update each item's display_order in sequence
  const updates = orderedIds.map((id, index) =>
    supabase
      .from("storefront_gallery")
      .update({ display_order: index })
      .eq("id", id)
      .eq("storefront_id", storefrontId),
  );

  const results = await Promise.all(updates);
  const failed = results.find((r: { error: unknown }) => r.error);
  if (failed?.error) throw new NetworkError(failed.error.message, 500);
}

// ---------------------------------------------------------------------------
// publishStorefront / unpublishStorefront
// ---------------------------------------------------------------------------

export async function publishStorefront(
  businessId: string,
): Promise<void> {
  const { error } = await supabase
    .from("storefronts")
    .update({
      is_published: true,
      marketplace_status: "active",
      updated_at: new Date().toISOString(),
    })
    .eq("business_id", businessId);

  if (error) throw new NetworkError(error.message, 500);
}

export async function unpublishStorefront(
  businessId: string,
): Promise<void> {
  const { error } = await supabase
    .from("storefronts")
    .update({
      is_published: false,
      marketplace_status: "draft",
      updated_at: new Date().toISOString(),
    })
    .eq("business_id", businessId);

  if (error) throw new NetworkError(error.message, 500);
}

// ---------------------------------------------------------------------------
// getPublicStorefronts — published storefronts with aggregates
// ---------------------------------------------------------------------------

export async function getPublicStorefronts(filters: {
  search?: string;
  categories?: string[];
  city?: string;
  page?: number;
  limit?: number;
} = {}): Promise<PaginatedStorefronts> {
  const { search, categories, city, page = 1, limit = 20 } = filters;

  let query = supabase
    .from("storefronts")
    .select(
      `
      id, business_id, slug, title, tagline, logo_url, cover_image_url,
      city, marketplace_categories, marketplace_tags, marketplace_headline
    `,
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

  const { data: storefronts, error, count } = await query;
  if (error) throw new NetworkError(error.message, 500);

  // Fetch aggregated reviews + services preview for each storefront
  const businessIds = (storefronts ?? []).map((s: any) => s.business_id as string);

  const [reviewsRes, servicesRes] = await Promise.all([
    businessIds.length
      ? supabase
          .from("reviews")
          .select("business_id, rating")
          .in("business_id", businessIds)
          .eq("is_public", true)
      : { data: [] as any[], error: null },
    businessIds.length
      ? supabase
          .from("services")
          .select("id, name, price, business_id")
          .in("business_id", businessIds)
          .eq("is_active", true)
          .order("display_order", { ascending: true })
      : { data: [] as any[], error: null },
  ]);

  // Build review aggregates keyed by business_id
  const reviewAgg = new Map<string, { sum: number; count: number }>();
  for (const r of reviewsRes.data ?? []) {
    const agg = reviewAgg.get(r.business_id) ?? { sum: 0, count: 0 };
    agg.sum += r.rating;
    agg.count += 1;
    reviewAgg.set(r.business_id, agg);
  }

  // Build services preview (max 3 per business)
  const servicesMap = new Map<string, { id: string; name: string; price: number }[]>();
  for (const s of servicesRes.data ?? []) {
    const arr = servicesMap.get(s.business_id) ?? [];
    if (arr.length < 3) arr.push({ id: s.id, name: s.name, price: s.price });
    servicesMap.set(s.business_id, arr);
  }

  const listings: PublicStorefrontListing[] = (storefronts ?? []).map((sf: any) => {
    const ra = reviewAgg.get(sf.business_id);
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
      services_preview: servicesMap.get(sf.business_id) ?? [],
    };
  });

  return { storefronts: listings, total: count ?? 0 };
}
