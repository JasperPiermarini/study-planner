# Study Planner

A clean dark-mode study planner. Pick the topics you want to cover in a
timeframe, and the app spreads them across the days. Check topics off from the
Today view, run Pomodoro focus sessions, and re-spread anything you fall behind
on. Data syncs across devices via Firestore.

Live at: https://jasperpiermarini.github.io/study-planner/

## One-time Firebase setup

1. Go to https://console.firebase.google.com and click **Add project** (e.g.
   name it `study-planner`). Google Analytics can be disabled.
2. In the project, open **Build → Firestore Database → Create database**.
   Choose a location near you and start in **production mode**.
3. Go to the **Rules** tab and replace the rules with:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /plans/{doc} {
         allow read, write: if true;
       }
       match /topics/{doc} {
         allow read, write: if true;
       }
     }
   }
   ```

   Then click **Publish**. (Note: like the list app, this makes the data
   readable/writable by anyone who has the config — fine for personal use,
   don't store anything sensitive.)

4. Go to **Project settings (gear icon) → Your apps → Web app (`</>`)**,
   register an app (no hosting needed), and copy the `firebaseConfig` object.
5. Paste the values into `firebase-config.js` in this repo, commit, and push.

## Development

It's a static site — no build step. Serve the folder locally, e.g.:

```
python -m http.server 8000
```

(Opening `index.html` directly via `file://` won't work because the app uses
ES modules.)

## How scheduling works

- **New plan**: enter a name, a start and end date, and one topic per line.
  Topics are distributed evenly across the days, in order.
- **Move topics**: in the plan view, use ◀ / ▶ to shift a topic a day
  earlier/later, or ✕ to delete it.
- **Re-spread remaining**: redistributes all unfinished topics evenly from
  today to the plan's end date — for when life happens.
- **Today**: shows everything due today across all plans, plus overdue topics
  with a one-tap "To today" button.
