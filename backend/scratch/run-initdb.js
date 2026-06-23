const { initDB } = require("../config/db");

async function run() {
  try {
    console.log("Running initDB...");
    await initDB();
    console.log("initDB completed successfully!");
    process.exit(0);
  } catch (err) {
    console.error("Error running initDB:", err);
    process.exit(1);
  }
}

run();
