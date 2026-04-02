/**
 * OpenAPI 3.0 spec for the Nutri B2B API — B2B-061.
 * Covers the 15 most-used endpoints across customers, products, analytics,
 * users, alerts, settings, webhooks, and ingest.
 *
 * Served at:
 *   GET /api/docs      → Swagger UI HTML
 *   GET /api/docs/spec → raw OpenAPI JSON
 *
 * Access is gated by superadmin role OR SWAGGER_ENABLED=true env flag.
 */

export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Nutri B2B API",
    version: "1.0.0",
    description:
      "B2B vendor portal API — customer management, product catalogue, analytics, user management, and AI matching.",
  },
  servers: [{ url: "/api/v1", description: "Current version" }],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "Appwrite JWT obtained from /api/auth/token",
      },
    },
    schemas: {
      Customer: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          external_id: { type: "string" },
          full_name: { type: "string" },
          email: { type: "string", format: "email" },
          dob: { type: "string", format: "date" },
          age: { type: "integer" },
          gender: { type: "string", enum: ["male", "female", "other", "unknown"] },
          account_status: { type: "string", enum: ["active", "inactive", "suspended"] },
          quality_score: { type: "number", minimum: 0, maximum: 1 },
          created_at: { type: "string", format: "date-time" },
        },
      },
      Product: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          category: { type: "string" },
          status: { type: "string", enum: ["active", "inactive", "draft"] },
          calories: { type: "number" },
          protein_g: { type: "number" },
          carbs_g: { type: "number" },
          fat_g: { type: "number" },
          dietary_tags: { type: "array", items: { type: "string" } },
        },
      },
      MatchedCustomer: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          customer_id: { type: "string", format: "uuid" },
          name: { type: "string" },
          customer_name: { type: "string" },
          email: { type: "string", format: "email" },
          match_score: { type: "number", minimum: 0, maximum: 1 },
        },
      },
      AnalyticsOverview: {
        type: "object",
        properties: {
          totals: {
            type: "object",
            properties: {
              products: { type: "integer" },
              customers: { type: "integer" },
              completedJobs: { type: "integer" },
            },
          },
        },
      },
      GoalAchievement: {
        type: "object",
        properties: {
          metrics: {
            type: "array",
            items: {
              type: "object",
              properties: {
                metric: { type: "string" },
                achieved_pct: { type: "number", minimum: 0, maximum: 100 },
              },
            },
          },
        },
      },
      UserLink: {
        type: "object",
        properties: {
          userId: { type: "string", format: "uuid" },
          email: { type: "string", format: "email" },
          role: {
            type: "string",
            enum: [
              "vendor_admin",
              "vendor_operator",
              "vendor_viewer",
              "wellness_manager",
              "marketing_manager",
            ],
          },
          status: { type: "string", enum: ["active", "inactive"] },
          membershipExpiresAt: { type: "string", format: "date-time", nullable: true },
        },
      },
      Alert: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          title: { type: "string" },
          message: { type: "string" },
          alert_type: { type: "string", enum: ["info", "warning", "error", "banner"] },
          severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
          is_active: { type: "boolean" },
          created_at: { type: "string", format: "date-time" },
        },
      },
      Webhook: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          url: { type: "string", format: "uri" },
          events: { type: "array", items: { type: "string" } },
          is_active: { type: "boolean" },
          created_at: { type: "string", format: "date-time" },
        },
      },
      Error: {
        type: "object",
        properties: {
          ok: { type: "boolean", example: false },
          error: { type: "string" },
          status: { type: "integer" },
        },
      },
    },
  },
  security: [{ BearerAuth: [] }],
  paths: {
    "/customers": {
      get: {
        summary: "List customers",
        tags: ["Customers"],
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          { name: "search", in: "query", schema: { type: "string" } },
          { name: "status", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Paginated customer list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    customers: { type: "array", items: { $ref: "#/components/schemas/Customer" } },
                    total: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/customers/{id}": {
      get: {
        summary: "Get a customer",
        tags: ["Customers"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": {
            description: "Customer detail",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Customer" } } },
          },
          "404": { description: "Not found" },
        },
      },
    },
    "/customers/batch": {
      post: {
        summary: "Batch upsert customers (CSV import)",
        tags: ["Customers"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  customers: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["external_id"],
                      properties: {
                        external_id: { type: "string" },
                        full_name: { type: "string" },
                        email: { type: "string", format: "email" },
                        dob: { type: "string", format: "date" },
                        age: { type: "integer" },
                        gender: { type: "string" },
                        phone: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Import result",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    inserted: { type: "integer" },
                    updated: { type: "integer" },
                    errors: { type: "array", items: { type: "object" } },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/products": {
      get: {
        summary: "List products",
        tags: ["Products"],
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          { name: "search", in: "query", schema: { type: "string" } },
          { name: "status", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Paginated product list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    products: { type: "array", items: { $ref: "#/components/schemas/Product" } },
                    total: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/products/{id}/matching-customers": {
      post: {
        summary: "Find customers compatible with a product",
        description:
          "Returns customers with no allergen conflicts against this product. Health-derived fields are not exposed (HIPAA). Match score is based on dietary preference alignment.",
        tags: ["Products", "Matching"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { limit: { type: "integer", default: 50, maximum: 100 } },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Matching customers",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    customers: { type: "array", items: { $ref: "#/components/schemas/MatchedCustomer" } },
                    summary: {
                      type: "object",
                      properties: { total_matched: { type: "integer" } },
                    },
                    fallback: { type: "boolean" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/analytics/overview": {
      get: {
        summary: "Analytics overview totals",
        tags: ["Analytics"],
        parameters: [{ name: "days", in: "query", schema: { type: "integer", default: 30 } }],
        responses: {
          "200": {
            description: "Overview metrics",
            content: { "application/json": { schema: { $ref: "#/components/schemas/AnalyticsOverview" } } },
          },
        },
      },
    },
    "/analytics/goal-achievement": {
      get: {
        summary: "Nutritional goal achievement percentages",
        tags: ["Analytics"],
        parameters: [{ name: "days", in: "query", schema: { type: "integer", default: 30 } }],
        responses: {
          "200": {
            description: "Goal achievement per metric",
            content: { "application/json": { schema: { $ref: "#/components/schemas/GoalAchievement" } } },
          },
        },
      },
    },
    "/analytics/top-recipes": {
      get: {
        summary: "Top-rated recipes for this vendor's members",
        tags: ["Analytics"],
        parameters: [{ name: "limit", in: "query", schema: { type: "integer", default: 10 } }],
        responses: {
          "200": {
            description: "Top recipes",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    recipes: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          name: { type: "string" },
                          avg_rating: { type: "number" },
                          rating_count: { type: "integer" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/analytics/export": {
      get: {
        summary: "Export analytics data",
        tags: ["Analytics"],
        parameters: [
          { name: "days", in: "query", schema: { type: "integer", default: 30 } },
          {
            name: "format",
            in: "query",
            schema: { type: "string", enum: ["csv", "xlsx"], default: "csv" },
          },
        ],
        responses: {
          "200": { description: "CSV or XLSX file download" },
        },
      },
    },
    "/users": {
      get: {
        summary: "List users linked to the vendor",
        tags: ["Users"],
        responses: {
          "200": {
            description: "User list",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/UserLink" } },
              },
            },
          },
        },
      },
    },
    "/users/{userId}/role": {
      patch: {
        summary: "Update a user's role",
        tags: ["Users"],
        parameters: [{ name: "userId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["role"],
                properties: {
                  role: { type: "string" },
                  membershipExpiresAt: { type: "string", format: "date-time", nullable: true },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Updated" },
          "403": { description: "Insufficient permissions" },
        },
      },
    },
    "/alerts": {
      get: {
        summary: "List alerts",
        tags: ["Alerts"],
        responses: {
          "200": {
            description: "Alert list",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Alert" } },
              },
            },
          },
        },
      },
      post: {
        summary: "Create an alert",
        tags: ["Alerts"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["title", "message"],
                properties: {
                  title: { type: "string" },
                  message: { type: "string" },
                  alert_type: { type: "string", default: "info" },
                  severity: { type: "string", default: "low" },
                  display_until: { type: "string", format: "date-time", nullable: true },
                },
              },
            },
          },
        },
        responses: { "201": { description: "Created" } },
      },
    },
    "/settings/branding.welcome_message": {
      get: {
        summary: "Get a system setting value",
        description: "Replace `branding.welcome_message` with any valid settings key.",
        tags: ["Settings"],
        parameters: [{ name: "key", in: "path", description: "Setting key (dot-notation)", schema: { type: "string" } }],
        responses: {
          "200": {
            description: "Setting value",
            content: {
              "application/json": {
                schema: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } } },
              },
            },
          },
        },
      },
    },
    "/webhooks": {
      get: {
        summary: "List webhooks",
        tags: ["Webhooks"],
        responses: {
          "200": {
            description: "Webhook list",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Webhook" } },
              },
            },
          },
        },
      },
      post: {
        summary: "Register a webhook",
        tags: ["Webhooks"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["url", "events"],
                properties: {
                  url: { type: "string", format: "uri" },
                  events: {
                    type: "array",
                    items: {
                      type: "string",
                      enum: [
                        "customer.created",
                        "customer.updated",
                        "product.created",
                        "product.updated",
                        "ingest.completed",
                        "member.provisioned",
                        "member.deprovisioned",
                      ],
                    },
                  },
                  secret: { type: "string" },
                },
              },
            },
          },
        },
        responses: { "201": { description: "Webhook registered" } },
      },
    },
    "/ingest/runs": {
      get: {
        summary: "List ingest runs",
        tags: ["Ingest"],
        responses: {
          "200": {
            description: "Ingest run history",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string", format: "uuid" },
                      status: { type: "string", enum: ["pending", "running", "completed", "failed"] },
                      total_records_written: { type: "integer" },
                      created_at: { type: "string", format: "date-time" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
