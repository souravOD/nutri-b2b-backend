import "express-serve-static-core";

declare module "express-serve-static-core" {
  interface Request {
    auth?: {
      userId: string;
      email: string;
      vendorId: string;
      role: string;
      permissions: string[];
    };
  }
}
