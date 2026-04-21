[0m[32mCheck[0m supabase/functions/appointments/appointments.test.ts
[0m[32mCheck[0m supabase/functions/auth-register/auth-register.test.ts
[0m[32mCheck[0m supabase/functions/cancel-booking/cancel-booking.test.ts
[0m[32mCheck[0m supabase/functions/create-booking/create-booking.test.ts
[0m[32mCheck[0m supabase/functions/get-availability/get-availability.test.ts
[0m[32mCheck[0m supabase/functions/get-storefront/get-storefront.test.ts
[0m[32mCheck[0m supabase/functions/me/me.test.ts
[0m[32mCheck[0m supabase/functions/send-email/send-email.test.ts
[0m[32mCheck[0m supabase/functions/send-reminders/send-reminders.test.ts
[0m[32mCheck[0m supabase/functions/services/services.test.ts
[0m[38;5;245mrunning 2 tests from ./supabase/functions/appointments/appointments.test.ts[0m
appointments: GET without auth ... [0m[32mok[0m [0m[38;5;245m(43ms)[0m
appointments: GET with owner token ... [0m[32mok[0m [0m[38;5;245m(0ms)[0m
[0m[38;5;245mrunning 6 tests from ./supabase/functions/auth-register/auth-register.test.ts[0m
auth-register: missing email ... [0m[32mok[0m [0m[38;5;245m(14ms)[0m
auth-register: missing password ... [0m[32mok[0m [0m[38;5;245m(3ms)[0m
auth-register: missing businessName for business ... [0m[32mok[0m [0m[38;5;245m(3ms)[0m
auth-register: invalid email format ... [0m[32mok[0m [0m[38;5;245m(4ms)[0m
auth-register: valid business registration ... [0m[32mok[0m [0m[38;5;245m(134ms)[0m
auth-register: duplicate email ... [0m[32mok[0m [0m[38;5;245m(198ms)[0m
[0m[38;5;245mrunning 4 tests from ./supabase/functions/cancel-booking/cancel-booking.test.ts[0m
cancel-booking: missing appointment_id ... [0m[32mok[0m [0m[38;5;245m(31ms)[0m
cancel-booking: invalid cancel token ... [0m[32mok[0m [0m[38;5;245m(8ms)[0m
cancel-booking: valid cancellation with token ... [0m[32mok[0m [0m[38;5;245m(0ms)[0m
cancel-booking: already cancelled appointment ... [0m[32mok[0m [0m[38;5;245m(0ms)[0m
[0m[38;5;245mrunning 7 tests from ./supabase/functions/create-booking/create-booking.test.ts[0m
create-booking: missing service_id ... [0m[32mok[0m [0m[38;5;245m(81ms)[0m
create-booking: missing starts_at ... [0m[32mok[0m [0m[38;5;245m(6ms)[0m
create-booking: missing client email ... [0m[32mok[0m [0m[38;5;245m(3ms)[0m
create-booking: invalid starts_at format ... [0m[32mok[0m [0m[38;5;245m(2ms)[0m
create-booking: valid guest booking ... [0m[32mok[0m [0m[38;5;245m(110ms)[0m
create-booking: double booking same slot ... [0m[32mok[0m [0m[38;5;245m(92ms)[0m
create-booking: starts_at in the past ... [0m[32mok[0m [0m[38;5;245m(6ms)[0m
[0m[38;5;245mrunning 7 tests from ./supabase/functions/get-availability/get-availability.test.ts[0m
get-availability: missing business_id ... [0m[32mok[0m [0m[38;5;245m(3ms)[0m
get-availability: missing service_id ... [0m[32mok[0m [0m[38;5;245m(2ms)[0m
get-availability: missing date ... [0m[32mok[0m [0m[38;5;245m(2ms)[0m
get-availability: invalid date format ... [0m[32mok[0m [0m[38;5;245m(2ms)[0m
get-availability: working day ... [0m[32mok[0m [0m[38;5;245m(15ms)[0m
get-availability: non-working day ... [0m[32mok[0m [0m[38;5;245m(4ms)[0m
get-availability: past date ... [0m[32mok[0m [0m[38;5;245m(2ms)[0m
[0m[38;5;245mrunning 3 tests from ./supabase/functions/get-storefront/get-storefront.test.ts[0m
get-storefront: missing slug ... [0m[32mok[0m [0m[38;5;245m(28ms)[0m
get-storefront: non-existent slug ... [0m[32mok[0m [0m[38;5;245m(14ms)[0m
get-storefront: valid slug (afrotouch) ... [0m[32mok[0m [0m[38;5;245m(33ms)[0m
[0m[38;5;245mrunning 4 tests from ./supabase/functions/me/me.test.ts[0m
me: no auth token ... [0m[32mok[0m [0m[38;5;245m(13ms)[0m
me: valid owner token ... [0m[32mok[0m [0m[38;5;245m(0ms)[0m
me: PATCH with valid data ... [0m[32mok[0m [0m[38;5;245m(0ms)[0m
me: PATCH with invalid field ... [0m[32mok[0m [0m[38;5;245m(0ms)[0m
[0m[38;5;245mrunning 5 tests from ./supabase/functions/send-email/send-email.test.ts[0m
send-email: missing x-internal-key ... [0m[32mok[0m [0m[38;5;245m(10ms)[0m
send-email: wrong x-internal-key ... [0m[32mok[0m [0m[38;5;245m(4ms)[0m
send-email: missing 'to' field ... [0m[32mok[0m [0m[38;5;245m(2ms)[0m
send-email: missing 'template' field ... [0m[32mok[0m [0m[38;5;245m(2ms)[0m
send-email: valid request ... [0m[32mok[0m [0m[38;5;245m(205ms)[0m
[0m[38;5;245mrunning 4 tests from ./supabase/functions/send-reminders/send-reminders.test.ts[0m
send-reminders: missing Authorization header ... [0m[32mok[0m [0m[38;5;245m(16ms)[0m
send-reminders: wrong CRON_SECRET ... [0m[32mok[0m [0m[38;5;245m(3ms)[0m
send-reminders: correct CRON_SECRET ... [0m[32mok[0m [0m[38;5;245m(6ms)[0m
send-reminders: no upcoming appointments ... [0m[32mok[0m [0m[38;5;245m(7ms)[0m
[0m[38;5;245mrunning 7 tests from ./supabase/functions/services/services.test.ts[0m
services: GET without auth ... [0m[32mok[0m [0m[38;5;245m(4ms)[0m
services: GET with owner token ... [0m[32mok[0m [0m[38;5;245m(0ms)[0m
services: POST without auth ... [0m[32mok[0m [0m[38;5;245m(2ms)[0m
services: POST missing name ... [0m[32mok[0m [0m[38;5;245m(0ms)[0m
services: POST missing price ... [0m[32mok[0m [0m[38;5;245m(0ms)[0m
services: POST valid service ... [0m[32mok[0m [0m[38;5;245m(0ms)[0m
services: PATCH service from different business ... [0m[32mok[0m [0m[38;5;245m(0ms)[0m

[0m[32mok[0m | 49 passed | 0 failed [0m[38;5;245m(1s)[0m

