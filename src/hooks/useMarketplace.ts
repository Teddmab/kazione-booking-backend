import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getPublicStorefronts } from "../services/storefrontService";
import {
  getBusinessReviews,
  submitReview,
  replyToReview,
} from "../services/reviewService";
import type {
  PaginatedStorefronts,
  PaginatedReviews,
  ReviewRow,
  SubmitReviewData,
} from "../types/api";

// ---------------------------------------------------------------------------
// useMarketplaceSalons — browseable published storefronts
// ---------------------------------------------------------------------------

export function useMarketplaceSalons(filters: {
  search?: string;
  categories?: string[];
  city?: string;
  page?: number;
  limit?: number;
} = {}) {
  return useQuery<PaginatedStorefronts>({
    queryKey: ["marketplace-salons", filters],
    queryFn: () => getPublicStorefronts(filters),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
}

// ---------------------------------------------------------------------------
// useBusinessReviews — paginated reviews for a business
// ---------------------------------------------------------------------------

export function useBusinessReviews(
  businessId: string | undefined,
  page = 1,
  limit = 20,
) {
  return useQuery<PaginatedReviews>({
    queryKey: ["business-reviews", businessId, page, limit],
    queryFn: () => getBusinessReviews(businessId!, page, limit),
    enabled: !!businessId,
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------
// useSubmitReview — client submits a review for a completed appointment
// ---------------------------------------------------------------------------

export function useSubmitReview() {
  const queryClient = useQueryClient();

  return useMutation<ReviewRow, Error, SubmitReviewData>({
    mutationFn: (data: SubmitReviewData) => submitReview(data),
    onSuccess: (review: ReviewRow) => {
      queryClient.invalidateQueries({
        queryKey: ["business-reviews", review.business_id],
      });
    },
  });
}

// ---------------------------------------------------------------------------
// useReplyToReview — owner/manager replies to a review
// ---------------------------------------------------------------------------

export function useReplyToReview() {
  const queryClient = useQueryClient();

  return useMutation<ReviewRow, Error, { reviewId: string; reply: string }>({
    mutationFn: ({ reviewId, reply }: { reviewId: string; reply: string }) =>
      replyToReview(reviewId, reply),
    onSuccess: (review: ReviewRow) => {
      queryClient.invalidateQueries({
        queryKey: ["business-reviews", review.business_id],
      });
    },
  });
}
