# AI Analytics SaaS

A multi-user AI analytics SaaS foundation built with Next.js App Router. Users can authenticate, connect a reporting database, ask questions in natural language, inspect validated read-only query results, export CSV, monitor usage, and manage a paid plan through Stripe Checkout and Billing Portal.

## Features in this repository

- **Authentication:** Auth.js v5 with optional Google OAuth and email magic links.
- **Database connections:** PostgreSQL, MySQL and MongoDB, with encrypted credentials (AES-256-GCM), ownership scoping, connection test-before-save, schema discovery and soft deactivation.
- **AI analytics:** OpenAI query generation, strict response validation, SQL AST inspection using `node-sql-parser`, restricted MongoDB aggregation pipeline stages, row limits and query timeouts.
- **Usage limits:** Mongo-backed per-user rate limiting, atomic monthly query reservations, and plan-based active-connection limits.
- **Commercial billing:** Stripe Checkout, customer portal and signed webhook processing for Free, Pro and Business plan state.
- **Analytics UI:** Dashboard KPIs, daily usage chart, query result table, simple numeric chart, CSV result export and downloadable usage report.
- **Operations:** Restricted admin overview (email allowlist), recent usage events, security headers and deployment documentation.

## Stack

- Next.js 14 App Router, React 18, TypeScript, Tailwind CSS
- Auth.js v5, MongoDB Atlas and Mongoose
- OpenAI API
- PostgreSQL (`pg`), MySQL (`mysql2`), MongoDB driver
- `node-sql-parser`, Zod
- Stripe REST API with signature-verified webhook handling

## Local setup

1. Use Node.js 20 or newer.
2. Copy `.env.example` to `.env.local` and configure the required values.
3. Generate independent secrets: `openssl rand -base64 32` for `AUTH_SECRET` and `DATABASE_ENCRYPTION_KEY`.
4. Configure Google OAuth callback `http://localhost:3000/api/auth/callback/google`, or configure SMTP for email magic links. At least one provider must be configured.
5. Install and validate:

```bash
npm install
npm run typecheck
npm run lint
npm run build
npm run dev
```

6. Open `http://localhost:3000`.

## Stripe setup

1. Create recurring monthly prices in Stripe for Pro and Business.
2. Set `STRIPE_SECRET_KEY`, `STRIPE_PRICE_PRO`, and `STRIPE_PRICE_BUSINESS` in the deployment environment.
3. Create a webhook endpoint at `https://YOUR_DOMAIN/api/billing/webhook` and subscribe to `checkout.session.completed`, `customer.subscription.updated`, and `customer.subscription.deleted`.
4. Set the signing secret as `STRIPE_WEBHOOK_SECRET`.
5. Test successful checkout, cancellation, payment failure, plan limits and portal access using Stripe test mode before enabling live mode.

The displayed $29/$99 amounts are illustrative. The Stripe price IDs determine the actual amount charged. Configure prices and customer-facing legal/policy pages before charging customers.

## Admin setup

Set `ADMIN_EMAILS` to a comma-separated allowlist of administrator email addresses. Only matching authenticated users can open `/admin` and the admin overview API. Do not rely on a hidden navigation link as access control; the server page and API both verify the allowlist.

## Production prerequisites — not optional

This repository is an enhanced commercial starter, **not a certified or fully production-verified service**. Before handling real customer data or taking payments:

- Install dependencies and run `npm run typecheck`, `npm run lint`, and `npm run build` in a network-enabled environment; fix all diagnostics.
- Commit a generated `package-lock.json` and use `npm ci` in CI/deploys.
- Add automated unit, integration and browser end-to-end tests. Test with disposable read-only PostgreSQL/MySQL/MongoDB users and Stripe test mode.
- Enforce outbound network egress restrictions at infrastructure level. DNS checks are defense-in-depth and cannot completely eliminate DNS rebinding or cloud metadata access risks.
- Use dedicated read-only database accounts, strict network allowlists, TLS, query timeouts and least privilege. Never connect to customer databases with administrator credentials.
- Add privacy policy, terms, data-processing agreement, retention/deletion process, incident response, backups, monitoring, alerting and support workflows appropriate to your market.
- Review subscription state transitions, refunds, failed payments, taxes, invoices, cancellation and customer communication for your jurisdiction.
- Add distributed abuse controls and monitoring appropriate for your traffic and hosting environment. The included Mongo-backed fixed-window limiter is a baseline, not a substitute for edge/WAF protection.
- Conduct an independent security review before onboarding sensitive or regulated datasets.

See `DEPLOYMENT.md` and `VERIFICATION_REPORT.md` for deployment and validation details.
