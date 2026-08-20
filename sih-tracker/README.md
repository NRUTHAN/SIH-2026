# CivicDocket — Smart Municipal Complaint-to-Resolution Tracker

A working prototype for the SIH problem statement: citizens report civic
issues (garbage, streetlights, potholes, etc.) with a photo and location,
AI auto-categorizes and routes the complaint to the right department, a
deadline (SLA) starts immediately, and **if the department takes no action
before the deadline, the system automatically drafts and logs an escalation
notice** — no complaint silently vanishes.

## What's in the box

```
sih-tracker/
├── backend/
│   ├── server.js          # entire backend: API + AI categorizer + escalation engine
│   └── data/
│       ├── config.json    # departments, categories, keywords, SLA hours (edit this to tune the demo)
│       ├── complaints.json    # the "database" — starts empty
│       └── notifications.json # AI escalation log — starts empty
└── frontend/
    ├── index.html   # citizen portal: report form + public SLA dashboard
    ├── admin.html    # department panel: escalation feed + complaint queue
    ├── app.js / admin.js
    └── styles.css
```

**Zero npm install needed.** The backend is written with only Node's built-in
modules (`http`, `fs`, `crypto`, `https`) specifically so any teammate can
run it in seconds during the hackathon without dependency issues.

## Run it

```bash
cd backend
node server.js
```

Then open:
- **Citizen portal + public dashboard:** http://localhost:4000/index.html
- **Department panel:** http://localhost:4000/admin.html

That's it — one server serves both the API and the frontend, so there's no
CORS setup or second process to run.

## How the two AI features work

**1. Auto-categorization & routing** (`categorizeAndRoute` in `server.js`)
By default this uses a fast offline keyword classifier over the complaint's
title/description — matches against `data/config.json`'s keyword lists, so
it works instantly with zero setup, which matters for a live demo with
uncertain wifi.
If you set an `ANTHROPIC_API_KEY` environment variable before starting the
server, it instead sends the **photo itself** to Claude's vision model and
asks it to classify the complaint — a genuine multimodal AI call, not a
mock. It falls back to the keyword classifier automatically if the call
fails, so the demo never breaks:
```bash
ANTHROPIC_API_KEY=sk-ant-... node server.js
```

**2. Automated escalation engine** (`runEscalationSweep`, runs every 15s)
Every open complaint has an SLA deadline computed from its category
(`slaHours` in `config.json`). The background sweep checks all open
complaints; if "now" has passed the deadline:
- **Level 1:** it auto-drafts an escalation message to the assigned
  department and flags the complaint as High priority.
- **Level 2:** if it's *still* unresolved after a further grace window
  (`level2AfterExtraHours`), it escalates again to municipal
  administration and flags it Critical.

Both the citizen dashboard and the department panel show these
escalations live, with the exact AI-drafted message and timestamp.

## Demo script (fastest way to show the judges the core loop)

1. Open the citizen portal, submit a complaint with a photo (e.g. type
   "pothole" in the description) — show the confirmation ticket:
   category, routed department, and deadline, all decided automatically.
2. Switch to **Public Ledger** — the docket appears with a live SLA
   countdown.
3. To show escalation without waiting days: temporarily lower a category's
   `slaHours` in `data/config.json` to something like `0.02` (~72 seconds)
   and restart the server before the demo. Submit a complaint in that
   category and don't action it — within ~15–90 seconds you'll see the
   escalation banner and AI-drafted notice appear live on both the public
   dashboard and the department panel's alert feed.
4. Open the **Department panel**, filter by that department, click
   "Mark In Progress" / "Mark Resolved" (with a photo) on a different
   complaint to show the human-in-the-loop side of the workflow, and the
   citizen-side "Confirm fixed / Dispute" closure loop back on the public
   ledger.

## Known simplifications (be upfront about these with judges)

- **Storage** is flat JSON files, not a real database — swap for
  Postgres/Mongo without changing the API surface for production.
- **No real authentication** — the department panel lets you pick any
  department from a dropdown rather than requiring staff login.
- **No SMS/email gateway** — escalation notices and status updates are
  logged in-app rather than actually sent; the integration point is
  clearly isolated in `runEscalationSweep()` / `draftEscalation()` if you
  want to wire in Twilio or an email API before the demo.
- **No duplicate-complaint detection yet** — a good "if we have time" add:
  compare new complaints' category + geo-proximity to open ones and offer
  to merge them.

## Tuning for your city/pitch

Everything department- and SLA-specific lives in `backend/data/config.json`
— add departments, categories, keywords, or change SLA hours there without
touching any code.
