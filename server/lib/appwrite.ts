import { Client, Account } from 'node-appwrite'

export async function getUserFromJWT(jwt: string) {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT!)
    .setProject(process.env.APPWRITE_PROJECT_ID!)
    .setJWT(jwt)

  const account = new Account(client)
  // If JWT is valid, this returns the session's user
  const user = await account.get()
  // { $id, email, name, ... }
  return user
}
