import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useQuery } from "@tanstack/react-query";
import { Download, Shield, User, Bot } from "lucide-react";

export function AuditLogTable() {
  const { data: auditLogs, isLoading } = useQuery<any>({
    queryKey: ['/audit'],
    refetchInterval: 60000, // Refresh every minute
  });

  const getActorIcon = (actorRole: string) => {
    if (actorRole === 'superadmin') {
      return <Shield className="text-red-600 w-3 h-3" />;
    }
    if (actorRole === 'automated') {
      return <Bot className="text-gray-600 w-3 h-3" />;
    }
    return <User className="text-gray-600 w-3 h-3" />;
  };

  const getActionBadgeColor = (action: string) => {
    if (action.includes('break_glass')) {
      return "bg-red-100 text-red-800";
    }
    if (action.includes('health')) {
      return "bg-blue-100 text-blue-800";
    }
    if (action.includes('webhook')) {
      return "bg-purple-100 text-purple-800";
    }
    if (action.includes('create') || action.includes('start')) {
      return "bg-green-100 text-green-800";
    }
    return "bg-gray-100 text-gray-800";
  };

  const getStatusBadgeColor = (status: string) => {
    switch (status.toLowerCase()) {
      case 'success':
        return "bg-green-100 text-green-800";
      case 'logged':
        return "bg-yellow-100 text-yellow-800";
      case 'delivered':
      case 'processing':
        return "bg-green-100 text-green-800";
      case 'failed':
        return "bg-red-100 text-red-800";
      default:
        return "bg-blue-100 text-blue-800";
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Recent Activity & Audit Log</CardTitle>
          <div className="flex items-center space-x-2">
            <Badge className="bg-red-100 text-red-800" data-testid="badge-hipaa-monitored">
              HIPAA Monitored
            </Badge>
            <Button 
              variant="outline" 
              size="sm"
              data-testid="button-export-audit-log"
            >
              <Download className="w-4 h-4 mr-2" />
              Export Log
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Timestamp
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actor
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Action
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Entity
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Vendor
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {isLoading ? (
                [...Array(4)].map((_, i) => (
                  <tr key={i} className="animate-pulse">
                    <td className="px-6 py-4"><div className="h-4 bg-gray-200 rounded w-32"></div></td>
                    <td className="px-6 py-4"><div className="h-4 bg-gray-200 rounded w-24"></div></td>
                    <td className="px-6 py-4"><div className="h-6 bg-gray-200 rounded w-20"></div></td>
                    <td className="px-6 py-4"><div className="h-4 bg-gray-200 rounded w-28"></div></td>
                    <td className="px-6 py-4"><div className="h-4 bg-gray-200 rounded w-20"></div></td>
                    <td className="px-6 py-4"><div className="h-6 bg-gray-200 rounded w-16"></div></td>
                  </tr>
                ))
              ) : auditLogs?.data?.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-gray-500">
                    No audit entries found
                  </td>
                </tr>
              ) : (
                auditLogs?.data?.slice(0, 4).map((log: any, index: number) => (
                  <tr key={log.id} className="hover:bg-gray-50" data-testid={`row-audit-${index}`}>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900" data-testid={`text-timestamp-${index}`}>
                      {new Date(log.timestamp).toLocaleString()}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <div className="w-6 h-6 bg-gray-300 rounded-full flex items-center justify-center">
                          {getActorIcon(log.actor_role)}
                        </div>
                        <div className="ml-2">
                          <div className="text-sm font-medium text-gray-900" data-testid={`text-actor-${index}`}>
                            {log.actor_user_id || 'system'}
                          </div>
                          <div className="text-sm text-gray-500" data-testid={`text-role-${index}`}>
                            {log.actor_role}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <Badge 
                        className={`text-xs ${getActionBadgeColor(log.action)}`}
                        data-testid={`badge-action-${index}`}
                      >
                        {log.action}
                      </Badge>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900" data-testid={`text-entity-${index}`}>
                      {log.entity}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900" data-testid={`text-vendor-${index}`}>
                      {log.vendor_id ? 'Vendor Entity' : 'System'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <Badge 
                        className={`text-xs ${getStatusBadgeColor('Success')}`}
                        data-testid={`badge-status-${index}`}
                      >
                        Success
                      </Badge>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        
        <div className="px-6 py-4 border-t border-gray-200">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-700">
              Showing <span className="font-medium" data-testid="text-page-start">1</span> to{" "}
              <span className="font-medium" data-testid="text-page-end">4</span> of{" "}
              <span className="font-medium" data-testid="text-total-entries">
                {auditLogs?.data?.length || 0}
              </span> audit entries
            </p>
            <div className="flex items-center space-x-2">
              <Button 
                variant="ghost" 
                size="sm" 
                disabled
                data-testid="button-previous-page"
              >
                Previous
              </Button>
              <Button 
                variant="ghost" 
                size="sm"
                data-testid="button-next-page"
              >
                Next
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
