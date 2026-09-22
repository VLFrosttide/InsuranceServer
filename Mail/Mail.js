import path from 'node:path';
import process from 'node:process';
import {authenticate} from '@google-cloud/local-auth';
import {google} from 'googleapis';
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const CREDENTIALS_PATH = process.env.JSONPath
let PollInterval = 5*60*1000; // 5 minutes in milliseconds

async function CheckEmail() {
  const res = await gmail.users.messages.list({
    userId: "me",
    q: "in:inbox is:unread",
    maxResults: 5,
  });

  let Messages = res.data.messages || [];

  for (const message of Messages) {
    await processEmail(message.id);
  }
}

async function poll() {
  try {
    await CheckEmail();
  } catch (err) {
    console.error("Gmail polling failed:", err);
  }

  setTimeout(poll, PollInterval);
}

poll();


// async function listLabels() {
//   const auth = await authenticate({
//     scopes: SCOPES,
//     keyfilePath: CREDENTIALS_PATH,
//   });

//   const gmail = google.gmail({version: 'v1', auth});
//   // Get the list of labels.
//   const result = await gmail.users.labels.list({
//     userId: 'me',
//   });
//   const labels = result.data.labels;
//   if (!labels || labels.length === 0) {
//     console.log('No labels found.');
//     return;
//   }
//   console.log('Labels:');
//   // Print the name of each label.`
//   labels.forEach((label) => {
//     console.log(`- ${label.name}`);
//   });
// }

await listLabels();
