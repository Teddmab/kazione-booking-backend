// ---------------------------------------------------------------------------
// src/types/api.ts — TypeScript types for all Edge Function request/response
// ---------------------------------------------------------------------------

// ── Shared error envelope ─────────────────────────────────────────────────

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface NotFoundError extends ApiError {
  error: {
    code: "NOT_FOUND";
    message: string;
  };
}

export interface SlotTakenError extends ApiError {
  error: {
    code: "SLOT_TAKEN";
    message: string;
    details: {
      available_alternatives: string[];
    };
  };
}

export class NetworkError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: ApiError,
  ) {
    super(message);
    this.name = "NetworkError";
  }
}

// ── get-availability ──────────────────────────────────────────────────────

export interface AvailabilityParams {
  business_id: string;
  service_id: string;
  date: string;
  staff_id?: string;
}

export interface StaffSlot {
  id: string;
  name: string;
  avatarUrl: string | null;
  price: number;
}

export interface Slot {
  time: string;
  staff: StaffSlot[];
}

export interface ServiceInfo {
  id: string;
  name: string;
  durationMinutes: number;
  price: number;
}

export type UnavailableReason =
  | "DATE_IN_PAST"
  | "OUTSIDE_BOOKING_WINDOW"
  | "DAY_OFF"
  | "FULLY_BOOKED";

export interface AvailabilityResult {
  date: string;
  dayName: string;
  service: ServiceInfo | null;
  slots: Slot[];
  isAvailable: boolean;
  reason?: UnavailableReason;
}

// ── create-booking ────────────────────────────────────────────────────────

export interface CreateBookingClient {
  name: string;
  email: string;
  phone: string;
  notes?: string;
}

export interface CreateBookingParams {
  business_id: string;
  service_id: string;
  staff_profile_id: string | null;
  date: string;
  time: string;
  client: CreateBookingClient;
  payment_method: "deposit" | "full" | "later";
  locale?: "en" | "et" | "fr";
}

export interface CreateBookingResult {
  booking_reference: string;
  appointment_id: string;
  status: "confirmed" | "pending_payment";
  payment_intent_client_secret?: string;
}

// ── cancel-booking ────────────────────────────────────────────────────────

export interface CancelBookingParams {
  appointment_id?: string;
  booking_reference?: string;
  email?: string;
  reason?: string;
}

export type RefundStatus = "full" | "partial" | "none" | "deposit_forfeited";

export interface CancelBookingResult {
  success: true;
  appointment_id: string;
  booking_reference: string;
  refund_amount: number;
  refund_status: RefundStatus;
}

// ── reschedule-booking ────────────────────────────────────────────────────

export interface RescheduleBookingParams {
  appointment_id?: string;
  booking_reference?: string;
  email?: string;
  new_date: string;
  new_time: string;
  staff_profile_id?: string | null;
}

export interface RescheduleBookingResult {
  success: true;
  appointment_id: string;
  booking_reference: string;
  new_date: string;
  new_time: string;
  staff_profile_id: string;
  status: "confirmed";
}

// ── lookup-booking ────────────────────────────────────────────────────────

export interface LookupBookingService {
  id: string;
  name: string;
  duration: string;
  durationMinutes: number;
  price: number;
  currency: string;
}

export interface LookupBookingStaff {
  id: string;
  name: string;
  avatar: string | null;
}

export interface LookupBookingPayment {
  status: string;
  method: string;
  amount: number;
  currency: string;
  depositAmount: number;
  taxAmount: number;
  discountAmount: number;
  paidAt: string | null;
}

export interface LookupBookingSalon {
  name: string;
  slug: string;
  address: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
}

export interface LookupBookingResult {
  id: string;
  bookingReference: string;
  status: string;
  date: string;
  time: string;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  price: number;
  depositAmount: number;
  notes: string | null;
  createdAt: string;
  service: LookupBookingService;
  staff: LookupBookingStaff;
  payment: LookupBookingPayment | null;
  salon: LookupBookingSalon;
}

// ── Dashboard KPIs (get_owner_dashboard_kpis) ─────────────────────────────

export interface UpcomingAppointment {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  booking_reference: string;
  client_name: string;
  service_name: string;
  staff_name: string;
  price: number;
}

export interface TopService {
  service_id: string;
  service_name: string;
  count: number;
  revenue: number;
}

export interface BusyHour {
  hour: number;
  count: number;
}

export interface StaffOnToday {
  staff_profile_id: string;
  display_name: string;
  avatar_url: string | null;
  calendar_color: string | null;
}

export interface PeriodStats {
  total: number;
  completed: number;
  cancelled: number;
  revenue: number;
}

