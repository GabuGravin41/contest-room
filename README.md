# The Contest Room

Online contest platform for the Kenya Informatics Olympiad. Students enter a code, wait in a waiting room, and the paper opens for everyone at the start time. The clock runs for exactly `CONTEST_MINUTES` (150), then answers are submitted automatically.

- **Frontend:** plain HTML/CSS/JS in `public/` (no build step).
- **Backend:** three Vercel serverless functions in `api/` (`join`, `sync`, `admin`).
- **Database:** Postgres (Neon free tier works).

## How it works

| Step | What happens |
|---|---|
| Code entry | `POST /api/join` checks the code. Before the start time it returns the waiting room only; **the paper is never sent before the start**. |
| Start | Each browser opens the paper at the start time, staggered over about 12 seconds so 4000 students don't all arrive in the same second. |
| Working | Answers and the activity log are kept in the browser (they survive reloads and dropped connections) and sent to `POST /api/sync` every `SYNC_SECONDS`, with each student's save times spread across the interval. |
| End | At zero the answer boxes lock and the final answers are sent. The server keeps accepting late saves for `GRACE_SECONDS` to cover slow networks; those are marked `late`. |
| Device rule | A code can only be active on one device at a time. If it is opened somewhere else, the newer device takes over and the older window locks. Every join is recorded with its IP address and browser. |

## What gets logged (for anomaly checks later)

Every event is stored with a timestamp in milliseconds since the official start, on the server clock.

| Code | Event | Extra fields |
|---|---|---|
| `k` | keystroke in an answer box | key class (`c` character, `b` backspace, `d` delete, `e` enter, `t` tab, `a` arrow/navigation), answer length |
| `in` | large insert without a paste (autofill, dictation or injected text) | characters added, input type |
| `p` / `pb` | paste of the student's own text (allowed) / paste from outside (blocked) | length |
| `cp` | copy or cut (`-q` means they tried to copy the question, which is blocked) | length |
| `bl` / `fo` | window lost focus / got focus back | |
| `hid` / `vis` | tab hidden / visible | |
| `fsx` / `fse` | left / entered full screen | |
| `go`, `mc`, `fl` | opened a problem, picked an MCQ option, marked a problem for review | |
| `kb`, `ctx` | keyboard shortcuts (Ctrl/Cmd combos, F12, PrintScreen, print) and right-clicks | |
| `rz`, `on`/`off`, `ld`, `sub` | window resize, network lost/restored, page load (new/resume/device switch and reload count), submit (manual/time) | |

Answer history: the latest answer is always stored; a snapshot of changed answers is also stored about every 5 minutes, so you can see how answers developed.

Storage format in the `logs` table is compact: `dt,type,question,a,b;dt,type,...`, where `dt` is milliseconds since the previous event (the first is relative to `base`). `npm run export` decodes everything.

## Setup (about 20 minutes)

1. **Database.** Create a free project at neon.tech in **AWS Europe (Frankfurt)**. Copy the **pooled** connection string (its host contains `-pooler`).
2. **Local config.** `cp .env.example .env` and fill it in. Set `CONTEST_START` with the `+03:00` offset, for example `2026-10-10T09:00:00+03:00`.
3. **Install and create tables.**
   ```bash
   npm install
   npm run db:setup
   ```
4. **Add students.** Use a CSV with the columns `name,school,county,candidate_no` (see `sample-students.csv`).
   ```bash
   npm run students -- students.csv        # writes out/codes-*.csv, ready to mail-merge or SMS
   npm run students -- --blank 20          # 20 unnamed codes for the team to test with
   ```
5. **Deploy.** Push the folder to a GitHub repo, import it on vercel.com (no framework, no build command; `vercel.json` sets everything). Add the same environment variables in Vercel → Settings → Environment Variables. Redeploy after you change any of them.
6. **Monitor.** Open `https://<your-site>/admin` and enter `ADMIN_KEY`. It shows joined, active, submitted, device switches, database size, per-student lookup (answers, joins, activity counts), and a list of codes used from more than one device, IP or browser.
7. **After the contest.** Run `npm run export`. It writes these files to `out/`:
   - `answers.csv`: one row per student, with every answer box and an automatic Section A score.
   - `activity.csv`: per-student counts of each event, time away from the page, and the longest gap between events.
   - `joins.csv`: every join with its IP address and browser.
   - `events.jsonl`: the full decoded activity log plus the answer snapshots.

