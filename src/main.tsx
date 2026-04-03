import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import "./index.css";

// ---------------------------------------------------------------------------
// Smart retry: 2× for 5xx/network, 0× for 4xx
// ---------------------------------------------------------------------------

function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;

  // NetworkError from our services carries a status code
  const status =
    (error as { status?: number })?.status ??
    (error as { statusCode?: number })?.statusCode;

  // Don't retry 4xx (client errors)
  if (status && status >= 400 && status < 500) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Global error handler: auto sign-out on 401
// ---------------------------------------------------------------------------

function handleGlobalError(error: unknown) {
  const status =
    (error as { status?: number })?.status ??
    (error as { statusCode?: number })?.statusCode;

  if (status === 401) {
    // Force sign out + redirect — imported dynamically to avoid circular deps
    import("./lib/supabase").then(({ supabase }) => {
      supabase.auth.signOut().then(() => {
        window.location.href = "/login";
      });
    });
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: shouldRetry,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
      onError: handleGlobalError,
    },
  },
});

// Also handle query errors globally
queryClient.getQueryCache().config.onError = handleGlobalError;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
