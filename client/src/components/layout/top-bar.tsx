import { Clock, CheckCircle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

interface TopBarProps {
  title: string;
  subtitle: string;
}

export function TopBar({ title, subtitle }: TopBarProps) {
  const { data: metrics } = useQuery({
    queryKey: ['/metrics'],
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  return (
    <header className="bg-white shadow-sm border-b border-gray-200">
      <div className="flex items-center justify-between h-16 px-6">
        <div>
          <h2 className="text-xl font-semibold text-gray-900" data-testid="text-page-title">
            {title}
          </h2>
          <p className="text-sm text-gray-500" data-testid="text-page-subtitle">
            {subtitle}
          </p>
        </div>
        
        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-2 text-sm text-gray-500">
            <Clock className="w-4 h-4" />
            <span>
              Last updated: 
              <span className="ml-1" data-testid="text-last-updated">
                {metrics?.lastUpdated 
                  ? new Date(metrics.lastUpdated).toLocaleTimeString()
                  : "2 minutes ago"
                }
              </span>
            </span>
          </div>
          
          <div className="flex items-center space-x-2">
            <div className="w-2 h-2 bg-green-400 rounded-full"></div>
            <span className="text-sm text-gray-700" data-testid="text-system-status">
              System Healthy
            </span>
          </div>
          
          <div className="flex items-center">
            <div className="w-8 h-8 bg-gray-300 rounded-full flex items-center justify-center">
              <CheckCircle className="text-gray-600 w-4 h-4" />
            </div>
            <div className="ml-3">
              <p className="text-sm font-medium text-gray-700" data-testid="text-user-name">
                Admin User
              </p>
              <p className="text-xs text-gray-500" data-testid="text-user-role">
                superadmin
              </p>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
