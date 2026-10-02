const fs = require("fs");

function PersistRefreshTokens(oAuth2Client, tokenPath, initial) {
  let current = initial;
  oAuth2Client.on("tokens", (fresh) => {
    current = { ...current, ...fresh };
    fs.writeFileSync(tokenPath, JSON.stringify(current, null, 2));
  });
}

module.exports = PersistRefreshTokens;
