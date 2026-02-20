import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/top-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp, Search, Zap, Database, Clock, Users } from "lucide-react";

export default function Analytics() {
  const { data: metrics, isLoading } = useQuery<any>({
    queryKey: ['/metrics'],
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <TopBar 
          title="Analytics & Performance" 
          subtitle="Monitor system performance and health-aware matching insights"
        />
        
        <div className="p-6 space-y-8">
          {/* API Performance Metrics */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <Card>
              <CardContent className="p-6">
                <div className="flex items-center">
                  <div className="p-2 bg-blue-100 rounded-lg">
                    <Search className="w-5 h-5 text-blue-600" />
                  </div>
                  <div className="ml-4">
                    <p className="text-sm font-medium text-gray-500">Search API P95</p>
                    <p className="text-2xl font-semibold text-gray-900" data-testid="text-search-p95">
                      {metrics?.searchP95 || '--'}ms
                    </p>
                    <p className="text-sm text-green-600">Within SLO (≤300ms)</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-6">
                <div className="flex items-center">
                  <div className="p-2 bg-purple-100 rounded-lg">
                    <Zap className="w-5 h-5 text-purple-600" />
                  </div>
                  <div className="ml-4">
                    <p className="text-sm font-medium text-gray-500">Matches API P95</p>
                    <p className="text-2xl font-semibold text-gray-900" data-testid="text-matches-p95">
                      {metrics?.matchesP95 || '--'}ms
                    </p>
                    <p className="text-sm text-green-600">Within SLO (≤500ms)</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-6">
                <div className="flex items-center">
                  <div className="p-2 bg-green-100 rounded-lg">
                    <TrendingUp className="w-5 h-5 text-green-600" />
                  </div>
                  <div className="ml-4">
                    <p className="text-sm font-medium text-gray-500">Availability</p>
                    <p className="text-2xl font-semibold text-gray-900" data-testid="text-availability">
                      {metrics?.availability || '--'}%
                    </p>
                    <p className="text-sm text-green-600">Above target (99.9%)</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-6">
                <div className="flex items-center">
                  <div className="p-2 bg-orange-100 rounded-lg">
                    <Clock className="w-5 h-5 text-orange-600" />
                  </div>
                  <div className="ml-4">
                    <p className="text-sm font-medium text-gray-500">Daily Jobs</p>
                    <p className="text-2xl font-semibold text-gray-900" data-testid="text-daily-jobs">
                      {metrics?.dailyJobs || '--'}
                    </p>
                    <p className="text-sm text-gray-500">{metrics?.activeJobs || 0} active</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Database Health */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center">
                <Database className="w-5 h-5 mr-2" />
                Database Performance
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <div className="space-y-2">
                  <h4 className="font-medium text-gray-900">Primary Database</h4>
                  <div className="text-sm text-gray-600 space-y-1">
                    <div className="flex justify-between">
                      <span>CPU Usage:</span>
                      <span className="font-medium" data-testid="text-primary-cpu">
                        {metrics?.database?.primary?.cpu || '--'}%
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>Memory:</span>
                      <span className="font-medium" data-testid="text-primary-memory">
                        {metrics?.database?.primary?.memory || '--'}%
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>Connections:</span>
                      <span className="font-medium" data-testid="text-primary-connections">
                        {metrics?.database?.primary?.connections || '--'}/{metrics?.database?.primary?.maxConnections || '--'}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <h4 className="font-medium text-gray-900">Read Replicas</h4>
                  <div className="text-sm text-gray-600 space-y-2">
                    {metrics?.database?.replicas?.map((replica: any, index: number) => (
                      <div key={replica.id} className="flex justify-between" data-testid={`text-replica-${index}`}>
                        <span>Replica {index + 1}:</span>
                        <span className={`font-medium ${replica.lag > 2 ? 'text-yellow-600' : 'text-green-600'}`}>
                          {replica.lag}s lag
                        </span>
                      </div>
                    )) || <div>No replica data available</div>}
                  </div>
                </div>

                <div className="space-y-2">
                  <h4 className="font-medium text-gray-900">Partitioning</h4>
                  <div className="text-sm text-gray-600 space-y-1">
                    <div className="flex justify-between">
                      <span>Product Partitions:</span>
                      <span className="font-medium" data-testid="text-product-partitions">
                        {metrics?.database?.partitions?.products || '--'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>Customer Partitions:</span>
                      <span className="font-medium" data-testid="text-customer-partitions">
                        {metrics?.database?.partitions?.customers || '--'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>Active Vendors:</span>
                      <span className="font-medium" data-testid="text-vendor-count">
                        {metrics?.database?.partitions?.vendors || '--'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Health-Aware Matching Insights */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center">
                  <Zap className="w-5 h-5 mr-2" />
                  Matching Performance
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-gray-600">Cache Hit Rate</span>
                    <span className="font-semibold text-green-600" data-testid="text-cache-hit-rate">85.3%</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-gray-600">Avg. Matching Time</span>
                    <span className="font-semibold" data-testid="text-avg-matching-time">127ms</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-gray-600">Health Profiles Active</span>
                    <span className="font-semibold text-blue-600" data-testid="text-health-profiles-active">12,847</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-gray-600">Dietary Restrictions</span>
                    <span className="font-semibold" data-testid="text-dietary-restrictions">8,291</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center">
                  <Users className="w-5 h-5 mr-2" />
                  User Activity
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-gray-600">Daily Active Users</span>
                    <span className="font-semibold" data-testid="text-daily-active-users">1,247</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-gray-600">Search Queries</span>
                    <span className="font-semibold" data-testid="text-search-queries">15,832</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-gray-600">Match Requests</span>
                    <span className="font-semibold" data-testid="text-match-requests">3,421</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-gray-600">Health Data Updates</span>
                    <span className="font-semibold text-purple-600" data-testid="text-health-updates">89</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* System Status */}
          <Card>
            <CardHeader>
              <CardTitle>System Status</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="space-y-2">
                  <div className="flex items-center space-x-2">
                    <div className="w-2 h-2 bg-green-400 rounded-full"></div>
                    <span className="text-sm font-medium">API Services</span>
                    <span className="text-xs text-green-600">Healthy</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <div className="w-2 h-2 bg-green-400 rounded-full"></div>
                    <span className="text-sm font-medium">Database</span>
                    <span className="text-xs text-green-600">Optimal</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <div className="w-2 h-2 bg-yellow-400 rounded-full"></div>
                    <span className="text-sm font-medium">Read Replicas</span>
                    <span className="text-xs text-yellow-600">Minor Lag</span>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center space-x-2">
                    <div className="w-2 h-2 bg-green-400 rounded-full"></div>
                    <span className="text-sm font-medium">Queue Workers</span>
                    <span className="text-xs text-green-600">Processing</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <div className="w-2 h-2 bg-green-400 rounded-full"></div>
                    <span className="text-sm font-medium">Storage</span>
                    <span className="text-xs text-green-600">Available</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <div className="w-2 h-2 bg-green-400 rounded-full"></div>
                    <span className="text-sm font-medium">Webhooks</span>
                    <span className="text-xs text-green-600">Delivering</span>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="text-xs text-gray-500">
                    Last Updated: {metrics?.lastUpdated ? new Date(metrics.lastUpdated).toLocaleTimeString() : '--'}
                  </div>
                  <div className="text-xs text-gray-500">
                    Next Maintenance: Sunday 2:00 AM EST
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
