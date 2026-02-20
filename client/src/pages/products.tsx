import { useState } from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/top-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useQuery } from "@tanstack/react-query";
import { Search, Package, Filter, Download, Upload } from "lucide-react";

export default function Products() {
  const [searchQuery, setSearchQuery] = useState("");
  const [filters, setFilters] = useState({
    status: "",
    brand: "",
    category: ""
  });

  const { data: products, isLoading, error } = useQuery<any>({
    queryKey: [
      "/products",
      {
        q: searchQuery || undefined,
        brand: filters.brand || undefined,
        category_id: filters.category || undefined,
        status: filters.status || undefined,
        limit: 50, // optional cap
      },
    ],
  });

  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <TopBar 
          title="Product Catalog" 
          subtitle="Manage product inventory and nutrition data"
        />
        
        <div className="p-6 space-y-6">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-2xl font-semibold text-gray-900">Products</h2>
              <p className="text-sm text-gray-600">
                {products?.data?.length || 0} products in catalog
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" data-testid="button-export-products">
                <Download className="w-4 h-4 mr-2" />
                Export
              </Button>
              <Button data-testid="button-import-products">
                <Upload className="w-4 h-4 mr-2" />
                Import CSV
              </Button>
            </div>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Search & Filter</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex gap-4">
                <div className="flex-1 relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
                  <Input
                    placeholder="Search products by name, brand, or description..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10"
                    data-testid="input-search-products"
                  />
                </div>
                <Button variant="outline" data-testid="button-advanced-filters">
                  <Filter className="w-4 h-4 mr-2" />
                  Filters
                </Button>
              </div>
            </CardContent>
          </Card>

          {isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {[...Array(9)].map((_, i) => (
                <Card key={i} className="animate-pulse">
                  <CardHeader>
                    <div className="h-4 bg-gray-200 rounded w-3/4"></div>
                    <div className="h-3 bg-gray-200 rounded w-1/2"></div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      <div className="h-3 bg-gray-200 rounded"></div>
                      <div className="h-3 bg-gray-200 rounded w-2/3"></div>
                      <div className="h-8 bg-gray-200 rounded"></div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {products?.data?.map((product: any) => (
                <Card key={product.id} className="hover:shadow-md transition-shadow" data-testid={`card-product-${product.id}`}>
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <CardTitle className="text-lg line-clamp-2" data-testid={`text-product-name-${product.id}`}>
                          {product.name}
                        </CardTitle>
                        {product.brand && (
                          <p className="text-sm text-gray-600 mt-1" data-testid={`text-brand-${product.id}`}>
                            {product.brand}
                          </p>
                        )}
                      </div>
                      <Badge 
                        variant={product.status === 'active' ? 'default' : 'secondary'}
                        data-testid={`badge-status-${product.id}`}
                      >
                        {product.status}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      {product.description && (
                        <p className="text-sm text-gray-700 line-clamp-2" data-testid={`text-description-${product.id}`}>
                          {product.description}
                        </p>
                      )}
                      
                      <div className="flex justify-between items-center">
                        <span className="text-lg font-semibold text-green-600" data-testid={`text-price-${product.id}`}>
                          ${product.price || '0.00'}
                        </span>
                        {product.barcode && (
                          <span className="text-xs text-gray-500 font-mono" data-testid={`text-barcode-${product.id}`}>
                            {product.barcode}
                          </span>
                        )}
                      </div>

                      {product.dietary_tags && product.dietary_tags.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {product.dietary_tags.slice(0, 3).map((tag: string, index: number) => (
                            <Badge key={index} variant="outline" className="text-xs" data-testid={`badge-tag-${product.id}-${index}`}>
                              {tag}
                            </Badge>
                          ))}
                          {product.dietary_tags.length > 3 && (
                            <Badge variant="outline" className="text-xs">
                              +{product.dietary_tags.length - 3}
                            </Badge>
                          )}
                        </div>
                      )}

                      <div className="flex gap-2 pt-2">
                        <Button size="sm" variant="outline" data-testid={`button-view-${product.id}`}>
                          View Details
                        </Button>
                        <Button size="sm" variant="outline" data-testid={`button-edit-${product.id}`}>
                          Edit
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {!isLoading && (!products?.data || products.data.length === 0) && (
            <div className="text-center py-12">
              <Package className="w-12 h-12 text-gray-400 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">No products found</h3>
              <p className="text-gray-600 mb-4">
                {searchQuery ? "Try adjusting your search criteria." : "Start by importing your first product catalog."}
              </p>
              <Button data-testid="button-import-first-products">
                <Upload className="w-4 h-4 mr-2" />
                Import Product Catalog
              </Button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