export interface DashboardKPIs {
  today: PeriodStats & { remaining: number; walk_ins: number };
  this_week: PeriodStats;
  this_month: Omit<PeriodStats, "cancelled">;
  active_clients_total: number;
  avg_rating: number;
  completion_rate_30d: number;
  upcoming_today: UpcomingAppointment[];
  top_services_30d: TopService[];
  busy_hours_30d: BusyHour[];
  staff_on_today: StaffOnToday[];
}

// ── Revenue & finance ─────────────────────────────────────────────────────

export type ExpenseCategory =
  | "supplies"
  | "rent"
  | "utilities"
  | "payroll"
  | "marketing"
  | "equipment"
  | "software"
  | "professional_services"
  | "other";

export interface DateRange {
  from: string;
  to: string;
}

export interface ExpenseFilters {
  category?: ExpenseCategory;
  supplierId?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface ExpenseRow {
  id: string;
  business_id: string;
  supplier_id: string | null;
  category: ExpenseCategory;
  description: string;
  amount: number;
  currency_code: string;
  tax_amount: number;
  tax_rate: number;
  receipt_url: string | null;
  date: string;
  is_recurring: boolean;
  recurrence_rule: Record<string, unknown> | null;
  recurrence_end_date: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  supplier: { id: string; name: string } | null;
}

export interface PaginatedExpenses {
  expenses: ExpenseRow[];
  total: number;
}

export interface CreateExpenseData {
  supplier_id?: string | null;
  category: ExpenseCategory;
  description: string;
  amount: number;
  currency_code?: string;
  tax_amount?: number;
  tax_rate?: number;
  date: string;
  is_recurring?: boolean;
  recurrence_rule?: Record<string, unknown> | null;
  recurrence_end_date?: string | null;
  notes?: string | null;
}

export interface BookkeepingTransaction {
  date: string;
  type: "income" | "expense";
  description: string;
  category: string;
  amount: number;
  tax_amount: number;
  running_balance: number;
}

export interface ServiceRevenue {
  service_id: string;
  service_name: string;
  total: number;
  count: number;
}

export interface StaffRevenue {
  staff_profile_id: string;
  display_name: string;
  total: number;
  count: number;
}

export interface PaymentMethodRevenue {
  method: string;
  total: number;
  count: number;
}

export interface RevenueSummary {
  total_income: number;
  total_expenses: number;
  net_profit: number;
  income_by_service: ServiceRevenue[];
  income_by_staff: StaffRevenue[];
  income_by_payment_method: PaymentMethodRevenue[];
}

export interface IncomePeriod {
  period: string;
  amount: number;
  appointment_count: number;
}

export interface ExpenseBreakdown {
  category: string;
  amount: number;
  expense_count: number;
}

export interface TaxPeriodBreakdown {
  period: string;
  income: number;
  tax: number;
  expenses: number;
  profit: number;
}

export interface TaxSummary {
  year: number;
  quarter: number | null;
  start_date: string;
  end_date: string;
  gross_income: number;
  tax_collected: number;
  total_expenses: number;
  net_profit: number;
  period_breakdown: TaxPeriodBreakdown[];
}

export interface StaffPerformanceRow {
  staff_profile_id: string;
  display_name: string;
  bookings: number;
  revenue: number;
  unique_clients: number;
  avg_rating: number;
  completion_rate: number;
  commission_amount: number;
}

export interface SupplierSpendRow {
  supplier_id: string;
  supplier_name: string;
  total_spent: number;
  order_count: number;
}

// ── Appointment management ────────────────────────────────────────────────

export type AppointmentStatus =
  | "pending"
  | "confirmed"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "no_show";

export interface AppointmentFilters {
  dateFrom?: string;
  dateTo?: string;
  status?: AppointmentStatus[];
  staffId?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface PaginatedAppointments {
  appointments: AppointmentWithRelations[];
  total: number;
}

export interface CreateAppointmentData {
  client_id: string;
  service_id: string;
  staff_profile_id: string | null;
  starts_at: string;
  duration_minutes: number;
  price: number;
  deposit_amount?: number;
  booking_source?: string;
  is_walk_in?: boolean;
  notes?: string;
  internal_notes?: string;
}

export interface AppointmentStatusLogEntry {
  id: string;
  appointment_id: string;
  old_status: AppointmentStatus | null;
  new_status: AppointmentStatus;
  changed_by: string | null;
  reason: string | null;
  created_at: string;
}

export interface AppointmentDetail extends AppointmentWithRelations {
  internal_notes: string | null;
  status_log: AppointmentStatusLogEntry[];
}

export interface CalendarEntry {
  appointment_id: string;
  starts_at: string;
  ends_at: string;
  status: AppointmentStatus;
  booking_reference: string;
  client_first_name: string;
  client_last_name: string;
  service_name: string;
  staff_display_name: string;
  price: number;
  booking_source: string;
  is_walk_in: boolean;
}

// ── Entity detail types (joins) ───────────────────────────────────────────

export interface AppointmentWithRelations {
  id: string;
  business_id: string;
  client_id: string;
  staff_profile_id: string | null;
  service_id: string;
  status: string;
  starts_at: string;
  ends_at: string;
  duration_minutes: number;
  price: number;
  deposit_amount: number;
  booking_source: string;
  booking_reference: string;
  is_walk_in: boolean;
  notes: string | null;
  cancellation_reason: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
  client: {
    id: string;
    first_name: string;
    last_name: string;
    email: string | null;
    phone: string | null;
    avatar_url: string | null;
  };
  service: {
    id: string;
    name: string;
    duration_minutes: number;
    price: number;
  };
  staff: {
    id: string;
    display_name: string;
    avatar_url: string | null;
  } | null;
  payment: {
    status: string;
    amount: number;
    method: string;
    paid_at: string | null;
  } | null;
}

export interface ClientDetail {
  id: string;
  business_id: string;
  user_id: string | null;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  avatar_url: string | null;
  date_of_birth: string | null;
  notes: string | null;
  tags: string[];
  preferred_staff_id: string | null;
  preferred_locale: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface StaffProfileDetail {
  id: string;
  business_id: string;
  display_name: string;
  bio: string | null;
  avatar_url: string | null;
  specialties: string[];
  commission_rate: number;
  calendar_color: string;
  is_active: boolean;
  service_ids: string[];
  created_at: string;
  updated_at: string;
}

// ── get-storefront ────────────────────────────────────────────────────────

export interface StorefrontService {
  id: string;
  name: string;
  category: string;
  categoryId: string | null;
  description: string;
  duration: string;
  durationMin: number;
  price: number;
  currency: string;
  popular: boolean;
  imageUrl: string | null;
  displayOrder: number;
}

export interface StorefrontStaffMember {
  id: string;
  name: string;
  role: string;
  bio: string;
  avatar: string | null;
  specialties: string[];
  serviceIds: string[];
}

export interface StorefrontPromotion {
  id: string;
  title: string;
  description: string;
  discountType: string;
  discountValue: number;
  badge: string | null;
  validFrom: string | null;
  validUntil: string | null;
  appliesTo: string[];
}

export interface StorefrontGalleryImage {
  id: string;
  imageUrl: string;
  caption: string | null;
  displayOrder: number;
}

export interface StorefrontReview {
  id: string;
  rating: number;
  comment: string | null;
  ownerReply: string | null;
  repliedAt: string | null;
  clientName: string;
  clientAvatar: string | null;
  createdAt: string;
}

export interface StorefrontContact {
  address: string | null;
  city: string | null;
  countryCode: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
}

export interface StorefrontSections {
  hero: boolean;
  about: boolean;
  services: boolean;
  promotions: boolean;
  gallery: boolean;
  team: boolean;
  reviews: boolean;
  booking: boolean;
}

export interface StorefrontData {
  id: string;
  businessId: string;
  slug: string;
  name: string;
  tagline: string | null;
  description: string | null;
  extendedDescription: string | null;
  logoUrl: string | null;
  coverImageUrl: string | null;
  accentColor: string;
  verified: boolean;
  currencyCode: string;
  countryCode: string | null;
  headline: string | null;
  tags: string[];
  categories: string[];
  featured: boolean;
  bookingPolicy: string | null;
  cancellationPolicy: string | null;
  sections: StorefrontSections;
  seoTitle: string | null;
  seoDescription: string | null;
  rating: number;
  reviewCount: number;
  contact: StorefrontContact;
  services: StorefrontService[];
  team: StorefrontStaffMember[];
  promotions: StorefrontPromotion[];
  gallery: StorefrontGalleryImage[];
  reviews: StorefrontReview[];
}

// ── Client management ─────────────────────────────────────────────────────

export interface ClientWithStats extends ClientDetail {
  appointment_count: number;
  last_visit: string | null;
  total_spent: number;
}

export interface ClientFilters {
  search?: string;
  tags?: string[];
  page?: number;
  limit?: number;
}

export interface PaginatedClients {
  clients: ClientWithStats[];
  total: number;
}

export interface CreateClientData {
  first_name: string;
  last_name: string;
  email?: string | null;
  phone?: string | null;
  date_of_birth?: string | null;
  notes?: string | null;
  tags?: string[];
  preferred_staff_id?: string | null;
  preferred_locale?: string;
  source?: string;
}

export interface ImportRow {
  first_name: string;
  last_name: string;
  email?: string | null;
  phone?: string | null;
  date_of_birth?: string | null;
  notes?: string | null;
  tags?: string[];
  source?: string;
}

export interface ImportResult {
  imported: number;
  updated: number;
  skipped: number;
  errors: { row: number; reason: string }[];
}

// ── Storefront owner management ───────────────────────────────────────────

export interface StorefrontRow {
  id: string;
  business_id: string;
  slug: string;
  title: string;
  tagline: string | null;
  description: string | null;
  extended_description: string | null;
  logo_url: string | null;
  cover_image_url: string | null;
  accent_color: string;
  is_published: boolean;
  custom_domain: string | null;
  address: string | null;
  city: string | null;
  country_code: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  marketplace_status: string;
  marketplace_featured: boolean;
  marketplace_headline: string | null;
  marketplace_tags: string[];
  marketplace_categories: string[];
  booking_policy: string | null;
  cancellation_policy: string | null;
  sections: StorefrontSections;
  seo_title: string | null;
  seo_description: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpdateStorefrontData {
  slug?: string;
  title?: string;
  tagline?: string | null;
  description?: string | null;
  extended_description?: string | null;
  logo_url?: string | null;
  cover_image_url?: string | null;
  accent_color?: string;
  is_published?: boolean;
  custom_domain?: string | null;
  address?: string | null;
  city?: string | null;
  country_code?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  marketplace_status?: string;
  marketplace_featured?: boolean;
  marketplace_headline?: string | null;
  marketplace_tags?: string[];
  marketplace_categories?: string[];
  booking_policy?: string | null;
  cancellation_policy?: string | null;
  sections?: Partial<StorefrontSections>;
  seo_title?: string | null;
  seo_description?: string | null;
}

export interface GalleryItem {
  id: string;
  storefront_id: string;
  image_url: string;
  caption: string | null;
  display_order: number;
  created_at: string;
}

export interface PublicStorefrontListing {
  id: string;
  business_id: string;
  slug: string;
  title: string;
  tagline: string | null;
  logo_url: string | null;
  cover_image_url: string | null;
  city: string | null;
  marketplace_categories: string[];
  marketplace_tags: string[];
  marketplace_headline: string | null;
  avg_rating: number;
  review_count: number;
  services_preview: { id: string; name: string; price: number }[];
}

export interface PaginatedStorefronts {
  storefronts: PublicStorefrontListing[];
  total: number;
}

// ── Reviews management ────────────────────────────────────────────────────

export interface ReviewRow {
  id: string;
  business_id: string;
  client_id: string | null;
  appointment_id: string | null;
  rating: number;
  comment: string | null;
  is_public: boolean;
  owner_reply: string | null;
  replied_at: string | null;
  created_at: string;
  client: {
    first_name: string;
    last_name: string;
    avatar_url: string | null;
  } | null;
}

export interface PaginatedReviews {
  reviews: ReviewRow[];
  total: number;
}

export interface SubmitReviewData {
  appointmentId: string;
  rating: number;
  comment?: string | null;
}

// ── Supplier management ───────────────────────────────────────────────────

export type SupplierOrderStatus = "draft" | "ordered" | "received" | "cancelled";

export interface SupplierRow {
  id: string;
  business_id: string;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  address: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SupplierWithStats extends SupplierRow {
  total_spent: number;
  open_orders: number;
}

export interface SupplierFilters {
  search?: string;
  isActive?: boolean;
  page?: number;
  limit?: number;
}

export interface PaginatedSuppliers {
  suppliers: SupplierWithStats[];
  total: number;
}

export interface CreateSupplierData {
  name: string;
  contact_name?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  address?: string | null;
  notes?: string | null;
}

export interface SupplierDetail extends SupplierRow {
  recent_expenses: {
    id: string;
    description: string;
    amount: number;
    date: string;
    category: string;
  }[];
  open_orders: {
    id: string;
    reference: string;
    status: SupplierOrderStatus;
    total_amount: number;
    ordered_at: string | null;
    expected_at: string | null;
  }[];
  monthly_spend: { month: string; amount: number }[];
}

export interface SupplierOrderItemRow {
  id: string;
  order_id: string;
  product_name: string;
  sku: string | null;
  quantity: number;
  unit_price: number;
  total_price: number;
}

export interface SupplierOrderRow {
  id: string;
  business_id: string;
  supplier_id: string;
  reference: string;
  status: SupplierOrderStatus;
  total_amount: number;
  notes: string | null;
  ordered_at: string | null;
  expected_at: string | null;
  received_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  items: SupplierOrderItemRow[];
  supplier: { name: string } | null;
}

export interface SupplierOrderFilters {
  supplierId?: string;
  status?: SupplierOrderStatus[];
  page?: number;
  limit?: number;
}

export interface PaginatedSupplierOrders {
  orders: SupplierOrderRow[];
  total: number;
}

export interface CreateOrderItemData {
  product_name: string;
  sku?: string | null;
  quantity: number;
  unit_price: number;
}

export interface CreateOrderData {
  supplier_id: string;
  reference: string;
  notes?: string | null;
  ordered_at?: string | null;
  expected_at?: string | null;
  items: CreateOrderItemData[];
}
