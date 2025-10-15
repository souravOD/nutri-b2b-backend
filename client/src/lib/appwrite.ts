// client/src/lib/appwrite.ts
import { Client, Account, Databases, Teams, ID } from "appwrite";

const ENDPOINT = import.meta.env?.VITE_APPWRITE_ENDPOINT ||
  (typeof process !== "undefined" ? process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT : undefined);
const PROJECT  = import.meta.env?.VITE_APPWRITE_PROJECT_ID ||
  (typeof process !== "undefined" ? process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID : undefined);

if (!ENDPOINT || !PROJECT) {
  // eslint-disable-next-line no-console
  console.warn("[appwrite] missing endpoint/project envs (NEXT_PUBLIC_APPWRITE_ENDPOINT / NEXT_PUBLIC_APPWRITE_PROJECT_ID)");
}

export const appwrite = new Client().setEndpoint(String(ENDPOINT)).setProject(String(PROJECT));

export const account   = new Account(appwrite);
export const databases = new Databases(appwrite);
export const teams     = new Teams(appwrite);
export const AID       = ID;
