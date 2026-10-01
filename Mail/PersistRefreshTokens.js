import fs from "fs";

function PersistRefreshTokens(oAuth2Client, tokenPath, initial) {
  let current = initial;
  oAuth2Client.on("tokens", (fresh) => {
    current = { ...current, ...fresh };
    fs.writeFileSync(tokenPath, JSON.stringify(current, null, 2));
  });
}

export default PersistRefreshTokens;
