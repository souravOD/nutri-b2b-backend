import { Account, Client, Databases, ID, Query, Teams } from "node-appwrite";

type AppwriteUser = {
  id: string;
  email: string;
  name: string | null;
};

type AppwriteVendorPayload = {
  name: string;
  slug: string;
  billing_email: string;
  owner_user_id: string;
  created_at: string;
  status: "active" | "inactive" | "suspended";
  team_id: string;
  domains: string[];
  phone?: string | null;
  country?: string | null;
  timezone?: string | null;
};

function mustEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing env var: ${key}`);
  return value;
}

function createUserClient(jwt: string): Client {
  return new Client()
    .setEndpoint(mustEnv("APPWRITE_ENDPOINT"))
    .setProject(mustEnv("APPWRITE_PROJECT_ID"))
    .setJWT(jwt);
}

function createAdminClient(): Client {
  return new Client()
    .setEndpoint(mustEnv("APPWRITE_ENDPOINT"))
    .setProject(mustEnv("APPWRITE_PROJECT_ID"))
    .setKey(mustEnv("APPWRITE_API_KEY"));
}

function adminDatabases() {
  return new Databases(createAdminClient());
}

function adminTeams() {
  return new Teams(createAdminClient());
}

export async function getCurrentAppwriteUserFromJwt(jwt: string): Promise<AppwriteUser> {
  const account = new Account(createUserClient(jwt));
  const me: any = await account.get();
  return {
    id: String(me.$id),
    email: String(me.email || "").toLowerCase(),
    name: me.name ? String(me.name) : null,
  };
}

export async function appwriteVendorSlugExists(slug: string): Promise<boolean> {
  const db = adminDatabases();
  const out = await db.listDocuments(
    mustEnv("APPWRITE_DB_ID"),
    mustEnv("APPWRITE_VENDORS_COL"),
    [Query.equal("slug", slug), Query.limit(1)]
  );
  return out.total > 0;
}

export async function createAppwriteTeam(name: string): Promise<{ teamId: string }> {
  const teams = adminTeams();
  const created = await teams.create(ID.unique(), name);
  return { teamId: created.$id };
}

export async function addCreatorAsTeamAdmin(teamId: string, userId: string, name?: string | null): Promise<void> {
  const teams = adminTeams();
  await teams.createMembership(teamId, ["admin"], undefined, userId, undefined, undefined, name || undefined);
}

export async function createAppwriteVendorDocument(payload: AppwriteVendorPayload): Promise<{ documentId: string }> {
  const db = adminDatabases();
  const doc = await db.createDocument(
    mustEnv("APPWRITE_DB_ID"),
    mustEnv("APPWRITE_VENDORS_COL"),
    payload.slug,
    payload
  );
  return { documentId: doc.$id };
}

export async function deleteAppwriteVendorDocument(documentId: string): Promise<void> {
  const db = adminDatabases();
  await db.deleteDocument(mustEnv("APPWRITE_DB_ID"), mustEnv("APPWRITE_VENDORS_COL"), documentId);
}

export async function deleteAppwriteTeam(teamId: string): Promise<void> {
  const teams = adminTeams();
  await teams.delete(teamId);
}
