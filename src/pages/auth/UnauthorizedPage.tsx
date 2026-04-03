import { Link } from "react-router-dom";

export default function UnauthorizedPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-4 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-red-100 text-3xl dark:bg-red-950">
          🚫
        </div>
        <h1 className="text-2xl font-bold">Access denied</h1>
        <p className="text-sm text-muted-foreground">
          You don't have permission to access this page. Contact your business
          owner if you think this is a mistake.
        </p>
        <div className="flex justify-center gap-3">
          <Link
            to="/login"
            className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            Sign in
          </Link>
          <Link
            to="/"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}
