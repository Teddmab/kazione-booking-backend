# Supabase – KaziOne Booking

## Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli/getting-started) (`brew install supabase/tap/supabase`)
- Docker Desktop (required for local development)
- A linked Supabase project (`supabase link --project-ref <ref>`)

## Local Development

```bash
# Start the local Supabase stack (Postgres, Auth, Storage, Edge Functions, Studio)
supabase start

# Studio UI opens at http://localhost:54323
# API is available at http://localhost:54321
```

## Migrations

Migration files live in `supabase/migrations/` and are numbered sequentially:

```
001_enums.sql
002_core_tables.sql
003_service_catalog.sql
...
```

### Run migrations locally

```bash
# Apply all pending migrations to the local database
supabase db reset
```

### Create a new migration

```bash
supabase migration new <name>
# e.g. supabase migration new add_currency_column
```

### Push migrations to remote

```bash
supabase db push
```

## Edge Functions

Edge Functions live in `supabase/functions/`. Each subfolder is a separate function.
Shared utilities go in `supabase/functions/_shared/`.

### Serve locally

```bash
# Serve all functions with hot-reload
supabase functions serve

# Serve a single function
supabase functions serve <function-name>
```

### Deploy

```bash
# Deploy a single function
supabase functions deploy <function-name>

# Deploy all functions
supabase functions deploy
```

### Set Secrets

Edge Functions read secrets from the Supabase Vault. Set them via the CLI:

```bash
supabase secrets set STRIPE_SECRET_KEY=sk_test_... \
  STRIPE_WEBHOOK_SECRET=whsec_... \
  RESEND_API_KEY=re_... \
  ANTHROPIC_API_KEY=sk-ant-... \
  APP_URL=https://your-domain.com
```

List current secrets:

```bash
supabase secrets list
```

> **Note:** `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are automatically available inside Edge Functions — you do not need to set them manually.

## Project Structure

```
supabase/
├── config.toml              # Local dev configuration
├── migrations/              # Sequential SQL migration files
│   ├── 001_enums.sql
│   ├── 002_core_tables.sql
│   └── ...
├── functions/
│   ├── deno.json            # Shared Deno import map
│   ├── _shared/             # Shared utilities (cors, supabase client, etc.)
│   ├── create-booking/
│   ├── cancel-booking/
│   ├── reschedule-booking/
│   ├── get-availability/
│   ├── get-storefront/
│   ├── lookup-booking/
│   ├── invite-staff/
│   ├── send-email/
│   ├── send-reminders/
│   ├── export-report/
│   ├── stripe-connect/
│   ├── stripe-webhook/
│   ├── ai-insights/
│   └── ai-finance/
└── README.md                # ← You are here
```

## Environment Variables

Copy `.env.example` to `.env` at the project root. See that file for the full list of required variables:

- `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` – Frontend Supabase client
- `VITE_STRIPE_PUBLISHABLE_KEY` – Frontend Stripe
- `SUPABASE_SERVICE_ROLE_KEY` – Edge Function admin access
- `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` – Payments
- `RESEND_API_KEY` – Transactional email
- `ANTHROPIC_API_KEY` – AI features
- `APP_URL` – Canonical app URL for links in emails/webhooks
