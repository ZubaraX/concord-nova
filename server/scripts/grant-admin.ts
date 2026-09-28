// Make an existing account an instance admin (re-enabling it if it was
// disabled). deploy/setup.sh runs this when the deploy is given --admin:
//   npx tsx scripts/grant-admin.ts <username or email>
// It is a one-off grant: nothing is kept in the server config, so an address
// that isn't registered yet can't be claimed by somebody else later.
import { UserFlags } from "@nova/shared";
import { prisma } from "../src/db";

async function main() {
  const login = (process.argv[2] ?? "").trim().toLowerCase().replace(/^@/, "");
  if (!login) {
    console.error("usage: tsx scripts/grant-admin.ts <username or email>");
    return 2;
  }
  const user = await prisma.user.findUnique({ where: login.includes("@") ? { email: login } : { username: login } });
  if (!user) {
    console.error(`no account "${login}" on this server — check the spelling (the username is the part after @ in your profile)`);
    return 1;
  }
  await prisma.user.update({ where: { id: user.id }, data: { flags: user.flags | UserFlags.INSTANCE_ADMIN, disabledAt: null } });
  console.log(`@${user.username} is an instance admin${user.disabledAt ? " (the account was disabled — enabled again)" : ""}`);
  return 0;
}

main()
  .then((code) => (process.exitCode = code))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
