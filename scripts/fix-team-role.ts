/**
 * One-time script: Update sourav.patil@odysseyts.com to "owner" role
 * on all Appwrite teams they belong to.
 * 
 * Run: npx tsx fix-team-role.ts
 */
import { Client, Teams, Users } from "node-appwrite";

const ENDPOINT = process.env.APPWRITE_ENDPOINT;
const PROJECT = process.env.APPWRITE_PROJECT_ID;
const API_KEY = process.env.APPWRITE_API_KEY;
const TARGET_EMAIL = process.env.TARGET_EMAIL || "sourav.patil@odysseyts.com";

if (!ENDPOINT || !PROJECT || !API_KEY) {
    console.error("Missing required env vars: APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY");
    process.exit(1);
}

const client = new Client()
    .setEndpoint(ENDPOINT)
    .setProject(PROJECT)
    .setKey(API_KEY);

const usersApi = new Users(client);
const teamsApi = new Teams(client);

async function main() {
    // 1. Find the Appwrite user by email
    console.log(`Looking up user: ${TARGET_EMAIL}`);
    const userList = await usersApi.list(undefined, TARGET_EMAIL);
    const user = userList.users.find(u => u.email === TARGET_EMAIL);
    if (!user) {
        console.error(`User ${TARGET_EMAIL} not found in Appwrite!`);
        process.exit(1);
    }
    console.log(`Found user: ${user.name} (${user.$id})`);

    // 2. List all teams
    const teamsList = await teamsApi.list();
    console.log(`Found ${teamsList.total} team(s)\n`);

    for (const team of teamsList.teams) {
        console.log(`--- Team: ${team.name} (${team.$id}) ---`);

        // 3. Find this user's membership on the team
        const memberships = await teamsApi.listMemberships(team.$id);
        const membership = memberships.memberships.find(m => m.userId === user.$id);

        if (!membership) {
            console.log(`  -> User is NOT a member. Adding as owner...`);
            await teamsApi.createMembership(
                team.$id,
                ["owner"],
                TARGET_EMAIL,
                user.$id
            );
            console.log(`  OK Added as owner`);
            continue;
        }

        console.log(`  Current roles: [${membership.roles.join(", ")}]`);

        if (membership.roles.includes("owner")) {
            console.log(`  OK Already owner - no change needed`);
        } else {
            console.log(`  -> Updating to owner...`);
            await teamsApi.updateMembership(team.$id, membership.$id, ["owner"]);
            console.log(`  OK Updated to owner`);
        }
    }

    console.log("\nDone!");
}

main().catch(err => {
    console.error("Error:", err.message);
    process.exit(1);
});
