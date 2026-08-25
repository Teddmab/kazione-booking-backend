-- Optional metadata captured when an owner records a commission payout —
-- distinct from commission_paid_at (system timestamp of when the record was
-- made in the app). commission_payment_date lets the owner assert when the
-- external payment actually happened (e.g. a bank transfer that clears a
-- day later); reference/note are free-text for the owner's own bookkeeping.
-- None of these affect commission calculation — they only describe how a
-- payment already computed elsewhere was recorded.
ALTER TABLE appointments
  ADD COLUMN commission_payment_date date,
  ADD COLUMN commission_pay_reference text,
  ADD COLUMN commission_pay_note text;
