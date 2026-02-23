// API Response Types
export interface ApiResponse<T = any> {
  data: T;
  message?: string;
  errors?: FieldError[];
}

export interface PaginatedResponse<T = any> extends ApiResponse<T[]> {
  pagination: {
    cursor?: string;
    limit: number;
    total?: number;
    hasMore?: boolean;
  };
  freshness?: 'fresh' | 'stale';
}

export interface FieldError {
  field: string;
  code: string;
  message: string;
  value?: any;
}

// Entity Types
export interface Vendor {
  id: string;
  name: string;
  status: 'active' | 'inactive' | 'suspended';
  created_at: string;
  updated_at: string;
  settings_json: Record<string, any>;
  catalog_version: number;
}

export interface Product {
  id: string;
  vendor_id: string;
  external_id: string;
  name: string;
  brand?: string;
  description?: string;
  category_id?: string;
  price?: number;
  currency: string;
  status: 'active' | 'inactive';
  created_at: string;
  updated_at: string;
  barcode?: string;
  gtin_type?: 'UPC' | 'EAN' | 'ISBN';
  ingredients?: string;
  nutrition?: Record<string, any>;
  serving_size?: string;
  package_weight?: string;
  dietary_tags?: string[];
  allergens?: string[];
  certifications?: string[];
  regulatory_codes?: string[];
  source_url?: string;
  soft_deleted_at?: string;
}

export interface Customer {
  id: string;
  vendor_id: string;
  external_id: string;
  full_name: string;
  email: string;
  dob?: string;
  age?: number;
  gender?: 'male' | 'female' | 'other' | 'unspecified';
  location?: Record<string, any>;
  created_at: string;
  updated_at: string;
  phone?: string;
  custom_tags?: string[];
}

export interface CustomerHealthProfile {
  customer_id: string;
  height_cm: number;
  weight_kg: number;
  age: number;
  gender: 'male' | 'female' | 'other' | 'unspecified';
  activity_level: 'sedentary' | 'light' | 'moderate' | 'very' | 'extra';
  conditions: string[];
  diet_goals: string[];
  macro_targets: Record<string, any>;
  avoid_allergens: string[];
  bmi?: number;
  bmr?: number;
  tdee_cached?: number;
  derived_limits?: Record<string, any>;
  created_at: string;
  updated_at: string;
  updated_by?: string;
}

export interface OrchestrationRun {
  id: string;
  flowName: string;
  flowType: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  triggerType: string;
  triggeredBy?: string;
  vendorId?: string;
  sourceName?: string;
  layers?: string[];
  currentLayer?: string;
  progressPct?: number;
  totalRecordsProcessed?: number;
  totalRecordsWritten?: number;
  totalDqIssues?: number;
  totalErrors?: number;
  totals?: Record<string, any>;
  startedAt?: string;
  completedAt?: string;
  durationSeconds?: string;
  config?: Record<string, any>;
  metadata?: Record<string, any>;
  errorMessage?: string;
  createdAt: string;
  // Pipeline detail (populated by GET /jobs/:id)
  pipelines?: PipelineRun[];
}

export interface PipelineRun {
  id: string;
  pipelineId: string;
  pipelineName?: string;
  orchestrationRunId: string;
  status: string;
  recordsInput?: number;
  recordsProcessed?: number;
  recordsWritten?: number;
  recordsFailed?: number;
  errorMessage?: string;
  createdAt: string;
}

/** @deprecated Use OrchestrationRun instead */
export type IngestionJob = OrchestrationRun;

export interface AuditLogEntry {
  id: string;
  actor_user_id?: string;
  actor_role?: string;
  vendor_id?: string;
  action: string;
  entity: string;
  entity_id?: string;
  before?: Record<string, any>;
  after?: Record<string, any>;
  ip?: string;
  ua?: string;
  justification?: string;
  timestamp: string;
}

export interface WebhookEndpoint {
  id: string;
  vendor_id: string;
  url: string;
  secret_ref?: string;
  enabled: boolean;
  description?: string;
  retries_max: number;
  tolerance_sec: number;
  created_at: string;
  updated_at: string;
}

// System Metrics Types
export interface SystemMetrics {
  searchP95: number;
  matchesP95: number;
  dailyJobs: number;
  availability: number;
  activeJobs: number;
  lastUpdated: string;
  database?: DatabaseHealth;
}

export interface DatabaseHealth {
  primary: {
    cpu: number;
    memory: number;
    connections: number;
    maxConnections: number;
  };
  replicas: Array<{
    id: string;
    status: string;
    lag: number;
  }>;
  partitions: {
    products: number;
    customers: number;
    vendors: number;
  };
}

// Request Types
export interface CreateVendorRequest {
  name: string;
  status?: 'active' | 'inactive' | 'suspended';
  settings_json?: Record<string, any>;
}

export interface CreateProductRequest {
  external_id: string;
  name: string;
  brand?: string;
  description?: string;
  category_id?: string;
  price?: number;
  currency?: string;
  barcode?: string;
  gtin_type?: 'UPC' | 'EAN' | 'ISBN';
  ingredients?: string;
  nutrition?: Record<string, any>;
  serving_size?: string;
  package_weight?: string;
  dietary_tags?: string[];
  allergens?: string[];
  certifications?: string[];
  regulatory_codes?: string[];
  source_url?: string;
}

export interface CreateCustomerRequest {
  external_id: string;
  full_name: string;
  email: string;
  dob?: string;
  age?: number;
  gender?: 'male' | 'female' | 'other' | 'unspecified';
  location?: Record<string, any>;
  phone?: string;
  custom_tags?: string[];
}

export interface UpdateCustomerHealthRequest {
  height_cm: number;
  weight_kg: number;
  age: number;
  gender: 'male' | 'female' | 'other' | 'unspecified';
  activity_level: 'sedentary' | 'light' | 'moderate' | 'very' | 'extra';
  conditions: string[];
  diet_goals: string[];
  macro_targets: Record<string, any>;
  avoid_allergens: string[];
}

export interface StartIngestionRequest {
  mode: 'products' | 'customers';
  params?: Record<string, any>;
}

export interface CreateWebhookEndpointRequest {
  url: string;
  description?: string;
  retries_max?: number;
  tolerance_sec?: number;
}

// Search and Filter Types
export interface SearchFilters {
  q?: string;
  brand?: string;
  category_id?: string;
  tags?: string[];
  allergens?: string[];
  updated_after?: string;
  sort?: 'relevance' | '-updated_at' | 'name';
}

export interface MatchingParams {
  customer_id: string;
  k?: number;
  filters?: SearchFilters;
}

export interface SearchResponse<T> extends ApiResponse<T[]> {
  query?: string;
  freshness?: 'fresh' | 'stale';
}

export interface MatchingResponse extends ApiResponse<Product[]> {
  customer_id: string;
  k: number;
  cached: boolean;
  freshness?: 'fresh' | 'stale';
}
