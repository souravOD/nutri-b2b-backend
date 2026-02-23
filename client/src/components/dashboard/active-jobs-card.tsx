import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useQuery } from "@tanstack/react-query";
import { Building, AlertCircle } from "lucide-react";

export function ActiveJobsCard() {
  const { data: jobs, isLoading } = useQuery({
    queryKey: ['/jobs'],
    refetchInterval: 5000, // Poll every 5 seconds
  });

  const activeJobs = (jobs as any)?.data?.filter((job: any) =>
    ['running', 'failed'].includes(job.status)
  ) || [];

  const getJobIcon = (status: string) => {
    if (status === 'failed') {
      return <AlertCircle className="text-red-600 w-4 h-4" />;
    }
    return <Building className="text-blue-600 w-4 h-4" />;
  };

  const getJobBgColor = (status: string) => {
    if (status === 'failed') {
      return "bg-red-50 border-red-200";
    }
    return "bg-gray-50";
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Active Ingestion Jobs</CardTitle>
          <Badge
            className="bg-orange-100 text-orange-800"
            data-testid="badge-active-jobs-count"
          >
            {activeJobs.length} Running
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="animate-pulse flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 bg-gray-200 rounded-lg"></div>
                  <div className="space-y-2">
                    <div className="h-4 bg-gray-200 rounded w-32"></div>
                    <div className="h-3 bg-gray-200 rounded w-24"></div>
                  </div>
                </div>
                <div className="w-32 h-2 bg-gray-200 rounded"></div>
              </div>
            ))}
          </div>
        ) : activeJobs.length === 0 ? (
          <div className="text-center py-8">
            <Building className="w-8 h-8 text-gray-400 mx-auto mb-2" />
            <p className="text-sm text-gray-500">No active jobs</p>
          </div>
        ) : (
          <div className="space-y-4">
            {activeJobs.slice(0, 3).map((job: any) => (
              <div
                key={job.id}
                className={`flex items-center justify-between p-4 rounded-lg ${getJobBgColor(job.status)}`}
                data-testid={`card-active-job-${job.id}`}
              >
                <div className="flex items-center">
                  <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center shadow-sm">
                    {getJobIcon(job.status)}
                  </div>
                  <div className="ml-3">
                    <p className="text-sm font-medium text-gray-900" data-testid={`text-job-name-${job.id}`}>
                      {job.sourceName === 'products' ? 'Products CSV' : job.sourceName === 'customers' ? 'Customers CSV' : (job.sourceName || job.flowName || 'Ingestion')}
                    </p>
                    <p className="text-sm text-gray-500" data-testid={`text-job-details-${job.id}`}>
                      {job.status === 'failed'
                        ? `Failed • ${job.errorMessage || 'Processing error'}`
                        : `Started ${new Date(job.createdAt).toLocaleTimeString()}`
                      }
                    </p>
                  </div>
                </div>

                {job.status === 'running' && (
                  <div className="flex items-center">
                    <div className="w-32 bg-gray-200 rounded-full h-2 mr-3">
                      <div
                        className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                        style={{ width: `${job.progressPct || 0}%` }}
                        data-testid={`progress-${job.id}`}
                      />
                    </div>
                    <span className="text-sm font-medium text-gray-900" data-testid={`text-progress-${job.id}`}>
                      {job.progressPct || 0}%
                    </span>
                  </div>
                )}

                {job.status === 'failed' && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-red-600 hover:text-red-800"
                    data-testid={`button-view-errors-${job.id}`}
                  >
                    View Errors
                  </Button>
                )}
              </div>
            ))}

            <div className="text-center">
              <Button
                variant="ghost"
                size="sm"
                data-testid="button-view-all-jobs"
              >
                View All Jobs
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
