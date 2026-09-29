# User Management Setup

1. Apply `20260929_user_management.sql`, `20260929_user_management_enhancements.sql`, then `20260929_user_inactivity_management.sql` to the Supabase project before deploying the Administration pages.
2. Add the following server environment variables alongside the existing public Supabase URL and anon key:

```text
SUPABASE_SERVICE_ROLE_KEY=<server-only Supabase service role key>
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

In Vercel, set `NEXT_PUBLIC_APP_URL` to `https://subtracker-one-pied.vercel.app`.

The Auth invite and recovery templates are in `supabase/templates`. Configure the local Supabase project with `supabase/config.toml`. For the hosted project, copy `invite.html` and `recovery.html` into Authentication > Email Templates, and set the Auth Site URL to the deployed app URL so the logo resolves. The invitation and reset links themselves use the `redirectTo` supplied by the application.

`SUPABASE_SERVICE_ROLE_KEY` must remain server-only and must never use the `NEXT_PUBLIC_` prefix.

3. Add the deployed `/login` and local development `/login` URLs to the Supabase Auth redirect allow-list.
4. The first protected application visit or `/setup` page automatically provisions Rich Gulino (`richg@dobcogroup.com`) as the active, protected Administrator with full permissions. It sends an invitation only if the matching Auth account does not exist.
5. Invite all later users from Administration > User Management.

User routes and management APIs require a valid Supabase Auth session. Table-level role permissions are enforced by the migration's row-level security policies; the API also checks permissions before administrative operations.
