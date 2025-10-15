import React from "react";
import { Switch, Route } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

// Pages
import Dashboard from "@/pages/dashboard";
import Vendors from "@/pages/vendors";
import Products from "@/pages/products";
import Customers from "@/pages/customers";
import Ingestion from "@/pages/ingestion";
import Analytics from "@/pages/analytics";
import Connectors from "@/pages/connectors";
import Webhooks from "@/pages/webhooks";
import Matching from "@/pages/matching";
import Audit from "@/pages/audit";
import RBAC from "@/pages/rbac";
import DatabaseHealth from "@/pages/database";
import Configuration from "@/pages/settings";
import NotFound from "@/pages/not-found";

const App: React.FC = () => {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Switch>
          {/* Home + explicit /dashboard both show Dashboard */}
          <Route path="/" component={Dashboard} />
          <Route path="/dashboard" component={Dashboard} />

          <Route path="/vendors" component={Vendors} />
          <Route path="/products" component={Products} />
          <Route path="/customers" component={Customers} />
          <Route path="/ingestion" component={Ingestion} />
          <Route path="/analytics" component={Analytics} />
          <Route path="/connectors" component={Connectors} />
          <Route path="/webhooks" component={Webhooks} />
          <Route path="/matching" component={Matching} />
          <Route path="/audit" component={Audit} />
          <Route path="/rbac" component={RBAC} />
          <Route path="/database" component={DatabaseHealth} />
          <Route path="/settings" component={Configuration} />

          {/* 404 */}
          <Route component={NotFound} />
        </Switch>

        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
};

export default App;
