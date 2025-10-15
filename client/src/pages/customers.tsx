import * as React from "react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/top-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search, Users, Filter, Download, Upload, Heart } from "lucide-react";

/** Helpers to accept either:
 *   - array payloads: [...]
 *   - object payloads: { data: [...], total?: number }
 */
function toItems<T = unknown>(payload: any): T[] {
  return Array.isArray(payload) ? payload : (payload?.data ?? []);
}
function toTotal(payload: any): number {
  if (Array.isArray(payload)) return payload.length;
  if (typeof payload?.total === "number") return payload.total;
  const arr = payload?.data;
  return Array.isArray(arr) ? arr.length : 0;
}
const firstText = (...cands: (string | null | undefined)[]) =>
  cands.find((v) => typeof v === "string" && v.trim().length > 0)?.trim();

/** Raw row from API/Supabase can be snake_case. */
type CustomerRaw = Record<string, any>;

/** View model used by UI after mapping. */
type CustomerVM = {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  status?: string;
  diets: string[];
  allergens: string[];
  conditions: string[];
};

function mapCustomer(raw: CustomerRaw): CustomerVM {
  // Prefer id, then fallback to uuid/external_id if needed
  const id =
    raw.id ??
    raw.uuid ??
    raw.customer_id ??
    raw.external_id ??
    crypto.randomUUID();

  // Robust name resolution:
  const name =
    firstText(
      raw.name,
      raw.full_name,
      raw.fullName,
      raw.display_name,
      raw.displayName,
      raw.profile_name,
      raw.customer_name,
      raw.full_name_text,
      raw.fullname,
      raw.first_name && raw.last_name
        ? `${raw.first_name} ${raw.last_name}`
        : undefined,
      raw.firstName && raw.lastName ? `${raw.firstName} ${raw.lastName}` : undefined
    ) ?? "Unnamed";

  // Common email/phone keys
  const email =
    firstText(raw.email, raw.email_address, raw.contact_email) ?? undefined;
  const phone = firstText(raw.phone, raw.phone_number, raw.contact_phone) ?? undefined;

  // Status may be on different keys
  const status =
    firstText(raw.status, raw.customer_status, raw.state, raw.activity_status) ??
    "active";

  // Tag arrays (fallback to [])
  const diets = Array.isArray(raw.diets) ? raw.diets : Array.isArray(raw.diet) ? raw.diet : [];
  const allergens = Array.isArray(raw.allergens)
    ? raw.allergens
    : Array.isArray(raw.allergen_tags)
    ? raw.allergen_tags
    : [];
  const conditions = Array.isArray(raw.conditions)
    ? raw.conditions
    : Array.isArray(raw.health_conditions)
    ? raw.health_conditions
    : [];

  return { id, name, email, phone, status, diets, allergens, conditions };
}

export default function Customers() {
  const [searchQuery, setSearchQuery] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["/customers", { q: searchQuery }],
  });

  const items = toItems<CustomerRaw>(data).map(mapCustomer);
  const total = toTotal(data);
  const hasData = items.length > 0;

  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <TopBar
          title="Customer Management"
          subtitle="Manage customer profiles and health data"
        />

        <div className="p-6 space-y-6">
          {/* Header */}
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-2xl font-semibold text-gray-900">Customers</h2>
              <p className="text-sm text-gray-500">
                {total} customer {total === 1 ? "profile" : "profiles"}
              </p>
            </div>

            <div className="flex gap-2">
              <Button variant="outline">
                <Download className="w-4 h-4 mr-2" />
                Export
              </Button>
              <Button>
                <Upload className="w-4 h-4 mr-2" />
                Import CSV
              </Button>
            </div>
          </div>

          {/* Search / Filters */}
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                  placeholder="Search customers by name or email..."
                  className="pl-9"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <Button variant="outline">
                <Filter className="w-4 h-4 mr-2" />
                Filters
              </Button>
            </CardContent>
          </Card>

          {/* Grid / Empty */}
          {isLoading ? (
            <div className="text-sm text-gray-500 px-1">Loading customers…</div>
          ) : hasData ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((c) => (
                <Card key={c.id} data-testid="card-customer">
                  <CardHeader className="space-y-1">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base">{c.name}</CardTitle>
                      <Badge variant="secondary">
                        <Users className="w-3 h-3 mr-1" />
                        {c.status}
                      </Badge>
                    </div>
                    {c.email ? (
                      <div className="text-xs text-gray-500">{c.email}</div>
                    ) : null}
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div className="flex flex-wrap gap-1">
                      {c.diets.slice(0, 2).map((t) => (
                        <Badge key={`diet-${c.id}-${t}`} variant="outline">
                          {t}
                        </Badge>
                      ))}
                      {c.allergens.slice(0, 2).map((t) => (
                        <Badge key={`allergen-${c.id}-${t}`} variant="destructive">
                          {t}
                        </Badge>
                      ))}
                      {c.conditions.slice(0, 2).map((t) => (
                        <Badge key={`cond-${c.id}-${t}`} variant="secondary">
                          {t}
                        </Badge>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <Button asChild size="sm" variant="outline">
                        <a href={`/customers/${c.id}`}>Details</a>
                      </Button>
                      <Button asChild size="sm" variant="ghost">
                        <a href={`/matching/${c.id}`}>
                          <Heart className="w-4 h-4 mr-1" />
                          Matches
                        </a>
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <div
              className="text-center py-16 border rounded-md bg-white"
              data-testid="empty-customers"
            >
              <div className="mx-auto mb-2 w-10 h-10 grid place-items-center rounded-full bg-gray-100">
                <Users className="w-5 h-5 text-gray-500" />
              </div>
              <h3 className="text-base font-medium">No customers found</h3>
              <p className="text-gray-600 mb-4">
                {searchQuery
                  ? "Try adjusting your search criteria."
                  : "Start by importing your customer database."}
              </p>
              <Button data-testid="button-import-first-customers">
                <Upload className="w-4 h-4 mr-2" />
                Import Customer Data
              </Button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