## Google Drive backup (every 5 minutes)

A copy of everything in Neon is written to a Google Drive folder by a small Google Apps Script that runs inside your own Google account. It needs no Google Cloud project and no keys beyond `ADMIN_KEY`.

1. In Google Drive, create a folder, e.g. `KIO 2026 Round 1 backup`. Open it and copy the ID from the address bar (the part after `/folders/`).
2. Go to script.google.com → **New project**. Replace the contents of `Code.gs` with `google-drive-backup/Backup.gs` and save.
3. Open **Project Settings → Script properties** and add:
   - `BASE_URL`: your site, e.g. `https://contest-room.vercel.app`
   - `ADMIN_KEY`: the same value as in Vercel
   - `FOLDER_ID`: the folder ID from step 1
4. In the editor, choose the function `setup` and click **Run**. Approve the permissions (Drive and external requests). It runs a first backup and then schedules one every 5 minutes.
5. A few hours after the contest, run `stop` to end the schedule.

What lands in the folder:
- `answers/answers-latest.json`: every student's answers and status, overwritten each run.
- `answers/answers-<time>.json`: a copy from each run, so earlier states are kept.
- `logs/*.jsonl`: activity-log batches, append-only. Each run only fetches rows it hasn't saved yet.
- `joins/*.jsonl`: every join with its IP address and browser.

## Trying it locally

```bash
npm install
# point DATABASE_URL at any Postgres, set CONTEST_START a minute ahead and SYNC_SECONDS=10
npm run db:setup && npm run students -- --blank 3
npm run dev            # http://localhost:3000  and  http://localhost:3000/admin
```

`npm run demo` builds `out/demo.html`, a self-contained click-through with a fake server. Use it to show the team.

## Before you deploy

- **Private repo.** Keep the GitHub repo **private**. It contains the paper (`lib/paper.js`) and the Section A key (`lib/key.js`). Vercel deploys from private repos on the free plan.
- **Checked:** `vercel build` completes; the paper is only bundled into the server functions (never into public files); the answer key is not bundled at all.
- **Rehearse first.** Use a rehearsal `CONTEST_START`, then change it to the real time and **redeploy**. Environment changes only apply after a redeploy.
- **Wake the database.** Open `/admin` about 10 minutes before the start; Neon's free tier sleeps when idle.
- **Freeze a copy.** After the contest, create a Neon branch (Dashboard → Branches → Create) as an unchangeable copy of the results.

## Capacity with 4000 students (check before the day)

- **Requests.** At `SYNC_SECONDS=60`, one full contest is about 4000 × 150 ≈ 600k function calls. Vercel Hobby currently allows 1M invocations a month, and test runs count too. For more headroom, set `SYNC_SECONDS=90`, or upgrade to Pro for the contest month. Also note that Hobby's terms are for non-commercial use.
- **Storage.** Keystroke logs plus snapshots should come to roughly 100–300 MB for 4000 students. Neon's free tier is 0.5 GB. Watch the "Database" tile in `/admin` during a rehearsal.
- **Rehearse.** Run a real rehearsal with 50–100 people on phones and laptops a few days before, so problems show up while there is still time to fix them.
- **Region.** `vercel.json` pins functions to Frankfurt (`fra1`). Keep the Neon database in Frankfurt too, so every save is a short hop.

## Uploading the paper (LaTeX)

Write the paper in the usual KIO LaTeX template. Keep the marking scheme inside `\ifanswers … \fi` as usual; the Section A answer table is read from there, and nothing else in the marking scheme is shown to students.

**From the admin page (easiest, anyone on the team):**
1. Open `/admin` and enter the admin key.
2. Under **Contest content → Paper**, click **Choose .tex file…** and pick the file.
3. The page checks it and reports the title, number of problems, total marks, and whether the answer key was found. Fix any problem it reports, then choose the file again.
4. Click **Use this paper**. Students get it from then on; nothing needs redeploying.
5. Click **Preview the paper as a student** and read it through.

**Go back to the built-in paper** undoes an upload. During the contest (and in the 30 minutes before it) the page refuses to change the paper unless you tick a confirmation box.

**From GitHub (for whoever maintains the code):** replace `paper/round1.tex` and push. Vercel converts it on every deploy. An uploaded paper takes priority over this one.

