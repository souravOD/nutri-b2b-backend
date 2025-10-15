import 'dotenv/config';
import { Client, Account } from 'appwrite';

const endpoint  = process.env.APPWRITE_ENDPOINT;   // e.g. https://cloud.appwrite.io/v1
const projectId = process.env.APPWRITE_PROJECT_ID;
const email     = process.argv[2];
const password  = process.argv[3];

if (!endpoint || !projectId) {
  console.error('Set APPWRITE_ENDPOINT and APPWRITE_PROJECT_ID in .env/.env.local');
  process.exit(1);
}
if (!email || !password) {
  console.error('Usage: node get-jwt.mjs <email> <password>');
  process.exit(1);
}

const client  = new Client().setEndpoint(endpoint).setProject(projectId);
const account = new Account(client);

try {
  // 1) Create a session (returns $id and secret)
  const session = await account.createEmailPasswordSession(email, password);

  // 2) Attach session to client (both ways for Node)
  client.setSession(session.$id);

  // IMPORTANT: also send the session cookie explicitly for Node environments
  // Cookie name format: a_session_<PROJECT_ID> = <session.secret>
  const cookieName = `a_session_${projectId}`;
  client.addHeader('X-Fallback-Cookies', `${cookieName}=${session.secret}`);

  // 3) Now mint a JWT
  const { jwt } = await account.createJWT();
  console.log(jwt);
} catch (err) {
  console.error('Failed to create JWT:', err?.response ?? err);
  process.exit(1);
}
