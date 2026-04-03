import { useState, useCallback } from "react";
import { Link, useLocation } from "react-router-dom";
import { supabase } from "../../lib/supabase";

export default function CheckEmailPage() {
  const location = useLocation();
  const email = (location.state as { email?: string } | null)?.email ?? "";

  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleResend = useCallback(async () => {
    if (!email) return;
    setResending(true);
    setError(null);

    const { error: err } = await supabase.auth.resend({
      type: "signup",
      email,
    });

    setResending(false);

    if (err) {
      setError(err.message);
      return;
    }

    setResent(true);
  }, [email]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6 text-center">
        {/* Icon */}
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 text-3xl">
          ✉️
        </div>

        <div>
          <h1 className="text-2xl font-bold">Check your inbox</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            We sent a confirmation link to{" "}
            {email ? (
              <span className="font-medium text-foreground">{email}</span>
            ) : (
              "your email"
            )}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Click the link in the email to verify your account and get started.
          </p>
        </div>

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
            {error}
          </div>
        )}

        {resent ? (
          <p className="text-sm font-medium text-green-600 dark:text-green-400">
            Email resent! Check your inbox again.
          </p>
        ) : (
          <button
            onClick={handleResend}
            disabled={resending || !email}
            className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {resending ? "Resending…" : "Resend email"}
          </button>
        )}

        <p className="text-sm text-muted-foreground">
          <Link to="/login" className="font-medium text-primary hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
