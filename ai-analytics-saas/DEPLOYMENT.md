# GitHub + Vercel deployment guide

## 1. Prepare the project locally

Install Node.js 20 LTS. Extract the ZIP and open a terminal in the project directory.

```bash
cp .env.example .env.local
npm install
npm run typecheck
npm run build
```

On Windows PowerShell, copy the environment template with:

```powershell
Copy-Item .env.example .env.local
```

Populate `.env.local` before building. Never commit `.env.local`.

## 2. Create production services

### MongoDB Atlas
1. Create a MongoDB Atlas cluster.
2. Create a database user with a strong password.
3. Configure Network Access. For Vercel, use Atlas's recommended connectivity setup; avoid opening access broadly unless you understand the risk.
4. Copy the SRV URI into `MONGODB_URI` and set `MONGODB_DATABASE=ai_analytics`.

### Google OAuth
1. Open Google Cloud Console → APIs & Services → Credentials.
2. Create an OAuth client ID for a Web application.
3. Add your local callback: `http://localhost:3000/api/auth/callback/google`.
4. After Vercel deployment, add `https://YOUR-DOMAIN/api/auth/callback/google`.
5. Put the client ID and secret in environment variables.

### Email magic link
Configure an SMTP provider and set `AUTH_EMAIL_SERVER` and `AUTH_EMAIL_FROM`. Verify the sender/domain with your provider. SMTP credentials should be stored only in environment variables.

### Secrets
Generate distinct secrets for production:

```bash
openssl rand -base64 32
```

Set the output as `AUTH_SECRET`. Set `CONNECTION_ENCRYPTION_KEY` to a separate high-entropy secret (32+ characters). Keep it stable; changing it without a migration makes previously encrypted credentials unreadable.

### AI analytics database connections
The connection manager supports MongoDB Atlas, PostgreSQL and MySQL. For MongoDB Atlas, choose **MongoDB Atlas** in the connection form, copy the SRV URI from Atlas → Cluster → Connect → Drivers, enter the database name (for example `test`), and keep the URI secret. Create a dedicated database user with read-only permissions and configure Atlas Network Access for the deployment. MongoDB analytics uses a constrained, read-only aggregation pipeline. In Vercel, configure these additional variables before saving a connection:

- `OPENAI_API_KEY`: an OpenAI API key with access to the configured model.
- `OPENAI_MODEL`: optional; defaults to `gpt-4o-mini`.
- `CONNECTION_ENCRYPTION_KEY`: base64-encoded 32-byte key used for AES-256-GCM encryption of saved database credentials. Generate it with:

```bash
openssl rand -base64 32
```

Use a dedicated **read-only** database account for analytics. The app validates generated SQL as a single SELECT statement, caps output at 100 rows, and applies query timeouts. Do not use an administrator/root database account. Keep the encryption key stable; rotating it requires re-encrypting stored connection credentials first.

## 3. Push to GitHub

Create an empty GitHub repository. Then, from the project directory:

```bash
git init
git add .
git commit -m "chore: initialize AI analytics SaaS"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git
git push -u origin main
```

If Git says the remote already exists:

```bash
git remote set-url origin https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git
git push -u origin main
```

Check that `.env.local` is not staged:

```bash
git status
```

If a secret was ever committed, rotate it immediately; deleting the file in a later commit is not enough.

## 4. Deploy on Vercel

1. Sign in at https://vercel.com.
2. Choose **Add New → Project** and import the GitHub repository.
3. Framework preset should be **Next.js**. Root directory is the repository root.
4. Add all required environment variables under **Settings → Environment Variables** for Production, Preview, and Development as appropriate:
   - `NEXT_PUBLIC_APP_URL`
   - `AUTH_SECRET`
   - `AUTH_TRUST_HOST`
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `AUTH_EMAIL_SERVER`
   - `AUTH_EMAIL_FROM`
   - `MONGODB_URI`
   - `MONGODB_DATABASE`
   - `OPENAI_API_KEY`
   - `OPENAI_MODEL`
   - `CONNECTION_ENCRYPTION_KEY`
   - `STRIPE_SECRET_KEY` (when enabling paid plans)
   - `STRIPE_WEBHOOK_SECRET` (when enabling paid plans)
   - `STRIPE_PRICE_PRO` and `STRIPE_PRICE_BUSINESS` (recurring Stripe Price IDs)
   - `ADMIN_EMAILS` (comma-separated administrator email allowlist)
5. Set `NEXT_PUBLIC_APP_URL` to your real HTTPS deployment URL.
6. Click **Deploy**.
7. If environment variables are changed later, redeploy so the deployment receives the new values.

