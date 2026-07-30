# Module 3 — Backend API (Print Queue)

Node.js + Express backend implementing the full locked contract. Built for
Module 1 (student app) and Module 2 (shop dashboard) to integrate against.

## Stack

- **Express 5** — REST API
- **SQLite via `node:sqlite`** (Node's built-in module, not `better-sqlite3`)
  — zero native compile step, so `npm install` just works everywhere,
  including CI/sandboxed environments. Requires Node ≥ 22.5.
- **bcryptjs** — password hashing
- **jsonwebtoken** — shop-owner auth
- **multer** — local-disk file uploads

## Setup

```bash
npm install
cp .env.example .env      # edit JWT_SECRET etc. if you want
npm start                 # http://localhost:4000
```

Since the contract has **no shop signup endpoint**, create a shop manually:

```bash
npm run seed:shop -- "Sharma Xerox" sharma@example.com pass1234
```

This prints the `shopId` you'll need for testing Module 1/2 against this API.

## Endpoints (all implemented exactly per the locked contract)

| Method | Path | Auth |
|---|---|---|
| POST | `/api/shops/:shopId/jobs` | none (student) |
| POST | `/api/jobs/:jobId/payment` | none (student) |
| GET | `/api/jobs/:jobId` | none (student) |
| POST | `/api/shops/login` | none |
| GET | `/api/shops/:shopId/jobs?status=` | **Bearer JWT** (shop owner) |
| PATCH | `/api/jobs/:jobId/status` | **Bearer JWT** (shop owner) |
| POST | `/api/uploads` | none — `multipart/form-data`, field name `file` |

`Authorization: Bearer <token>` — token comes from `POST /api/shops/login`.

Full request/response shapes are exactly as specified in the shared
contract doc — not repeated here to avoid drift; that doc is the source of
truth. See the route files in `src/routes/` for the literal implementation.

## Things I added beyond the literal contract text (flagging, not silently changing it)

1. **Status transition guardrails on `PATCH /api/jobs/:jobId/status`.**
   The endpoint enforces `queued→printing→ready→collected` in order and
   rejects skipping/reversing with a `409`. The contract didn't spell this
   out, but the state machine diagram implies it. If Module 2's dashboard
   ever needs to set a status out of order, tell me and I'll loosen this —
   don't work around it silently on your end, since the DB has a `CHECK`
   constraint backing it too.
2. **A shop can only PATCH/list its own jobs.** The JWT's `shopId` is
   checked against the job's actual `shop_id` / the `:shopId` route param.
   Mismatches return `403`. This shouldn't affect either of you unless
   you're testing with mismatched shop/job IDs on purpose.

## Contract gap I did NOT fill in — needs a group decision

- **No shop signup/registration endpoint exists in the locked contract** —
  only `POST /api/shops/login`. For the pilot (a handful of shops onboarded
  manually by us), I've shipped a CLI script (`scripts/seedShop.js`) as a
  stopgap. If Module 2's dashboard needs shop owners to self-register
  through the UI, we need to add a `POST /api/shops` endpoint and agree on
  its shape together — I didn't want to invent that contract unilaterally.
- **`cancelled` status has no endpoint.** The state machine lists
  `cancelled` as reachable from any pre-`printing` state, and the DB
  `CHECK` constraint on `print_jobs.status` allows it, but no endpoint in
  the contract sets it. Flagging for the group — happy to add
  `PATCH /api/jobs/:jobId/status` support for `"cancelled"` (or a dedicated
  `POST /api/jobs/:jobId/cancel`) once we agree who can trigger it (student
  before paying? shop owner only?).

## Notes for Module 1 (student app)

- `POST /api/uploads` first (get `fileUrl`) → `POST /api/shops/:shopId/jobs`
  (get `jobId` + `amountDue`) → collect UPI payment yourself → `POST
  /api/jobs/:jobId/payment` with your `paymentRef` → you get back
  `tokenNumber`, show that to the student.
- **Payment verification is currently just "trust the paymentRef string"**
  — there's no real Razorpay/UPI webhook signature check yet (see comment
  in `src/routes/jobs.js`). Fine for pilot demo, not fine for real money.
  Flag if your module needs the real webhook flow sooner than expected.
- Poll `GET /api/jobs/:jobId` for status updates (no websockets in v1, per
  the shared skill map).

## Notes for Module 2 (shop dashboard)

- Login once, keep the JWT (expires in 7 days), send it as `Authorization:
  Bearer <token>` on the list and status-update endpoints.
- `GET /api/shops/:shopId/jobs?status=queued` — `status` query param is
  optional; omit it to get every job for the shop regardless of status.
- Marking a job `"ready"` fires the (stubbed) SMS notification — you don't
  need to trigger notifications yourself.

## Testing this module standalone

Full curl walkthrough (login → create job → pay → list → advance status →
upload) was run manually against this exact code before handoff. To repeat
it yourself:

```bash
npm start
# in another terminal:
curl -X POST http://localhost:4000/api/shops/login \
  -H "Content-Type: application/json" \
  -d '{"email":"sharma@example.com","password":"pass1234"}'
# use the returned shopId/token for the rest of the flow — see route files
# for exact request shapes.
```

## Deployment (when we're ready to pilot)

Any Node-friendly free tier works (Railway, Render). Two things to set as
env vars there: `JWT_SECRET` (real random value) and `CORS_ORIGINS` (the
real deployed URLs of Module 1 and Module 2, not localhost). SQLite file
storage means you'll want a host with a persistent disk/volume (Railway and
Render both support this) — if we end up on a host with ephemeral
filesystems, we'll need to migrate to Postgres or an S3-compatible bucket
for uploads before going live with real users.
