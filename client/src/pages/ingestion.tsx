import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/top-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useQuery } from "@tanstack/react-query";
import { Upload, Play, Pause, AlertCircle, CheckCircle, Clock, Download } from "lucide-react";

export default function Ingestion() {
  const { data: jobs, isLoading } = useQuery<any>({
    queryKey: ['/jobs'],
    refetchInterval: 5000, // Poll every 5 seconds for real-time updates
  });

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="w-4 h-4 text-green-600" />;
      case 'failed':
        return <AlertCircle className="w-4 h-4 text-red-600" />;
      case 'running':
        return <Play className="w-4 h-4 text-blue-600" />;
      case 'queued':
        return <Clock className="w-4 h-4 text-yellow-600" />;
      default:
        return <Pause className="w-4 h-4 text-gray-600" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'bg-green-100 text-green-800';
      case 'failed':
        return 'bg-red-100 text-red-800';
      case 'running':
        return 'bg-blue-100 text-blue-800';
      case 'queued':
        return 'bg-yellow-100 text-yellow-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <TopBar 
          title="Data Ingestion" 
          subtitle="Monitor CSV imports and API synchronization jobs"
        />
        
        <div className="p-6 space-y-6">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-2xl font-semibold text-gray-900">Ingestion Jobs</h2>
              <p className="text-sm text-gray-600">
                {jobs?.data?.filter((job: any) => job.status === 'running').length || 0} active jobs
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" data-testid="button-sync-api">
                <Play className="w-4 h-4 mr-2" />
                Start API Sync
              </Button>
              <Button data-testid="button-upload-csv">
                <Upload className="w-4 h-4 mr-2" />
                Upload CSV
              </Button>
            </div>
          </div>

          {/* Quick Stats */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center">
                  <div className="p-2 bg-blue-100 rounded-lg">
                    <Play className="w-5 h-5 text-blue-600" />
                  </div>
                  <div className="ml-3">
                    <p className="text-sm font-medium text-gray-500">Running</p>
                    <p className="text-xl font-semibold text-gray-900" data-testid="text-running-count">
                      {jobs?.data?.filter((job: any) => job.status === 'running').length || 0}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
            
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center">
                  <div className="p-2 bg-yellow-100 rounded-lg">
                    <Clock className="w-5 h-5 text-yellow-600" />
                  </div>
                  <div className="ml-3">
                    <p className="text-sm font-medium text-gray-500">Queued</p>
                    <p className="text-xl font-semibold text-gray-900" data-testid="text-queued-count">
                      {jobs?.data?.filter((job: any) => job.status === 'queued').length || 0}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
            
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center">
                  <div className="p-2 bg-green-100 rounded-lg">
                    <CheckCircle className="w-5 h-5 text-green-600" />
                  </div>
                  <div className="ml-3">
                    <p className="text-sm font-medium text-gray-500">Completed</p>
                    <p className="text-xl font-semibold text-gray-900" data-testid="text-completed-count">
                      {jobs?.data?.filter((job: any) => job.status === 'completed').length || 0}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
            
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center">
                  <div className="p-2 bg-red-100 rounded-lg">
                    <AlertCircle className="w-5 h-5 text-red-600" />
                  </div>
                  <div className="ml-3">
                    <p className="text-sm font-medium text-gray-500">Failed</p>
                    <p className="text-xl font-semibold text-gray-900" data-testid="text-failed-count">
                      {jobs?.data?.filter((job: any) => job.status === 'failed').length || 0}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Jobs List */}
          <Card>
            <CardHeader>
              <CardTitle>Recent Jobs</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="space-y-4">
                  {[...Array(5)].map((_, i) => (
                    <div key={i} className="animate-pulse flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                      <div className="flex items-center space-x-4">
                        <div className="w-8 h-8 bg-gray-200 rounded-lg"></div>
                        <div>
                          <div className="h-4 bg-gray-200 rounded w-32 mb-2"></div>
                          <div className="h-3 bg-gray-200 rounded w-24"></div>
                        </div>
                      </div>
                      <div className="w-32 h-2 bg-gray-200 rounded"></div>
                    </div>
                  ))}
                </div>
              ) : jobs?.data?.length === 0 ? (
                <div className="text-center py-8">
                  <Upload className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                  <h3 className="text-lg font-medium text-gray-900 mb-2">No ingestion jobs</h3>
                  <p className="text-gray-600 mb-4">Start by uploading a CSV file or configuring an API sync.</p>
                  <Button data-testid="button-start-first-job">
                    <Upload className="w-4 h-4 mr-2" />
                    Upload Your First CSV
                  </Button>
                </div>
              ) : (
                <div className="space-y-4">
                  {jobs?.data?.map((job: any) => (
                    <div key={job.id} className="flex items-center justify-between p-4 bg-gray-50 rounded-lg" data-testid={`row-job-${job.id}`}>
                      <div className="flex items-center space-x-4">
                        <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center shadow-sm">
                          {getStatusIcon(job.status)}
                        </div>
                        <div>
                          <div className="flex items-center space-x-2">
                            <h4 className="font-medium text-gray-900" data-testid={`text-job-type-${job.id}`}>
                              {job.mode === 'products' ? 'Products Import' : 'Customers Import'}
                            </h4>
                            <Badge className={`text-xs ${getStatusColor(job.status)}`} data-testid={`badge-status-${job.id}`}>
                              {job.status}
                            </Badge>
                          </div>
                          <p className="text-sm text-gray-500" data-testid={`text-job-time-${job.id}`}>
                            Started {new Date(job.created_at).toLocaleString()}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center space-x-4">
                        {job.status === 'running' && (
                          <div className="flex items-center space-x-2">
                            <div className="w-32">
                              <Progress value={job.progress_pct} className="h-2" data-testid={`progress-${job.id}`} />
                            </div>
                            <span className="text-sm font-medium text-gray-700" data-testid={`text-progress-${job.id}`}>
                              {job.progress_pct}%
                            </span>
                          </div>
                        )}

                        {job.totals && (
                          <div className="text-right text-sm text-gray-600" data-testid={`text-totals-${job.id}`}>
                            <div>Processed: {job.totals.processed || 0}</div>
                            <div>Succeeded: {job.totals.succeeded || 0}</div>
                            {job.totals.failed > 0 && (
                              <div className="text-red-600">Failed: {job.totals.failed}</div>
                            )}
                          </div>
                        )}

                        <div className="flex space-x-2">
                          <Button size="sm" variant="outline" data-testid={`button-view-${job.id}`}>
                            View Details
                          </Button>
                          {job.error_url && (
                            <Button size="sm" variant="outline" data-testid={`button-download-errors-${job.id}`}>
                              <Download className="w-4 h-4 mr-1" />
                              Errors
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
