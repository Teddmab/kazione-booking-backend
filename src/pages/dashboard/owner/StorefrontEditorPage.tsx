import { useState, useCallback, useRef, type ChangeEvent, type DragEvent } from "react";
import { useAuth, useTenant } from "../../../hooks/useAuth";
import {
  useOwnerStorefront,
  useUpdateStorefront,
  useUploadLogo,
  useUploadCover,
  useUploadGalleryImage,
  useDeleteGalleryImage,
  useReorderGallery,
  usePublishStorefront,
} from "../../../hooks/useOwnerStorefront";
import type { UpdateStorefrontData, GalleryItem, StorefrontSections } from "../../../types/api";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function SectionHeading({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-4">
      <h3 className="text-lg font-semibold">{title}</h3>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
  );
}

function FieldLabel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}

const INPUT_CLS =
  "w-full rounded-md border bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

// ---------------------------------------------------------------------------
// Editor sections
// ---------------------------------------------------------------------------

const SECTION_KEYS: (keyof StorefrontSections)[] = [
  "hero",
  "about",
  "services",
  "promotions",
  "gallery",
  "team",
  "reviews",
  "booking",
];

const SECTION_LABELS: Record<keyof StorefrontSections, string> = {
  hero: "Hero Banner",
  about: "About",
  services: "Services",
  promotions: "Promotions",
  gallery: "Gallery",
  team: "Team",
  reviews: "Reviews",
  booking: "Booking Widget",
};

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------

const TABS = [
  "overview",
  "branding",
  "about",
  "contact",
  "policies",
  "sections",
  "gallery",
  "seo",
  "marketplace",
] as const;
type TabId = (typeof TABS)[number];

const TAB_LABELS: Record<TabId, string> = {
  overview: "Overview",
  branding: "Branding",
  about: "About",
  contact: "Contact",
  policies: "Policies",
  sections: "Sections",
  gallery: "Gallery",
  seo: "SEO",
  marketplace: "Marketplace",
};

// ---------------------------------------------------------------------------
// StorefrontOverview
// ---------------------------------------------------------------------------

function StorefrontOverview({
  onChange,
  title,
  slug,
  tagline,
}: {
  onChange: (d: UpdateStorefrontData) => void;
  title: string;
  slug: string;
  tagline: string;
}) {
  return (
    <div className="space-y-4">
      <SectionHeading title="Store Identity" description="Basic information about your storefront." />
      <FieldLabel label="Business Name">
        <input
          className={INPUT_CLS}
          value={title}
          onChange={(e) => onChange({ title: e.target.value })}
          placeholder="My Salon"
        />
      </FieldLabel>
      <FieldLabel label="URL Slug">
        <input
          className={INPUT_CLS}
          value={slug}
          onChange={(e) => onChange({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })}
          placeholder="my-salon"
        />
      </FieldLabel>
      <FieldLabel label="Tagline">
        <input
          className={INPUT_CLS}
          value={tagline}
          onChange={(e) => onChange({ tagline: e.target.value })}
          placeholder="Your beauty destination"
        />
      </FieldLabel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HeroBrandingEditor
// ---------------------------------------------------------------------------

function HeroBrandingEditor({
  onChange,
  accentColor,
  logoUrl,
  coverUrl,
  onUploadLogo,
  onUploadCover,
  isUploadingLogo,
  isUploadingCover,
}: {
  onChange: (d: UpdateStorefrontData) => void;
  accentColor: string;
  logoUrl: string | null;
  coverUrl: string | null;
  onUploadLogo: (file: File) => void;
  onUploadCover: (file: File) => void;
  isUploadingLogo: boolean;
  isUploadingCover: boolean;
}) {
  return (
    <div className="space-y-6">
      <SectionHeading title="Branding" description="Logo, cover image, and accent color." />

      {/* Accent color */}
      <FieldLabel label="Accent Color">
        <div className="flex items-center gap-3">
          <input
            type="color"
            value={accentColor}
            onChange={(e) => onChange({ accent_color: e.target.value })}
            className="h-10 w-14 cursor-pointer rounded border"
          />
          <span className="text-sm text-muted-foreground">{accentColor}</span>
        </div>
      </FieldLabel>

      {/* Logo */}
      <div>
        <span className="text-sm font-medium">Logo</span>
        <div className="mt-1 flex items-center gap-4">
          {logoUrl ? (
            <img src={logoUrl} alt="Logo" className="h-16 w-16 rounded-full object-cover border" />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-full border bg-muted text-xs text-muted-foreground">
              No logo
            </div>
          )}
          <label className="cursor-pointer rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent">
            {isUploadingLogo ? "Uploading…" : "Upload Logo"}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              disabled={isUploadingLogo}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const f = e.target.files?.[0];
                if (f) onUploadLogo(f);
              }}
            />
          </label>
        </div>
      </div>

      {/* Cover */}
      <div>
        <span className="text-sm font-medium">Cover Image</span>
        <div className="relative mt-1">
          {coverUrl ? (
            <img src={coverUrl} alt="Cover" className="h-40 w-full rounded-lg object-cover" />
          ) : (
            <div className="flex h-40 w-full items-center justify-center rounded-lg border-2 border-dashed bg-muted text-muted-foreground">
              No cover image
            </div>
          )}
          <label className="absolute bottom-2 right-2 cursor-pointer rounded-md bg-background/80 px-3 py-1.5 text-sm font-medium backdrop-blur hover:bg-accent">
            {isUploadingCover ? "Uploading…" : "Change Cover"}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              disabled={isUploadingCover}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const f = e.target.files?.[0];
                if (f) onUploadCover(f);
              }}
            />
          </label>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AboutEditor
