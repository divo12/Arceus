import "../load-env.js";
import { seedUsers } from "../seed.js";

seedUsers()
  .then((count) => {
    console.log(`[seed-users] seeded ${count} users.`);
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error("[seed-users] FAIL:", err);
    process.exit(1);
  });