The converter understands:
- sections: `\section*{Section A \quad Title \hfill\normalsize (notes)}`
- problems: `\begin{problem}{marks}`
- multiple choice: `\mcq{..}{..}{..}{..}{..}` or `mcqlong`
- written answers: `parts`, with `\item … \hfill [marks]`; each part gets its own answer box
- algorithm problems: `\textbf{Constraints.}`, `example` and `\task`
- text: `enumerate`, `\textbf`, `\emph`, `\texttt`, and inline maths `$…$`

Print-only material (name fields, answer grid) is left out.

## Instructions, name and logos (admin page)

Under **Contest content** in `/admin`:
- **Instructions page:** one instruction per line, shown as the first page of the paper. It already includes the disqualification rule.
- **Name and logos:** the event name, round and details line, plus logo uploads. Images are resized automatically. Use the arrows to reorder logos and **Remove** to delete one.

Students see changes within a minute. `public/branding.js` holds the defaults that are used until something is set here.

## Multiple-choice shuffling

Each student sees the options of every multiple-choice problem in their own fixed order, so a message like "the answer to 3 is B" is useless. Answers are stored as the original letters from the .tex file, so marking and the answer key are unaffected. The emergency answer file records the chosen option's text. To turn shuffling off, set `SHUFFLE_MCQ=0` in Vercel.

## Checking for cheating

After the contest (or during it), run:
```powershell
npm run flags
```
It writes two files to `out/`:
- `flags.csv`: every student with at least one signal, ranked **High / Medium / Low**, with plain-language reasons.
- `flag-pairs.csv`: pairs of students whose answers match beyond chance, with whether they share a school or IP address.

What it looks for:
- **Matching written or algorithm answers:** identical 5-word phrases, ignoring phrases many students share.
- **Answers that weren't typed:** long text with few keystrokes, or text that appeared all at once.
- **Long answers typed straight through** with no corrections (weak on its own).
- **Leaving the page, then a burst of writing or answers** right after returning.
- **Speed:** 300+ characters of an algorithm answer within 90 seconds of first opening the problem, or Section A all correct within 6 minutes.
- **Multiple choice:** near-identical wrong answers, and the same on-screen letters despite different option orders. Students at the same school or on the same IP address are held to a slightly lower bar.
- **Behaviour:** two devices writing at once, several devices or IP addresses, blocked pastes, copying question text, developer tools, printing.

Tested on a simulated contest of 300 students with ten planted cheating patterns: all ten were caught and no honest student was flagged. With only seven multiple-choice problems, MCQ evidence alone is deliberately treated cautiously. **A flag is a reason to review, not proof.** Look at the reasons, compare answers, and where it matters, ask the student to explain their solution.

## Demo mode (for showing CEMASTEA or the team)

Set `CONTEST_MODE=practice` in Vercel and redeploy. In practice mode the start time is ignored: each code opens immediately and gets its own 2.5-hour clock from its first entry, with real saving and logging. Make a few codes with `npm run students -- --blank 10`, or with **Issue a new code** in `/admin`, and hand them out.

**Set `CONTEST_MODE=live` (or delete it) and redeploy before the real contest.** `/admin` shows a red badge while practice mode is on.

## Contest-day precautions

- **Find a student** (`/admin`): search by name, school, county, candidate number or code to recover a lost code.
- **Issue a new code** (`/admin`): registers a student on the spot. The code works immediately.
- **If the server can't be reached for 2 minutes:** students see a bar with **Save a copy of my answers**. It downloads a text file of all their answers, named with their code. If `FALLBACK_EMAIL` is set, they are told to email it there. When the connection returns, saving resumes automatically.
- **Last resort:** keep the PDF paper ready to send out, with the same email address for answers.

## Files

```
api/join.js     code check, waiting room, session token, paper delivery
api/sync.js     autosave + activity log (idempotent; stale-device and late flags)
api/admin.js    monitor, search, issue codes, preview, paper/logo/instructions uploads, backups (x-admin-key)
api/brand.js    public: event name and logos for the student page
paper/round1.tex   built-in paper (LaTeX); lib/paper.js and lib/key.js are generated from it
lib/tex.js      LaTeX → online paper converter
lib/store.js    uploaded paper, settings, logos
lib/shuffle.js  per-student MCQ option order
public/branding.js event name, round, logos
lib/server.js   config, DB pool, helpers
public/         index.html, app.js, styles.css, admin.html
scripts/        schema.sql, setup-db.js, add-students.js, export.js, flags.js, tex-to-paper.js, build-demo.js
dev-server.js   local stand-in for Vercel
```
