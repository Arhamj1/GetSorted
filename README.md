# GetSorted

Subscription tracker built with JavaScript, Firebase Auth, Cloud Firestore and Chart.js.

- `index.html` is the whole web app.
- `gmail-import.js` finds subscriptions in a user's Gmail receipts.
- `scripts/send-reminders.mjs` is the daily renewal-reminder email job.
- `.github/workflows/reminders.yml` runs that job every day at 09:00 IST.

## Import from Gmail

Users click **Import from Gmail**, sign in with Google and allow read-only access. GetSorted then searches the last 13 months of their inbox for receipts from 15 services (Netflix, Spotify, YouTube, Apple, ChatGPT, Claude, Swiggy, Zomato and more).

From those receipts it works out the price, monthly or yearly billing, the next billing date and the card or UPI used. Users review the list, fix anything, and add the ones they want.

- **Read-only:** the only permission requested is `gmail.readonly`.
- **Nothing leaves the browser:** emails are read and parsed on the user's device. Only the subscriptions they confirm are saved.
- **Short-lived access:** the Google access token is revoked as soon as the scan finishes.
- **Smart labelling:** already-tracked, cancelled and lapsed subscriptions are labelled and left unticked.
- **Demo mode:** `?demo` runs the same parser over a sample inbox, so the flow works without a Google account.

Run the parser tests:

```bash
npm run test:parser
```

### Turn it on for real accounts (one-time, about 10 minutes)

Until a client ID is set, the button only appears in demo mode.

**1. Create a Google Cloud project.**

1. Open <https://console.cloud.google.com/>.
2. You can reuse the **getsorted-a423c** project that Firebase already created.

**2. Enable the Gmail API.**

Go to **APIs & Services → Library → Gmail API → Enable**.

**3. Set up the OAuth consent screen.**

Go to **APIs & Services → OAuth consent screen**, or **Google Auth Platform** in newer consoles, and fill in:

- **App name:** GetSorted
- **User support email:** your email
- **Audience:** External
- **Data access:** add the scope `https://www.googleapis.com/auth/gmail.readonly`
- **Test users:** add every Gmail address that should be allowed to use the import, including your own. Up to 100 addresses.

**4. Create the client ID.**

1. Go to **Credentials → Create credentials → OAuth client ID → Web application**.
2. Under **Authorised JavaScript origins**, add the address the site runs on, for example `http://localhost:5173` and your live site's URL.
3. Copy the **Client ID**. It ends in `.apps.googleusercontent.com`.

**5. Add it to the code.**

Paste the client ID into `GOOGLE_CLIENT_ID` at the top of `gmail-import.js`. The client ID is public by design, so it's fine to commit. Never commit a client *secret*; this feature doesn't use one.

While the app is in Google's "Testing" mode, users see an "unverified app" warning and must be on the test-user list. Opening it to everyone requires Google's verification and a security assessment for the restricted Gmail scope.

## Renewal reminder emails

Every morning the job checks every user's subscriptions. For each user with something renewing **in 3 days** or **today**, it sends one email to the address they log in with, listing what's due, how much and how it's paid.

- **Auto-pay dates:** these roll forward the same way they do in the app.
- **Manual payments:** subscriptions without auto-pay are flagged "Pay manually".
- **No duplicates:** each email is recorded on the subscription (`reminderLog`), so running the job twice in a day never double-sends.
- **Opting out:** users turn reminders off from the account menu in the app. That saves `emailReminders: false` on `users/{email}`, and the job skips them.

### One-time setup

You need three secrets: a Firebase service-account key, a Gmail address and a Gmail app password.

**1. Push this folder to a GitHub repository.**

The workflow file is already in `.github/workflows/`, so GitHub picks it up automatically.

**2. Create a Firebase service-account key.**

1. Open the [Firebase console](https://console.firebase.google.com/) and go to the **getsorted-a423c** project.
2. Go to **Project settings → Service accounts → Generate new private key**. This downloads a `.json` file.
3. Keep this file private, and never commit it. `.gitignore` already blocks `*service-account*.json`.

**3. Create a Gmail app password.**

1. Use the Gmail account the reminders should come from. It must have 2-Step Verification turned on.
2. Go to <https://myaccount.google.com/apppasswords>, create one called "GetSorted" and copy the 16 characters.

**4. Add the secrets to the repo.**

In GitHub, go to **Settings → Secrets and variables → Actions**.

| Type | Name | Value |
|---|---|---|
| Secret | `FIREBASE_SERVICE_ACCOUNT` | the entire contents of the `.json` file |
| Secret | `GMAIL_USER` | the Gmail address, e.g. `getsorted.app@gmail.com` |
| Secret | `GMAIL_APP_PASSWORD` | the 16-character app password |
| Variable (optional) | `APP_URL` | your live site URL, shown as an "Open GetSorted" button |

**5. Test it.**

1. Go to **Actions → Renewal reminder emails → Run workflow**.
2. Tick **Dry run** first. The log lists who *would* get an email.
3. Run it again with **to** set to your own email. Every email goes only to you, and nothing is marked as sent.
4. After that it runs by itself every day.

### Run it on your laptop

```bash
npm install
```

```bash
npm run reminders:preview
```

The preview uses sample data and needs no Firebase or Gmail. It writes the email to `reminder-previews/` so you can open it in a browser.

To use real data, set the same three values as environment variables and run `node scripts/send-reminders.mjs --dry-run`, or drop `--dry-run` to send.

### Firestore rules

The job uses the service account, so your security rules don't affect it. The in-app reminders toggle writes to `users/{email}` itself, not only to the `subscriptions` under it. If saving the toggle fails, make sure your rules let a signed-in user write their own user document, for example:

```
match /users/{email}/{document=**} {
  allow read, write: if request.auth != null && request.auth.token.email == email;
}
```

### Limits

- Gmail allows about 500 emails a day from a personal account, which is plenty for this app.
- GitHub may start a scheduled run a few minutes late during busy periods.
- GitHub pauses scheduled workflows in repositories with no activity for 60 days. Push a commit or run the workflow by hand to wake it up.
