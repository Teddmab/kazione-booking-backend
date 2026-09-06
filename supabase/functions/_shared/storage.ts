// Shared storage helpers, mirroring the equivalent local copies already in
// debts/index.ts and finance/index.ts (kept local there to avoid touching
// working, unrelated code) — new consumers should import from here instead
// of adding a third copy.

export function extFromMime(mime: string | null | undefined): string {
  if (!mime) return "bin";
  if (mime.includes("pdf")) return "pdf";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("heic")) return "heic";
  return "jpg";
}

/** Local Supabase (Docker/kong) signs storage URLs with an internal hostname
 *  the browser can't reach — rewrite to 127.0.0.1 outside of production. */
export function rewriteLocalUrl(u: string): string {
  const internalUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const isLocal = internalUrl.includes("kong") || internalUrl.includes("supabase_");
  if (!isLocal) return u;
  return u.replace(/^https?:\/\/[^/]+(?=\/storage\/)/, "http://127.0.0.1:54321");
}
