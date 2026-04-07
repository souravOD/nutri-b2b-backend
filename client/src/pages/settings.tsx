import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/top-bar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ChevronRight, Database, FileText, ShieldCheck } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";

const SETTINGS_KEYS = {
  organizationName: "general.organization_name",
  domain: "general.domain",
  defaultTimezone: "general.default_timezone",
  autoMatching: "general.auto_matching",
  emailNotifications: "general.email_notifications",
  dataRetention: "general.data_retention",
  // Integrations
  usdaConnected: "integrations.usda_connected",
  nutritionLabelConnected: "integrations.nutrition_label_connected",
  complianceConnected: "integrations.compliance_connected",
  webhookUrl: "integrations.webhook_url",
  webhookEvents: "integrations.webhook_events",
} as const;

const WEBHOOK_EVENT_OPTIONS = [
  { id: "product.match_found", label: "Product Match Found" },
  { id: "import.completed", label: "Import Completed" },
  { id: "compliance.alert", label: "Compliance Alert" },
] as const;

const TIMEZONES = [
  { value: "America/New_York", label: "Eastern Time (EST)" },
  { value: "America/Los_Angeles", label: "Pacific Time (PST)" },
  { value: "America/Chicago", label: "Central Time (CST)" },
  { value: "America/Denver", label: "Mountain Time (MST)" },
  { value: "UTC", label: "UTC" },
];

function getSettingValue(settings: Record<string, { value: unknown }> | undefined, key: string): unknown {
  return settings?.[key]?.value;
}

