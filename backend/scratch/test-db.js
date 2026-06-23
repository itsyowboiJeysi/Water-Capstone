const mysql = require("mysql2/promise");

async function test(host) {
  console.log(`\nAttempting connection to mysql on host "${host}"...`);
  try {
    const conn = await mysql.createConnection({
      host: host,
      user: "root",
      password: "",
    });
    console.log(`Connection to "${host}" successful!`);
    await conn.end();
  } catch (err) {
    console.error(`Connection to "${host}" failed:`, err.message || err);
  }
}

async function run() {
  await test("127.0.0.1");
  await test("::1");
  await test("localhost");
}

run();