// ---------------------------------------------------------------------------

function AboutEditor({
  onChange,
  description,
  extendedDescription,
}: {
  onChange: (d: UpdateStorefrontData) => void;
  description: string;
  extendedDescription: string;
}) {
  return (
    <div className="space-y-4">
      <SectionHeading title="About Your Business" description="Tell clients what makes you special." />
      <FieldLabel label="Short Description">
        <textarea
          className={`${INPUT_CLS} min-h-[80px]`}
          value={description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="A short introduction…"
          rows={3}
        />
      </FieldLabel>
      <FieldLabel label="Extended Description">
        <textarea
          className={`${INPUT_CLS} min-h-[150px]`}
          value={extendedDescription}
          onChange={(e) => onChange({ extended_description: e.target.value })}
          placeholder="Detailed description about your business, history, values…"
          rows={6}
        />
      </FieldLabel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ContactEditor
// ---------------------------------------------------------------------------

function ContactEditor({
  onChange,
  address,
  city,
  countryCode,
  phone,
  email,
  website,
}: {
  onChange: (d: UpdateStorefrontData) => void;
  address: string;
  city: string;
  countryCode: string;
  phone: string;
  email: string;
  website: string;
}) {
  return (
    <div className="space-y-4">
      <SectionHeading title="Contact Information" />
      <div className="grid gap-4 sm:grid-cols-2">
        <FieldLabel label="Address">
          <input className={INPUT_CLS} value={address} onChange={(e) => onChange({ address: e.target.value })} />
        </FieldLabel>
        <FieldLabel label="City">
          <input className={INPUT_CLS} value={city} onChange={(e) => onChange({ city: e.target.value })} />
        </FieldLabel>
        <FieldLabel label="Country Code">
          <input className={INPUT_CLS} value={countryCode} onChange={(e) => onChange({ country_code: e.target.value })} maxLength={2} />
        </FieldLabel>
        <FieldLabel label="Phone">
          <input className={INPUT_CLS} value={phone} onChange={(e) => onChange({ phone: e.target.value })} type="tel" />
        </FieldLabel>
        <FieldLabel label="Email">
          <input className={INPUT_CLS} value={email} onChange={(e) => onChange({ email: e.target.value })} type="email" />
        </FieldLabel>
        <FieldLabel label="Website">
          <input className={INPUT_CLS} value={website} onChange={(e) => onChange({ website: e.target.value })} type="url" placeholder="https://" />
        </FieldLabel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PoliciesEditor
// ---------------------------------------------------------------------------

function PoliciesEditor({
  onChange,
  bookingPolicy,
  cancellationPolicy,
}: {
  onChange: (d: UpdateStorefrontData) => void;
  bookingPolicy: string;
  cancellationPolicy: string;
}) {
  return (
    <div className="space-y-4">
      <SectionHeading title="Policies" description="Displayed on your public storefront." />
      <FieldLabel label="Booking Policy">
        <textarea
          className={`${INPUT_CLS} min-h-[100px]`}
          value={bookingPolicy}
          onChange={(e) => onChange({ booking_policy: e.target.value })}
          rows={4}
        />
      </FieldLabel>
      <FieldLabel label="Cancellation Policy">
        <textarea
          className={`${INPUT_CLS} min-h-[100px]`}
          value={cancellationPolicy}
          onChange={(e) => onChange({ cancellation_policy: e.target.value })}
          rows={4}
        />
      </FieldLabel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SectionsToggle
// ---------------------------------------------------------------------------

function SectionsToggle({
  onChange,
  sections,
}: {
  onChange: (d: UpdateStorefrontData) => void;
  sections: StorefrontSections;
}) {
  const toggle = (key: keyof StorefrontSections) => {
    onChange({ sections: { ...sections, [key]: !sections[key] } });
  };

  return (
    <div className="space-y-4">
      <SectionHeading title="Section Visibility" description="Choose which sections appear on your storefront." />
      <div className="divide-y rounded-lg border">
        {SECTION_KEYS.map((key) => (
          <label key={key} className="flex cursor-pointer items-center justify-between px-4 py-3 hover:bg-accent/50">
            <span className="text-sm font-medium">{SECTION_LABELS[key]}</span>
            <input
              type="checkbox"
              checked={sections[key]}
              onChange={() => toggle(key)}
              className="h-4 w-4 rounded border-gray-300"
            />
          </label>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GalleryEditor
// ---------------------------------------------------------------------------

function GalleryEditor({
  storefrontId,
  gallery,
  onUpload,
  onDelete,
  onReorder,
  isUploading,
}: {
  storefrontId: string;
  gallery: GalleryItem[];
  onUpload: (args: { storefrontId: string; file: File }) => void;
  onDelete: (args: { galleryId: string; imageUrl: string }) => void;
  onReorder: (args: { storefrontId: string; orderedIds: string[] }) => void;
  isUploading: boolean;
}) {
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const dragItem = useRef<number | null>(null);

  const sorted = [...gallery].sort((a, b) => a.display_order - b.display_order);

  const handleDrop = useCallback(
    (e: DragEvent, targetIdx: number) => {
      e.preventDefault();
      setDragOverIdx(null);
      if (dragItem.current === null || dragItem.current === targetIdx) return;

      const reordered = [...sorted];
      const [moved] = reordered.splice(dragItem.current, 1);
      reordered.splice(targetIdx, 0, moved);
      onReorder({ storefrontId, orderedIds: reordered.map((g) => g.id) });
      dragItem.current = null;
    },
    [sorted, storefrontId, onReorder],
  );

  return (
    <div className="space-y-4">
      <SectionHeading title="Gallery" description="Drag to reorder. Drop images to upload." />

      {/* Upload area */}
      <label
        className="flex cursor-pointer items-center justify-center rounded-lg border-2 border-dashed p-8 text-sm text-muted-foreground hover:border-primary hover:text-primary"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const file = e.dataTransfer.files[0];
          if (file?.type.startsWith("image/")) onUpload({ storefrontId, file });
        }}
      >
        {isUploading ? "Uploading…" : "Click or drop an image to add to gallery"}
        <input
          type="file"
          accept="image/*"
          className="hidden"
          disabled={isUploading}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            const f = e.target.files?.[0];
            if (f) onUpload({ storefrontId, file: f });
          }}
        />
      </label>

      {/* Gallery grid */}
      {sorted.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {sorted.map((img, idx) => (
            <div
              key={img.id}
              draggable
              onDragStart={() => {
                dragItem.current = idx;
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverIdx(idx);
              }}
              onDragLeave={() => setDragOverIdx(null)}
              onDrop={(e) => handleDrop(e, idx)}
              className={`group relative overflow-hidden rounded-lg border ${
                dragOverIdx === idx ? "ring-2 ring-primary" : ""
              }`}
            >
              <img src={img.image_url} alt={img.caption ?? ""} className="h-32 w-full object-cover" />
              <button
                type="button"
                onClick={() => onDelete({ galleryId: img.id, imageUrl: img.image_url })}
                className="absolute right-1 top-1 rounded-full bg-destructive/80 p-1.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
                aria-label="Delete image"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                  <path
                    fillRule="evenodd"
                    d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
              <div className="absolute bottom-0 left-0 right-0 bg-black/50 px-2 py-1 text-xs text-white">
                #{idx + 1}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SEOEditor
// ---------------------------------------------------------------------------

function SEOEditor({
  onChange,
  seoTitle,
  seoDescription,
}: {
  onChange: (d: UpdateStorefrontData) => void;
  seoTitle: string;
  seoDescription: string;
}) {
  return (
    <div className="space-y-4">
      <SectionHeading title="SEO" description="Optimize your storefront for search engines." />
      <FieldLabel label="SEO Title">
        <input
          className={INPUT_CLS}
          value={seoTitle}
          onChange={(e) => onChange({ seo_title: e.target.value })}
          placeholder="Page title for search engines"
          maxLength={70}
        />
        <p className="mt-0.5 text-xs text-muted-foreground">{seoTitle.length}/70</p>
      </FieldLabel>
      <FieldLabel label="SEO Description">
        <textarea
          className={`${INPUT_CLS} min-h-[80px]`}
          value={seoDescription}
          onChange={(e) => onChange({ seo_description: e.target.value })}
          placeholder="Meta description for search results"
          maxLength={160}
          rows={3}
        />
        <p className="mt-0.5 text-xs text-muted-foreground">{seoDescription.length}/160</p>
      </FieldLabel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MarketplaceEditor
// ---------------------------------------------------------------------------

function MarketplaceEditor({
  onChange,
  headline,
  tags,
  categories,
}: {
  onChange: (d: UpdateStorefrontData) => void;
  headline: string;
  tags: string[];
  categories: string[];
}) {
  const [tagInput, setTagInput] = useState("");

  const addTag = () => {
    const value = tagInput.trim();
    if (value && !tags.includes(value)) {
      onChange({ marketplace_tags: [...tags, value] });
    }
    setTagInput("");
  };

  return (
    <div className="space-y-4">
      <SectionHeading title="Marketplace Listing" description="How your salon appears in the marketplace." />

      <FieldLabel label="Headline">
        <input
          className={INPUT_CLS}
          value={headline}
          onChange={(e) => onChange({ marketplace_headline: e.target.value })}
          placeholder="Premium Salon in City Center"
        />
      </FieldLabel>

      <FieldLabel label="Categories">
        <input
          className={INPUT_CLS}
          value={categories.join(", ")}
          onChange={(e) =>
            onChange({
              marketplace_categories: e.target.value
                .split(",")
                .map((c) => c.trim())
                .filter(Boolean),
            })
          }
          placeholder="Hair, Nails, Spa (comma-separated)"
        />
      </FieldLabel>

      <div>
        <span className="text-sm font-medium">Tags</span>
        <div className="mt-1 flex flex-wrap gap-2">
          {tags.map((tag) => (
            <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-accent px-2.5 py-0.5 text-xs font-medium">
              {tag}
              <button
                type="button"
                onClick={() => onChange({ marketplace_tags: tags.filter((t) => t !== tag) })}
                className="ml-0.5 text-muted-foreground hover:text-foreground"
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <input
            className={INPUT_CLS}
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTag();
              }
            }}
            placeholder="Add a tag…"
          />
          <button
            type="button"
            onClick={addTag}
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function EditorSkeleton() {
  return (
    <div className="animate-pulse space-y-6 p-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-9 w-24" />
      </div>
      <div className="flex gap-2">
        {TABS.map((t) => (
          <Skeleton key={t} className="h-8 w-20" />
        ))}
      </div>
      <div className="space-y-4">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-2/3" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function StorefrontEditorPage() {
  const { user } = useAuth();
  const { data: tenant } = useTenant(user?.id);
  const { data: storefront, isLoading } = useOwnerStorefront();
  const { debouncedMutate, isPending: isSaving } = useUpdateStorefront();
  const uploadLogo = useUploadLogo();
  const uploadCover = useUploadCover();
  const uploadGallery = useUploadGalleryImage();
  const deleteGallery = useDeleteGalleryImage();
  const reorderGallery = useReorderGallery();
  const publishMutation = usePublishStorefront();

  const [activeTab, setActiveTab] = useState<TabId>("overview");

  const handleChange = useCallback(
    (partial: UpdateStorefrontData) => {
      debouncedMutate(partial);
    },
    [debouncedMutate],
  );

  if (isLoading) return <EditorSkeleton />;

  // Storefront not yet created — show empty state
  if (!storefront) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
        <h2 className="text-2xl font-bold">No Storefront Yet</h2>
        <p className="mt-2 text-muted-foreground">
          Create your public storefront to start attracting clients.
        </p>
        <button
          type="button"
          onClick={() =>
            debouncedMutate({
              title: tenant?.businessName ?? "My Salon",
              slug: (tenant?.businessName ?? "my-salon").toLowerCase().replace(/[^a-z0-9]+/g, "-"),
            })
          }
          className="mt-6 rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Create Storefront
        </button>
      </div>
    );
  }

  const sf = storefront;
  const isPublished = sf.is_published;

  // Derive gallery from the storefront query (we fetch separately via the storefront relation)
  // For now rely on separate gallery fetch — or store inline if the owner storefront query joins it
  const gallery: GalleryItem[] = [];

  return (
    <div className="space-y-6">
      {/* ── Header ──────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Storefront Editor</h1>
          <p className="text-sm text-muted-foreground">
            Edit your public storefront. Changes are saved automatically.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {isSaving && <span className="text-xs text-muted-foreground">Saving…</span>}
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
              isPublished ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"
            }`}
          >
            {isPublished ? "Published" : "Draft"}
          </span>
          <button
            type="button"
            disabled={publishMutation.isPending}
            onClick={() => publishMutation.mutate(!isPublished)}
            className={`rounded-md px-4 py-2 text-sm font-medium ${
              isPublished
                ? "border hover:bg-accent"
                : "bg-primary text-primary-foreground hover:bg-primary/90"
            }`}
          >
            {publishMutation.isPending
              ? "Updating…"
              : isPublished
                ? "Unpublish"
                : "Publish"}
          </button>
        </div>
      </div>

      {/* ── Tabs ────────────────────────────────────────────── */}
      <div className="flex gap-1 overflow-x-auto border-b">
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === tab
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground"
            }`}
          >
            {TAB_LABELS[tab]}
          </button>
        ))}
      </div>

      {/* ── Tab content ─────────────────────────────────────── */}
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        {activeTab === "overview" && (
          <StorefrontOverview
            onChange={handleChange}
            title={sf.title}
            slug={sf.slug}
            tagline={sf.tagline ?? ""}
          />
        )}

        {activeTab === "branding" && (
          <HeroBrandingEditor
            onChange={handleChange}
            accentColor={sf.accent_color}
            logoUrl={sf.logo_url}
            coverUrl={sf.cover_image_url}
            onUploadLogo={(file) => uploadLogo.mutate(file)}
            onUploadCover={(file) => uploadCover.mutate(file)}
            isUploadingLogo={uploadLogo.isPending}
            isUploadingCover={uploadCover.isPending}
          />
        )}

        {activeTab === "about" && (
          <AboutEditor
            onChange={handleChange}
            description={sf.description ?? ""}
            extendedDescription={sf.extended_description ?? ""}
          />
        )}

        {activeTab === "contact" && (
          <ContactEditor
            onChange={handleChange}
            address={sf.address ?? ""}
            city={sf.city ?? ""}
            countryCode={sf.country_code ?? ""}
            phone={sf.phone ?? ""}
            email={sf.email ?? ""}
            website={sf.website ?? ""}
          />
        )}

        {activeTab === "policies" && (
          <PoliciesEditor
            onChange={handleChange}
            bookingPolicy={sf.booking_policy ?? ""}
            cancellationPolicy={sf.cancellation_policy ?? ""}
          />
        )}

        {activeTab === "sections" && (
          <SectionsToggle onChange={handleChange} sections={sf.sections} />
        )}

        {activeTab === "gallery" && (
          <GalleryEditor
            storefrontId={sf.id}
            gallery={gallery}
            onUpload={(args) => uploadGallery.mutate(args)}
            onDelete={(args) => deleteGallery.mutate(args)}
            onReorder={(args) => reorderGallery.mutate(args)}
            isUploading={uploadGallery.isPending}
          />
        )}

        {activeTab === "seo" && (
          <SEOEditor
            onChange={handleChange}
            seoTitle={sf.seo_title ?? ""}
            seoDescription={sf.seo_description ?? ""}
          />
        )}

        {activeTab === "marketplace" && (
          <MarketplaceEditor
            onChange={handleChange}
            headline={sf.marketplace_headline ?? ""}
            tags={sf.marketplace_tags ?? []}
            categories={sf.marketplace_categories ?? []}
          />
        )}
      </div>
    </div>
  );
}
