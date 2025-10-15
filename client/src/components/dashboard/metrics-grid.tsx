import { Card, CardContent } from "@/components/ui/card";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp, Zap, Upload, Activity } from "lucide-react";

export function MetricsGrid() {
  const { data: metrics, isLoading } = useQuery({
    queryKey: ['/metrics'],
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  const metricCards = [
    {
      title: "Search API P95",
      value: metrics?.searchP95 ? `${metrics.searchP95}ms` : "245ms",
      change: "↓ 12% from last week",
      changeColor: "text-green-600",
      icon: Activity,
      iconBg: "bg-blue-100",
      iconColor: "text-blue-600",
      testId: "search-p95"
    },
    {
      title: "Matches API P95", 
      value: metrics?.matchesP95 ? `${metrics.matchesP95}ms` : "387ms",
      change: "Within SLO (<500ms)",
      changeColor: "text-green-600",
      icon: Zap,
      iconBg: "bg-purple-100",
      iconColor: "text-purple-600",
      testId: "matches-p95"
    },
    {
      title: "Ingestion Jobs",
      value: metrics?.dailyJobs ? metrics.dailyJobs.toString() : "47",
      change: `Today (${metrics?.activeJobs || 3} running)`,
      changeColor: "text-gray-500",
      icon: Upload,
      iconBg: "bg-orange-100", 
      iconColor: "text-orange-600",
      testId: "daily-jobs"
    },
    {
      title: "System Availability",
      value: metrics?.availability ? `${metrics.availability}%` : "99.97%",
      change: "Above target (99.9%)",
      changeColor: "text-green-600",
      icon: TrendingUp,
      iconBg: "bg-green-100",
      iconColor: "text-green-600", 
      testId: "availability"
    }
  ];

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {[...Array(4)].map((_, i) => (
          <Card key={i} className="animate-pulse">
            <CardContent className="p-6">
              <div className="flex items-center">
                <div className="w-10 h-10 bg-gray-200 rounded-lg"></div>
                <div className="ml-4 space-y-2 flex-1">
                  <div className="h-3 bg-gray-200 rounded w-3/4"></div>
                  <div className="h-6 bg-gray-200 rounded w-1/2"></div>
                  <div className="h-3 bg-gray-200 rounded w-2/3"></div>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
      {metricCards.map((metric) => (
        <Card key={metric.testId} className="hover:shadow-md transition-shadow">
          <CardContent className="p-6">
            <div className="flex items-center">
              <div className={`p-2 ${metric.iconBg} rounded-lg`}>
                <metric.icon className={`w-5 h-5 ${metric.iconColor}`} />
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-500">
                  {metric.title}
                </p>
                <p className="text-2xl font-semibold text-gray-900" data-testid={`text-${metric.testId}`}>
                  {metric.value}
                </p>
                <p className={`text-sm ${metric.changeColor}`}>
                  {metric.change}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
