import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, CheckCircle, Clock } from "lucide-react";

export function DatabaseHealthCard() {
  const { data: metrics, isLoading } = useQuery<any>({
    queryKey: ['/metrics'],
    refetchInterval: 30000,
  });

  const database = metrics?.database;

  const getStatusIcon = (status: string, lag?: number) => {
    if (status === 'Healthy' && (!lag || lag < 2)) {
      return <CheckCircle className="w-4 h-4 text-green-500" />;
    }
    if (lag && lag > 2) {
      return <Clock className="w-4 h-4 text-yellow-500" />;
    }
    return <AlertCircle className="w-4 h-4 text-red-500" />;
  };

  const getStatusColor = (status: string, lag?: number) => {
    if (status === 'Healthy' && (!lag || lag < 2)) {
      return "text-green-600";
    }
    if (lag && lag > 2) {
      return "text-yellow-600";
    }
    return "text-red-600";
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Database Health</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-6">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="animate-pulse">
                <div className="h-4 bg-gray-200 rounded w-1/3 mb-2"></div>
                <div className="space-y-1">
                  <div className="h-3 bg-gray-200 rounded"></div>
                  <div className="h-3 bg-gray-200 rounded w-2/3"></div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-6">
            {/* Primary Database */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-700">Primary Database</span>
                <div className="flex items-center">
                  {getStatusIcon('Healthy')}
                  <span className="text-sm text-green-600 ml-2" data-testid="text-primary-status">
                    Healthy
                  </span>
                </div>
              </div>
              <div className="text-sm text-gray-500 space-y-1">
                <p>
                  CPU: <span data-testid="text-primary-cpu">{database?.primary?.cpu || 23}%</span> • Memory: <span data-testid="text-primary-memory">{database?.primary?.memory || 67}%</span>
                </p>
                <p data-testid="text-primary-connections">
                  Active connections: {database?.primary?.connections || 142}/{database?.primary?.maxConnections || 200}
                </p>
              </div>
            </div>
            
            {/* Read Replicas */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-700">Read Replicas</span>
                <div className="flex items-center">
                  {getStatusIcon('Healthy', 1.2)}
                  <span className="text-sm text-yellow-600 ml-2" data-testid="text-replicas-status">
                    Lag: 1.2s
                  </span>
                </div>
              </div>
              <div className="text-sm text-gray-500 space-y-1">
                {database?.replicas?.map((replica: any, index: number) => (
                  <p key={replica.id} data-testid={`text-replica-${index}`}>
                    Replica {index + 1}: {replica.status} • Lag: {replica.lag}s
                  </p>
                )) || (
                  <>
                    <p data-testid="text-replica-1">Replica 1: Healthy • Lag: 0.8s</p>
                    <p data-testid="text-replica-2">Replica 2: Healthy • Lag: 1.2s</p>
                  </>
                )}
              </div>
            </div>
            
            {/* Partitioning Status */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-700">Partitioning Status</span>
                <div className="flex items-center">
                  {getStatusIcon('Optimal')}
                  <span className="text-sm text-green-600 ml-2" data-testid="text-partitions-status">
                    Optimal
                  </span>
                </div>
              </div>
              <div className="text-sm text-gray-500 space-y-1">
                <p>
                  Products: <span data-testid="text-product-partitions">{database?.partitions?.products || 752} partitions</span> across <span data-testid="text-product-vendors">{database?.partitions?.vendors || 47} vendors</span>
                </p>
                <p>
                  Customers: <span data-testid="text-customer-partitions">{database?.partitions?.customers || 1504} partitions</span> across <span data-testid="text-customer-vendors">{database?.partitions?.vendors || 47} vendors</span>
                </p>
              </div>
            </div>
            
            {/* Maintenance Window */}
            <div className="bg-blue-50 p-4 rounded-lg">
              <div className="flex">
                <AlertCircle className="w-4 h-4 text-blue-600 mr-2 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-blue-900">Maintenance Window</p>
                  <p className="text-sm text-blue-700" data-testid="text-next-maintenance">
                    Next scheduled: Sunday 2:00 AM EST
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
