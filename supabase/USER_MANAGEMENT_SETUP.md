# User Management Setup

1. Apply `20260929_user_management.sql`, then `20260929_user_management_enhancements.sql` to the Supabase project before deploying the Administration pages.
2. Add the following server environment variables alongside the existing public Supabase URL and anon key:

```text
SUPABASE_SERVICE_ROLE_KEY=<server-only Supabase service role key>
NEXT_PUBLIC_SITE_URL=https://your-subtracker-host.example
```

`SUPABASE_SERVICE_ROLE_KEY` must remain server-only and must never use the `NEXT_PUBLIC_` prefix.

3. Add the deployed `/login` and local development `/login` URLs to the Supabase Auth redirect allow-list.
4. The first protected application visit or `/setup` page automatically provisions Rich Gulino (`richg@dobcogroup.com`) as the active, protected Administrator with full permissions. It sends an invitation only if the matching Auth account does not exist.
5. Invite all later users from Administration > User Management.

User routes and management APIs require a valid Supabase Auth session. Table-level role permissions are enforced by the migration's row-level security policies; the API also checks permissions before administrative operations.
