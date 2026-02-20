import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/top-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Plus, Building, Users, Package } from "lucide-react";

export default function Vendors() {
  const { data: vendors, isLoading } = useQuery<any>({
    queryKey: ['/vendors'],
  });

  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <TopBar 
          title="Vendor Management" 
          subtitle="Manage and monitor all vendor accounts"
        />
        
        <div className="p-6 space-y-6">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-2xl font-semibold text-gray-900">Vendors</h2>
              <p className="text-sm text-gray-600">
                {vendors?.data?.length || 0} active vendor accounts
              </p>
            </div>
            <Button data-testid="button-create-vendor">
              <Plus className="w-4 h-4 mr-2" />
              Add Vendor
            </Button>
          </div>

          {isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {[...Array(6)].map((_, i) => (
                <Card key={i} className="animate-pulse">
                  <CardHeader>
                    <div className="h-4 bg-gray-200 rounded w-3/4"></div>
                    <div className="h-3 bg-gray-200 rounded w-1/2"></div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      <div className="h-3 bg-gray-200 rounded"></div>
                      <div className="h-3 bg-gray-200 rounded w-2/3"></div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {vendors?.data?.map((vendor: any) => (
                <Card key={vendor.id} className="hover:shadow-md transition-shadow" data-testid={`card-vendor-${vendor.id}`}>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <CardTitle className="flex items-center text-lg">
                        <Building className="w-5 h-5 mr-2 text-blue-600" />
                        {vendor.name}
                      </CardTitle>
                      <Badge 
                        variant={vendor.status === 'active' ? 'default' : 'secondary'}
                        data-testid={`badge-status-${vendor.id}`}
                      >
                        {vendor.status}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      <div className="flex items-center text-sm text-gray-600">
                        <Package className="w-4 h-4 mr-2" />
                        <span data-testid={`text-products-${vendor.id}`}>
                          {Math.floor(Math.random() * 50000).toLocaleString()} products
                        </span>
                      </div>
                      <div className="flex items-center text-sm text-gray-600">
                        <Users className="w-4 h-4 mr-2" />
                        <span data-testid={`text-customers-${vendor.id}`}>
                          {Math.floor(Math.random() * 10000).toLocaleString()} customers
                        </span>
                      </div>
                      <div className="text-xs text-gray-500" data-testid={`text-created-${vendor.id}`}>
                        Created {new Date(vendor.created_at).toLocaleDateString()}
                      </div>
                      <div className="flex gap-2 pt-2">
                        <Button size="sm" variant="outline" data-testid={`button-view-${vendor.id}`}>
                          View Details
                        </Button>
                        <Button size="sm" variant="outline" data-testid={`button-configure-${vendor.id}`}>
                          Configure
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {!isLoading && (!vendors?.data || vendors.data.length === 0) && (
            <div className="text-center py-12">
              <Building className="w-12 h-12 text-gray-400 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">No vendors yet</h3>
              <p className="text-gray-600 mb-4">Get started by adding your first vendor account.</p>
              <Button data-testid="button-create-first-vendor">
                <Plus className="w-4 h-4 mr-2" />
                Add Your First Vendor
              </Button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