## 5. Update OAuth URLs

Once Vercel gives you a domain, add `https://YOUR-VERCEL-DOMAIN/api/auth/callback/google` to Google OAuth authorized redirect URIs. Also set the production URL in `NEXT_PUBLIC_APP_URL`.

## 6. Validate production

- Open the home page and `/login`.
- Test Google sign-in and email magic link.
- Confirm an authenticated user can open `/dashboard`, `/chat`, and `/connections`.
- Test that unauthenticated access redirects to login.
- Add a test database connection and verify credentials are never returned by the API.
- Inspect Vercel function logs for server errors.
- Test only with a disposable/read-only database account initially.

## 7. Common failures

- **Auth `UntrustedHost`**: set `AUTH_TRUST_HOST=true` and redeploy.
- **Google `redirect_uri_mismatch`**: the callback URL in Google Cloud must match exactly.
- **Mongo connection timeout**: verify URI, username/password encoding, Atlas network access, and database user permissions.
- **Build/type errors**: run `npm run typecheck` and `npm run build` locally, then inspect the Vercel build log.
- **Magic link not delivered**: check SMTP credentials, sender verification, and provider logs.
- **Credential decryption fails**: ensure `CONNECTION_ENCRYPTION_KEY` has not changed between deployments.

## 8. Production checklist

- [ ] Use read-only credentials for customer databases.
- [ ] Independently review and test the SQL AST validator across PostgreSQL and MySQL dialect edge cases.
- [ ] Independently review and test the MongoDB aggregation stage/operator allowlist; never enable `$where`, `$function`, `$out`, or `$merge`.
- [ ] Load-test the included Mongo-backed rate limits and quota reservations; add edge/WAF controls and alerting for the expected traffic level.
- [ ] Restrict outbound network access and validate customer database hosts/IPs to reduce SSRF risk.
- [ ] Add automated unit, integration, and browser tests.
- [ ] Use a managed KMS/secrets manager for higher-assurance secret management.
- [ ] Verify database statement timeouts and cancellation behavior against each supported database using integration tests.
- [ ] Add deletion/rotation flows for stored connection credentials.
- [ ] Review privacy policy, retention, and compliance obligations.
## Security requirements before production

- The app now parses SQL with `node-sql-parser` and rejects non-SELECT AST nodes, unknown tables, system catalogs, CTEs, locking reads and set operations. This is defense-in-depth only: use a dedicated read-only database account for every external connection.
- External database targets are checked against DNS-resolved private, loopback, link-local and reserved addresses before connection creation and each stored-connection use. Deployments should additionally enforce outbound network egress rules; application DNS checks alone cannot fully prevent DNS rebinding.
- Never expose database credentials in client-side code, logs, analytics, error traces or AI prompts. Use TLS and least-privilege database accounts.
- Configure at least one sign-in provider (Google OAuth and/or SMTP email). Configure `AUTH_SECRET`, `MONGODB_URI`, `MONGODB_DATABASE`, `CONNECTION_ENCRYPTION_KEY`, and `NEXT_PUBLIC_APP_URL` in each deployment environment. `OPENAI_API_KEY` is required to use AI chat.
- `node-sql-parser` is a new runtime dependency. Run `npm install` to generate a fresh `package-lock.json`, commit that lockfile, then run `npm run typecheck`, `npm run lint`, and `npm run build` in an environment with registry access before deployment.

## Commercial features and required environment

Optional billing variables:

- `STRIPE_SECRET_KEY`: Stripe secret API key (test key in staging).
- `STRIPE_WEBHOOK_SECRET`: endpoint signing secret for `/api/billing/webhook`.
- `STRIPE_PRICE_PRO`: recurring monthly Price ID for the Pro plan.
- `STRIPE_PRICE_BUSINESS`: recurring monthly Price ID for the Business plan.
- `ADMIN_EMAILS`: comma-separated administrator email allowlist.

Billing is intentionally unavailable until the Stripe key and matching price IDs are configured. Configure the Stripe webhook and test plan upgrades, cancellation, and webhook retries before enabling live payments. Prices shown in the UI are illustrative and must match your Stripe price configuration.

New application pages: `/reports` for usage charts/CSV export, `/billing` for plan/usage management, and `/admin` for the restricted admin overview. Chat and connection creation endpoints use Mongo-backed request limits, and monthly question usage is reserved atomically before AI processing.

Do not consider this production-ready until dependency installation, typecheck, lint, production build, real database integration tests and Stripe test-mode flows all pass in CI. Application DNS checks alone are not a complete SSRF defense; restrict outbound traffic at the network layer.
