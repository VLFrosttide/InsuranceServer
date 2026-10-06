const fs = require("fs");

function PersistRefreshTokens(oAuth2Client, tokenPath, initial) {
  let current = initial;
  oAuth2Client.on("tokens", (fresh) => {
    current = { ...current, ...fresh };
    try {
      fs.writeFileSync(tokenPath, JSON.stringify(current, null, 2));
    } catch (err) {
      console.error("Failed to persist refreshed Gmail tokens:", err);
    }
  });
}

module.exports = PersistRefreshTokens;