export default function Configuration() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["/api/settings"],
    queryFn: () => api.getSettings(),
  });

  const settings = data?.settings ?? {};
  const [orgName, setOrgName] = useState("");
  const [domain, setDomain] = useState("");
  const [timezone, setTimezone] = useState("America/New_York");
  const [autoMatching, setAutoMatching] = useState(true);
  const [emailNotifications, setEmailNotifications] = useState(true);
  const [dataRetention, setDataRetention] = useState(false);
  // Integrations
  const [usdaConnected, setUsdaConnected] = useState(true);
  const [nutritionLabelConnected, setNutritionLabelConnected] = useState(false);
  const [complianceConnected, setComplianceConnected] = useState(true);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookEvents, setWebhookEvents] = useState<string[]>(["product.match_found", "import.completed"]);

  useEffect(() => {
    if (isLoading) return;
    if (settings && Object.keys(settings).length > 0) {
      setOrgName(String(getSettingValue(settings, SETTINGS_KEYS.organizationName) ?? ""));
      setDomain(String(getSettingValue(settings, SETTINGS_KEYS.domain) ?? ""));
      setTimezone(String(getSettingValue(settings, SETTINGS_KEYS.defaultTimezone) ?? "America/New_York"));
      setAutoMatching(Boolean(getSettingValue(settings, SETTINGS_KEYS.autoMatching) ?? true));
      setEmailNotifications(Boolean(getSettingValue(settings, SETTINGS_KEYS.emailNotifications) ?? true));
      setDataRetention(Boolean(getSettingValue(settings, SETTINGS_KEYS.dataRetention) ?? false));
      const evts = getSettingValue(settings, SETTINGS_KEYS.webhookEvents);
      if (Array.isArray(evts)) setWebhookEvents(evts.map(String));
      setUsdaConnected(Boolean(getSettingValue(settings, SETTINGS_KEYS.usdaConnected) ?? true));
      setNutritionLabelConnected(Boolean(getSettingValue(settings, SETTINGS_KEYS.nutritionLabelConnected) ?? false));
      setComplianceConnected(Boolean(getSettingValue(settings, SETTINGS_KEYS.complianceConnected) ?? true));
      setWebhookUrl(String(getSettingValue(settings, SETTINGS_KEYS.webhookUrl) ?? ""));
    } else if (!error) {
      setOrgName("Odyssey Nutrition");
      setDomain("odysseynutrition.com");
      setTimezone("America/New_York");
      setAutoMatching(true);
      setEmailNotifications(true);
      setDataRetention(false);
      setWebhookEvents(["product.match_found", "import.completed"]);
      setWebhookUrl("");
    }
  }, [settings, isLoading, error]);

  const saveOrgMutation = useMutation({
    mutationFn: async () => {
      await Promise.all([
        api.putSetting(SETTINGS_KEYS.organizationName, orgName),
        api.putSetting(SETTINGS_KEYS.domain, domain),
        api.putSetting(SETTINGS_KEYS.defaultTimezone, timezone),
      ]);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: "Organization settings saved", description: "Your changes have been saved." });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    },
  });

  const savePrefsMutation = useMutation({
    mutationFn: async () => {
      await Promise.all([
        api.putSetting(SETTINGS_KEYS.autoMatching, autoMatching),
        api.putSetting(SETTINGS_KEYS.emailNotifications, emailNotifications),
        api.putSetting(SETTINGS_KEYS.dataRetention, dataRetention),
      ]);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: "Preferences saved", description: "Your preferences have been saved." });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    },
  });

  const toggleIntegrationMutation = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: boolean }) => {
      await api.putSetting(key, value);
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      if (variables.key === SETTINGS_KEYS.usdaConnected) setUsdaConnected(variables.value);
      else if (variables.key === SETTINGS_KEYS.nutritionLabelConnected) setNutritionLabelConnected(variables.value);
      else if (variables.key === SETTINGS_KEYS.complianceConnected) setComplianceConnected(variables.value);
      toast({ title: "Integration updated", description: "Connection status saved." });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    },
  });

  const saveWebhookMutation = useMutation({
    mutationFn: async () => {
      await Promise.all([
        api.putSetting(SETTINGS_KEYS.webhookUrl, webhookUrl),
        api.putSetting(SETTINGS_KEYS.webhookEvents, webhookEvents),
      ]);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: "Webhook saved", description: "Your webhook configuration has been saved." });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    },
  });

  const [, setLocation] = useLocation();

  const toggleWebhookEvent = (eventId: string) => {
    setWebhookEvents((prev) =>
      prev.includes(eventId) ? prev.filter((e) => e !== eventId) : [...prev, eventId]
    );
  };

  return (
    <div className="flex min-h-screen bg-[#f8fafc]">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <TopBar
          title="Settings"
          subtitle="Manage your organization preferences and configurations."
        />

        <div className="p-10 space-y-8">
          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-800" data-testid="settings-error">
              Failed to load settings. Please try again.
            </div>
          )}
          {/* Breadcrumbs */}
          <div className="flex gap-2 items-center" data-testid="breadcrumbs">
            <Link href="/" className="text-sm font-medium text-[#64748b] hover:text-[#0f172a]">
              Portal
            </Link>
            <ChevronRight className="w-4 h-4 text-[#64748b]" />
            <span className="text-sm font-medium text-[#0f172a]">Settings</span>
          </div>

          <Tabs defaultValue="general" className="space-y-8">
            <TabsList className="inline-flex h-auto p-0 gap-8 border-b border-[#e2e8f0] bg-transparent rounded-none">
              <TabsTrigger
                value="general"
                className="rounded-none border-b-2 border-transparent bg-transparent px-0 pb-5 pt-4 text-sm font-medium text-[#64748b] data-[state=active]:border-[#00438f] data-[state=active]:text-[#00438f] data-[state=active]:font-bold"
              >
                General
              </TabsTrigger>
              <TabsTrigger
                value="integrations"
                className="rounded-none border-b-2 border-transparent bg-transparent px-0 pb-5 pt-4 text-sm font-medium text-[#64748b] data-[state=active]:border-[#00438f] data-[state=active]:text-[#00438f] data-[state=active]:font-bold"
              >
                Integrations
              </TabsTrigger>
              <TabsTrigger
                value="role-permissions"
                className="rounded-none border-b-2 border-transparent bg-transparent px-0 pb-5 pt-4 text-sm font-medium text-[#64748b] data-[state=active]:border-[#00438f] data-[state=active]:text-[#00438f] data-[state=active]:font-bold"
              >
                Role Permissions
              </TabsTrigger>
              <TabsTrigger
                value="data-storage"
                className="rounded-none border-b-2 border-transparent bg-transparent px-0 pb-5 pt-4 text-sm font-medium text-[#64748b] data-[state=active]:border-[#00438f] data-[state=active]:text-[#00438f] data-[state=active]:font-bold"
              >
                Data & Storage
              </TabsTrigger>
              <TabsTrigger
                value="security"
                className="rounded-none border-b-2 border-transparent bg-transparent px-0 pb-5 pt-4 text-sm font-medium text-[#64748b] data-[state=active]:border-[#00438f] data-[state=active]:text-[#00438f] data-[state=active]:font-bold"
              >
                Security
              </TabsTrigger>
            </TabsList>

            <TabsContent value="general" className="space-y-8 mt-0">
              {/* Organization Settings */}
              <Card className="border border-[#e2e8f0] rounded-xl shadow-[0px_1px_2px_0px_rgba(0,0,0,0.05)]">
                <CardHeader className="border-b border-[#f1f5f9] pb-6 pt-6">
                  <CardTitle className="text-lg font-bold text-[#0f172a]">
                    Organization Settings
                  </CardTitle>
                  <CardDescription className="text-sm text-[#64748b]">
                    Basic information about your organization
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-6 space-y-6">
                  <div className="grid grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <Label htmlFor="org-name" className="text-sm font-semibold text-[#334155]">
                        Organization Name
                      </Label>
                      <Input
                        id="org-name"
                        value={orgName}
                        onChange={(e) => setOrgName(e.target.value)}
                        className="border-[#cbd5e1]"
                        disabled={isLoading}
                        data-testid="input-organization-name"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="domain" className="text-sm font-semibold text-[#334155]">
                        Domain
                      </Label>
                      <div className="relative">
                        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm text-[#94a3b8]">
                          https://
                        </span>
                        <Input
                          id="domain"
                          value={domain}
                          onChange={(e) => setDomain(e.target.value)}
                          className="pl-[65px] border-[#cbd5e1]"
                          placeholder="example.com"
                          disabled={isLoading}
                          data-testid="input-domain"
                        />
                      </div>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="timezone" className="text-sm font-semibold text-[#334155]">
                      Default Timezone
                    </Label>
                    <Select value={timezone} onValueChange={setTimezone}>
                      <SelectTrigger data-testid="select-timezone" className="border-[#cbd5e1]" disabled={isLoading}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TIMEZONES.map((tz) => (
                          <SelectItem key={tz.value} value={tz.value}>
                            {tz.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex justify-end pt-4">
                    <Button
                      onClick={() => saveOrgMutation.mutate()}
                      disabled={saveOrgMutation.isPending}
                      className="bg-[#00438f] hover:bg-[#003366]"
                      data-testid="button-save-org"
                    >
                      {saveOrgMutation.isPending ? "Saving..." : "Save Changes"}
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* System Preferences */}
              <Card className="border border-[#e2e8f0] rounded-xl shadow-[0px_1px_2px_0px_rgba(0,0,0,0.05)]">
                <CardHeader className="border-b border-[#f1f5f9] pb-6 pt-6">
                  <CardTitle className="text-lg font-bold text-[#0f172a]">
                    System Preferences
                  </CardTitle>
                  <CardDescription className="text-sm text-[#64748b]">
                    Configure system-wide behavior and defaults
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-6 space-y-0">
                  <div className="flex items-center justify-between py-4">
                    <div>
                      <Label className="text-sm font-bold text-[#0f172a]">Auto-matching</Label>
                      <p className="text-xs text-[#64748b] mt-0.5">
                        Automatically run product matching for new imports
                      </p>
                    </div>
                    <Switch
                      checked={autoMatching}
                      onCheckedChange={setAutoMatching}
                      data-testid="switch-auto-matching"
                    />
                  </div>
                  <div className="flex items-center justify-between py-4 border-t border-[#f1f5f9]">
                    <div>
                      <Label className="text-sm font-bold text-[#0f172a]">Email Notifications</Label>
                      <p className="text-xs text-[#64748b] mt-0.5">
                        Send system notifications via email
                      </p>
                    </div>
                    <Switch
                      checked={emailNotifications}
                      onCheckedChange={setEmailNotifications}
                      data-testid="switch-email-notifications"
                    />
                  </div>
                  <div className="flex items-center justify-between py-4 border-t border-[#f1f5f9]">
                    <div>
                      <Label className="text-sm font-bold text-[#0f172a]">Data Retention</Label>
                      <p className="text-xs text-[#64748b] mt-0.5">
                        Automatically archive old data after 2 years
                      </p>
                    </div>
                    <Switch
                      checked={dataRetention}
                      onCheckedChange={setDataRetention}
                      data-testid="switch-data-retention"
                    />
                  </div>
                  <div className="flex justify-end pt-4">
                    <Button
                      onClick={() => savePrefsMutation.mutate()}
                      disabled={savePrefsMutation.isPending}
                      className="bg-[#00438f] hover:bg-[#003366]"
                      data-testid="button-save-preferences"
                    >
                      {savePrefsMutation.isPending ? "Saving..." : "Save Preferences"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="integrations" className="mt-0 space-y-8">
              {/* API Integrations Card */}
              <Card className="border border-[#e2e8f0] rounded-xl shadow-[0px_1px_2px_0px_rgba(0,0,0,0.05)]">
                <CardHeader className="border-b border-[#f1f5f9] pb-6 pt-6">
                  <CardTitle className="text-lg font-bold text-[#0f172a]">
                    API Integrations
                  </CardTitle>
                  <CardDescription className="text-sm text-[#64748b]">
                    Manage external API connections and webhooks
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  {/* USDA Food Data Central */}
                  <div className="flex items-center justify-between p-6 border-b border-[#f1f5f9]">
                    <div className="flex gap-4 items-center">
                      <div className="h-12 w-12 rounded-lg bg-[rgba(0,67,143,0.05)] flex items-center justify-center">
                        <Database className="h-6 w-6 text-[#00438f]" />
                      </div>
                      <div>
                        <p className="text-sm font-bold text-[#0f172a]">USDA Food Data Central</p>
                        <p className="text-xs text-[#64748b]">Nutrition data API integration</p>
                      </div>
                    </div>
                    <div className="flex gap-6 items-center">
                      {usdaConnected ? (
                        <>
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#d1fae5] text-[#065f46] text-xs font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-[#10b981]" />
                            Connected
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            className="border-[#00438f] text-[#00438f] hover:bg-[#00438f]/5"
                            onClick={() => setLocation("/connectors")}
                            data-testid="button-configure-usda"
                          >
                            Configure
                          </Button>
                        </>
                      ) : (
                        <>
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#f1f5f9] text-[#475569] text-xs font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-[#94a3b8]" />
                            Disconnected
                          </span>
                          <Button
                            size="sm"
                            className="bg-[#00438f] hover:bg-[#003366]"
                            onClick={() =>
                              toggleIntegrationMutation.mutate({
                                key: SETTINGS_KEYS.usdaConnected,
                                value: true,
                              })
                            }
                            disabled={toggleIntegrationMutation.isPending}
                            data-testid="button-connect-usda"
                          >
                            Connect
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                  {/* Nutrition Label API */}
                  <div className="flex items-center justify-between p-6 border-b border-[#f1f5f9]">
                    <div className="flex gap-4 items-center">
                      <div
                        className={`h-12 w-12 rounded-lg flex items-center justify-center ${
                          nutritionLabelConnected ? "bg-[rgba(0,67,143,0.05)]" : "bg-[#f1f5f9]"
                        }`}
                      >
                        <FileText
                          className={`h-5 w-5 ${nutritionLabelConnected ? "text-[#00438f]" : "text-[#64748b]"}`}
                        />
                      </div>
                      <div>
                        <p className="text-sm font-bold text-[#0f172a]">Nutrition Label API</p>
                        <p className="text-xs text-[#64748b]">Automated label generation service</p>
                      </div>
                    </div>
                    <div className="flex gap-6 items-center">
                      {nutritionLabelConnected ? (
                        <>
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#d1fae5] text-[#065f46] text-xs font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-[#10b981]" />
                            Connected
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            className="border-[#00438f] text-[#00438f] hover:bg-[#00438f]/5"
                            onClick={() => setLocation("/connectors")}
                            data-testid="button-configure-nutrition-label"
                          >
                            Configure
                          </Button>
                        </>
                      ) : (
                        <>
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#f1f5f9] text-[#475569] text-xs font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-[#94a3b8]" />
                            Disconnected
                          </span>
                          <Button
                            size="sm"
                            className="bg-[#00438f] hover:bg-[#003366]"
                            onClick={() =>
                              toggleIntegrationMutation.mutate({
                                key: SETTINGS_KEYS.nutritionLabelConnected,
                                value: true,
                              })
                            }
                            disabled={toggleIntegrationMutation.isPending}
                            data-testid="button-connect-nutrition-label"
                          >
                            Connect
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                  {/* Compliance Checker */}
                  <div className="flex items-center justify-between p-6">
                    <div className="flex gap-4 items-center">
                      <div
                        className={`h-12 w-12 rounded-lg flex items-center justify-center ${
                          complianceConnected ? "bg-[rgba(0,67,143,0.05)]" : "bg-[#f1f5f9]"
                        }`}
                      >
                        <ShieldCheck
                          className={`h-6 w-6 ${complianceConnected ? "text-[#00438f]" : "text-[#64748b]"}`}
                        />
                      </div>
                      <div>
                        <p className="text-sm font-bold text-[#0f172a]">Compliance Checker</p>
                        <p className="text-xs text-[#64748b]">Regulatory compliance validation</p>
                      </div>
                    </div>
                    <div className="flex gap-6 items-center">
                      {complianceConnected ? (
                        <>
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#d1fae5] text-[#065f46] text-xs font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-[#10b981]" />
                            Connected
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            className="border-[#00438f] text-[#00438f] hover:bg-[#00438f]/5"
                            onClick={() => setLocation("/connectors")}
                            data-testid="button-configure-compliance"
                          >
                            Configure
                          </Button>
                        </>
                      ) : (
                        <>
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#f1f5f9] text-[#475569] text-xs font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-[#94a3b8]" />
                            Disconnected
                          </span>
                          <Button
                            size="sm"
                            className="bg-[#00438f] hover:bg-[#003366]"
                            onClick={() =>
                              toggleIntegrationMutation.mutate({
                                key: SETTINGS_KEYS.complianceConnected,
                                value: true,
                              })
                            }
                            disabled={toggleIntegrationMutation.isPending}
                            data-testid="button-connect-compliance"
                          >
                            Connect
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Webhooks Card */}
              <Card className="border border-[#e2e8f0] rounded-xl shadow-[0px_1px_2px_0px_rgba(0,0,0,0.05)]">
                <CardHeader className="border-b border-[#f1f5f9] pb-6 pt-6">
                  <CardTitle className="text-lg font-bold text-[#0f172a]">
                    Webhooks
                  </CardTitle>
                  <CardDescription className="text-sm text-[#64748b]">
                    Configure webhook endpoints for real-time notifications
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-6 space-y-6">
                  <div className="space-y-2">
                    <Label htmlFor="webhook-url" className="text-sm font-bold text-[#0f172a]">
                      Webhook URL
                    </Label>
                    <Input
                      id="webhook-url"
                      value={webhookUrl}
                      onChange={(e) => setWebhookUrl(e.target.value)}
                      placeholder="https://your-app.com/webhook"
                      className="border-[#cbd5e1] max-w-[672px]"
                      disabled={isLoading}
                      data-testid="input-webhook-url"
                    />
                  </div>
                  <div className="space-y-4">
                    <div className="text-sm font-bold text-[#0f172a]">Events</div>
                    <div className="flex flex-col gap-3">
                      {WEBHOOK_EVENT_OPTIONS.map((opt) => (
                        <div
                          key={opt.id}
                          className="flex items-center gap-3"
                          data-testid={`checkbox-event-${opt.id}`}
                        >
                          <Checkbox
                            id={opt.id}
                            checked={webhookEvents.includes(opt.id)}
                            onCheckedChange={() => toggleWebhookEvent(opt.id)}
                            disabled={isLoading}
                            className="border-[#cbd5e1] data-[state=checked]:bg-[#00438f] data-[state=checked]:border-[#00438f]"
                          />
                          <Label
                            htmlFor={opt.id}
                            className="text-sm font-medium text-[#334155] cursor-pointer"
                          >
                            {opt.label}
                          </Label>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="pt-4">
                    <Button
                      onClick={() => saveWebhookMutation.mutate()}
                      disabled={saveWebhookMutation.isPending || isLoading}
                      className="bg-[#00438f] hover:bg-[#003366]"
                      data-testid="button-add-webhook"
                    >
                      {saveWebhookMutation.isPending ? "Saving..." : "Add Webhook"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="role-permissions" className="mt-0">
              <Card className="border border-[#e2e8f0] rounded-xl">
                <CardHeader>
                  <CardTitle>Role Permissions</CardTitle>
                  <CardDescription>Manage role-based access (placeholder)</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-[#64748b]">Content coming soon.</p>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="data-storage" className="mt-0">
              <Card className="border border-[#e2e8f0] rounded-xl">
                <CardHeader>
                  <CardTitle>Data & Storage</CardTitle>
                  <CardDescription>Data retention and storage settings (placeholder)</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-[#64748b]">Content coming soon.</p>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="security" className="mt-0">
              <Card className="border border-[#e2e8f0] rounded-xl">
                <CardHeader>
                  <CardTitle>Security</CardTitle>
                  <CardDescription>Security and compliance settings (placeholder)</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-[#64748b]">Content coming soon.</p>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </main>
    </div>
  );
}
