# Module 2 — Shop Owner Dashboard

Print-queue counter app for shop owners: login, live job queue, one-click
status updates. Built against the locked contract shared with Module 1
(student app) and Module 3 (backend API).

## Run it

```bash
npm install
npm run dev
```

Demo login (mock backend, no real server needed):
- Email: `owner@campusxerox.in`
- Password: `printshop123`

## What's in scope (per the assignment)

- Login screen
- Queue dashboard, tabbed by status: Queued / Printing / Ready / History
  (History = collected jobs, newest first)
- One action button per job that advances it exactly one step:
  - Queued → **Send to printer** → `printing`
  - Printing → **Mark ready** → `ready`
  - Ready → **Mark collected** → `collected`
- Each job card shows token number, pages × copies, color mode (B&W/Color),
  and a "View file" link to `fileUrl`
- Auto-refresh every 15s (polling, no websockets, per contract) + manual
  refresh button
- Optimistic UI updates on status-change clicks, with rollback + error
  message if the API call fails

## Not in scope / not built (flagging so no one assumes it's missing by mistake)

- **Cancel action.** The state machine allows `cancelled` from any state
  before `printing`, but the Module 2 assignment only asked for the three
  forward-moving buttons (queued→printing→ready→collected). No cancel button
  exists in this UI. If a shop owner needs to cancel a job, that's an open
  question for whoever owns product scope — easy to add (`updateJobStatus`
  already supports arbitrary status strings), just wasn't asked for.
- Mobile/responsive layout — intentionally desktop-only per the brief (shop
  owners use a laptop at the counter).
- Signup/shop registration — only login, per contract (`POST /api/shops/login`
  assumes the shop account already exists).

## How this talks to the backend (`src/api.js`)

All network calls live in **one file**: `src/api.js`. Every other component
calls `login()`, `getJobs()`, `updateJobStatus()` — never `fetch()` directly.

Right now `USE_MOCK = true` at the top of that file, so the app runs
entirely against an in-memory fake backend (see `mockBackend` section) with
seeded demo jobs. This means Module 2 can be built, demoed, and reviewed with
zero dependency on Module 3 being done.

**To wire up the real backend once Module 3 is live:**
1. Set `USE_MOCK = false` in `src/api.js`.
2. Copy `.env.example` to `.env` and set `VITE_API_BASE_URL` to the real API
   URL.

Nothing else needs to change — the real fetch calls (`realLogin`,
`realGetJobs`, `realUpdateJobStatus`) already match the locked contract
shapes exactly.

## One assumption I made that isn't 100% pinned down in the contract — please confirm

The contract shows `GET /api/shops/:shopId/jobs?status=queued` with a single
example status. This dashboard needs to show queued + printing + ready
counts simultaneously (so an owner can see the whole counter at a glance
without switching tabs), so **I call this endpoint with no `status` query
param and assume it returns all jobs**, then filter client-side by status.

If Module 3's real implementation *requires* a `status` param on every call
(i.e. omitting it errors or returns nothing), tell me — it's a small, isolated
fix: `loadJobs()` in `src/components/Dashboard.jsx` would switch to three
parallel calls (`getJobs(shopId, token, 'queued')`, etc.) instead of one.
I did not change the contract itself, just want to confirm this interpretation
before we merge.

## File structure

```
src/
  api.js                  <- all backend calls, mock/real switch
  auth.js                 <- session persistence (localStorage)
  App.jsx                 <- login/dashboard switch, session bootstrap
  components/
    Login.jsx
    Dashboard.jsx          <- tabs, polling, status-advance logic
    JobCard.jsx            <- ticket-stub job card + action button
    StatusTabs.jsx
```

## Testing done so far

- Manual click-through of the full flow against the mock backend: log in →
  send job to printer → mark ready → mark collected → shows up in History.
- Error states: wrong login credentials, simulated failed status update
  (rolls back optimistic UI change and shows an inline error).
- `npm run build` succeeds with no errors.

Not yet tested: against Module 3's real API (can't, until it's deployed) or
Module 1's actual file upload flow (this module only ever reads `fileUrl`,
doesn't touch upload).
