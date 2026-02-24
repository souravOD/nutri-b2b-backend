/**
 * One-time script: Update sourav.patil@odysseyts.com to "owner" role
 * on all Appwrite teams they belong to.
 * 
 * Run: npx tsx fix-team-role.ts
 */
import { Client, Teams, Users } from "node-appwrite";

const ENDPOINT = "https://nyc.cloud.appwrite.io/v1";
const PROJECT = "68ee72c9001ee9382faa";
const API_KEY = "standard_65518be4a35d552e03b381cfc18f904918d3a66db777ff289338da5343d042f0329b89852bbd3a9a84c71155c81786966d5d6ca5b8128f336d65baeef4e0c5a6ffbdff35fb6fa0da81e33c74e76e6d7480c0d4d9f57ca90131cf1e9afcab6837b7ca39df4db6ff12fa82d9f77c643318daa91236984f4679059903a5d40fb3b6";
const TARGET_EMAIL = "sourav.patil@odysseyts.com";

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
