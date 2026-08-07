-- Migration 091: training practice session slots, slot bookings, and reviews

-- ── training_session_slots ────────────────────────────────────────────────────
-- Owner sets dates/times when practice sessions are available for a training offer.
CREATE TABLE training_session_slots (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id          UUID        NOT NULL REFERENCES business_offers(id)  ON DELETE CASCADE,
  business_id       UUID        NOT NULL REFERENCES businesses(id),
  staff_profile_id  UUID        REFERENCES staff_profiles(id),
  starts_at         TIMESTAMPTZ NOT NULL,
  ends_at           TIMESTAMPTZ NOT NULL,
  max_registrants   INTEGER     NOT NULL DEFAULT 1,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE training_session_slots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_training_session_slots"
  ON training_session_slots FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- ── training_slot_bookings ────────────────────────────────────────────────────
-- Client books specific practice session slots when registering for training.
CREATE TABLE training_slot_bookings (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id        UUID        NOT NULL REFERENCES training_session_slots(id) ON DELETE CASCADE,
  redemption_id  UUID        NOT NULL REFERENCES offer_redemptions(id)      ON DELETE CASCADE,
  client_id      UUID        NOT NULL REFERENCES clients(id),
  business_id    UUID        NOT NULL REFERENCES businesses(id),
  status         TEXT        NOT NULL DEFAULT 'confirmed'
                             CHECK (status IN ('confirmed', 'cancelled')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(slot_id, client_id)
);

ALTER TABLE training_slot_bookings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_training_slot_bookings"
  ON training_slot_bookings FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- ── training_reviews ──────────────────────────────────────────────────────────
-- Clients can leave a star rating + comment after completing a training course.
CREATE TABLE training_reviews (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id   UUID        NOT NULL REFERENCES training_courses(id) ON DELETE CASCADE,
  client_id   UUID        NOT NULL REFERENCES clients(id)          ON DELETE CASCADE,
  business_id UUID        NOT NULL REFERENCES businesses(id),
  rating      INTEGER     NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(course_id, client_id)
);

ALTER TABLE training_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_training_reviews"
  ON training_reviews FOR ALL
  TO service_role USING (true) WITH CHECK (true);
