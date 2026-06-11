-- Add owner_dashboard to booking_source enum
-- Required for bookings created via the owner dashboard UI

ALTER TYPE booking_source ADD VALUE IF NOT EXISTS 'owner_dashboard';
