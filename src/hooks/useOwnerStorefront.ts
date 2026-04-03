import { useCallback, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth, useTenant } from "./useAuth";
import {
  getOwnerStorefront,
  updateStorefront,
  uploadLogo,
  uploadCover,
  uploadGalleryImage,
  deleteGalleryImage,
  reorderGallery,
  publishStorefront,
  unpublishStorefront,
} from "../services/storefrontService";
import type {
  GalleryItem,
  StorefrontRow,
  UpdateStorefrontData,
} from "../types/api";

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

const STOREFRONT_KEY = "owner-storefront";

// ---------------------------------------------------------------------------
// useOwnerStorefront — full storefront record for the logged-in owner
// ---------------------------------------------------------------------------

export function useOwnerStorefront() {
  const { user } = useAuth();
  const { data: tenant } = useTenant(user?.id);
  const businessId = tenant?.businessId;

  return useQuery<StorefrontRow | null>({
    queryKey: [STOREFRONT_KEY, businessId],
    queryFn: () => getOwnerStorefront(businessId!),
    enabled: !!businessId,
    staleTime: 300_000,
  });
}

// ---------------------------------------------------------------------------
// useUpdateStorefront — debounced auto-save mutation
// ---------------------------------------------------------------------------

export function useUpdateStorefront() {
  const { user } = useAuth();
  const { data: tenant } = useTenant(user?.id);
  const businessId = tenant?.businessId;
  const queryClient = useQueryClient();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const mutation = useMutation<StorefrontRow, Error, UpdateStorefrontData>({
    mutationFn: (data: UpdateStorefrontData) =>
      updateStorefront(businessId!, data),
    onSuccess: (updated: StorefrontRow) => {
      queryClient.setQueryData([STOREFRONT_KEY, businessId], updated);
    },
  });

  const debouncedMutate = useCallback(
    (data: UpdateStorefrontData) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        mutation.mutate(data);
      }, 500);
    },
    [mutation],
  );

  return { ...mutation, debouncedMutate };
}

// ---------------------------------------------------------------------------
// Upload hooks
// ---------------------------------------------------------------------------

export function useUploadLogo() {
  const { user } = useAuth();
  const { data: tenant } = useTenant(user?.id);
  const businessId = tenant?.businessId;
  const queryClient = useQueryClient();

  return useMutation<string, Error, File>({
    mutationFn: (file: File) => uploadLogo(businessId!, file),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [STOREFRONT_KEY, businessId] });
    },
  });
}

export function useUploadCover() {
  const { user } = useAuth();
  const { data: tenant } = useTenant(user?.id);
  const businessId = tenant?.businessId;
  const queryClient = useQueryClient();

  return useMutation<string, Error, File>({
    mutationFn: (file: File) => uploadCover(businessId!, file),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [STOREFRONT_KEY, businessId] });
    },
  });
}

export function useUploadGalleryImage() {
  const { user } = useAuth();
  const { data: tenant } = useTenant(user?.id);
  const businessId = tenant?.businessId;
  const queryClient = useQueryClient();

  return useMutation<
    GalleryItem,
    Error,
    { storefrontId: string; file: File }
  >({
    mutationFn: ({ storefrontId, file }: { storefrontId: string; file: File }) =>
      uploadGalleryImage(storefrontId, businessId!, file),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [STOREFRONT_KEY, businessId] });
    },
  });
}

// ---------------------------------------------------------------------------
// Gallery management hooks
// ---------------------------------------------------------------------------

export function useDeleteGalleryImage() {
  const { user } = useAuth();
  const { data: tenant } = useTenant(user?.id);
  const businessId = tenant?.businessId;
  const queryClient = useQueryClient();

  return useMutation<void, Error, { galleryId: string; imageUrl: string }>({
    mutationFn: ({ galleryId, imageUrl }: { galleryId: string; imageUrl: string }) =>
      deleteGalleryImage(galleryId, imageUrl),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [STOREFRONT_KEY, businessId] });
    },
  });
}

export function useReorderGallery() {
  const { user } = useAuth();
  const { data: tenant } = useTenant(user?.id);
  const businessId = tenant?.businessId;
  const queryClient = useQueryClient();

  return useMutation<void, Error, { storefrontId: string; orderedIds: string[] }>({
    mutationFn: ({ storefrontId, orderedIds }: { storefrontId: string; orderedIds: string[] }) =>
      reorderGallery(storefrontId, orderedIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [STOREFRONT_KEY, businessId] });
    },
  });
}

// ---------------------------------------------------------------------------
// Publish / unpublish
// ---------------------------------------------------------------------------

export function usePublishStorefront() {
  const { user } = useAuth();
  const { data: tenant } = useTenant(user?.id);
  const businessId = tenant?.businessId;
  const queryClient = useQueryClient();

  return useMutation<void, Error, boolean>({
    mutationFn: async (publish: boolean) => {
      if (publish) {
        await publishStorefront(businessId!);
      } else {
        await unpublishStorefront(businessId!);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [STOREFRONT_KEY, businessId] });
    },
  });
}
