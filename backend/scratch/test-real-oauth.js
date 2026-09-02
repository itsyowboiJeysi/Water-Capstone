const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const passport = require("../config/passport");

// Retrieve the GoogleStrategy instance registered with passport
const strategy = passport._strategy("google");

console.log("=== Google OAuth Strategy Config ===");
console.log("Client ID:", strategy._oauth2._clientId);
console.log("Client Secret:", strategy._oauth2._clientSecret ? "*****" : "MISSING");
console.log("Callback URL:", strategy._callbackURL);

console.log("\n=== Attempting dummy getOAuthAccessToken call ===");
const params = {
  grant_type: "authorization_code",
  redirect_uri: strategy._callbackURL
};

strategy._oauth2.getOAuthAccessToken("dummy_authorization_code_123", params, (err, accessToken, refreshToken, results) => {
  console.log("Callback returned!");
  if (err) {
    console.log("Error object structure:", {
      message: err.message,
      statusCode: err.statusCode,
      data: err.data,
      code: err.code
    });
  } else {
    console.log("Success results:", results);
  }
});
