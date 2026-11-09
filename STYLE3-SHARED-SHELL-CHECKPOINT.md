# Style 3 shared-shell checkpoint

Status: local implementation and validation complete; awaiting visual/functional
review. Not committed, pushed, or deployed.

## Bounded scope

- Only `/` and `/contractors` use the reusable production Style 3 shell.
- Dashboard content, data authorities, search, calculations, layout, and appearance
  remain unchanged. Eight viewport screenshots match the pre-extraction baseline
  byte-for-byte.
- Contractors retains its existing workspace, forms, data reads and actions.
  Its workspace now sits beneath the shared header, within the production shell.
- Other application routes, including contractor details, remain on the legacy
  shell until separately approved. Reports has not moved.
- Login visuals/assets and all four authentication-flow page implementations
  remain untouched.

## Architecture

- [Style3Shell](src/components/style3/Style3Shell.tsx) reuses the existing
  [AppSidebar](src/components/AppSidebar.tsx) Style 3 variant, navigation order,
  permissions, icons, branding, active indication, account block and Sign Out.
  It owns the unchanged responsive sidebar toggle behavior.
- [Style3Header](src/components/style3/Style3Header.tsx) contains the extracted
  production header markup and styles. It accepts a page-owned content slot and
  help text. It performs no project, contractor, compliance or email data reads.
- Dashboard supplies its existing search input/results through that slot; search
  state, filtering and data loading remain in
  [Style3Dashboard](src/components/style3/Style3Dashboard.tsx).
- Contractors uses a page-name label instead of a pretend global search. Its
  existing directory search remains the functional search control.
- [AppShell](src/components/AppShell.tsx) retains authentication and module
  authorization and explicitly opts in only the two approved application routes.
- The production 252px sidebar, 900px responsive breakpoint, and 2200px+ V3
  workspace artwork/overlay remain in
  [shell.module.css](src/components/style3/shell.module.css). Artwork does not
  extend into the sidebar. Contractors receives the same 2100px workspace cap.
- A Contractors-wrapper-only rule allows its legacy directory toolbar to wrap
  when the available workspace cannot fit its existing controls. This prevents
  clipping at 1024px without editing the Contractors page or redesigning controls.
  Tables retain their existing internal horizontal scrolling on small screens.

## Authentication-flow exceptions

`/login`, `/setup`, `/invite` and `/reset-password` bypass application navigation,
profile authorization and the shell's bootstrap/session listeners.

Invitation and password-reset pages already validate their own link/session and
must remain reachable without application-module permissions. Their password
update, sign-out, redirect, token handling and email behavior were not changed.
Setup retains its own existing bootstrap request; the shell does not duplicate it.
Authenticated application routes still require a session and module permission.

## Validation

All browser tests intercept external requests and application APIs with synthetic
fixtures. No real credentials, production data mutations, or email sends are used.

- Dashboard pre/post screenshot equality at 2560x1440, 1920x1080, 1536x864,
  1366x768, 1280x800, 1024x768, 768x1024 and 390x844.
- Shared-shell checks at those sizes plus 320x640: navigation order/icons/active
  route, real logo, sidebar toggle and mobile navigation close, workspace bounds,
  large-screen artwork, no horizontal page overflow and unclipped main controls.
- Contractors search, filters, sorting, active/inactive tabs, Add modal, header
  help/account, keyboard Sign Out, denied access and unauthenticated redirect.
- All four auth-flow bypasses with and without a session; valid/invalid invitation
  and recovery rendering; setup bootstrap remains single and page-owned.
- Reports remains on the legacy shell; Contractors shell requests no Dashboard
  eligibility, follow-up or email data.
- Existing Dashboard browser regressions pass, including data, interactions,
  failures, permissions and mobile behavior.
- Contractors identifier browser regressions pass; all nine initial-contact
  browser scenarios pass. The latter test now enters the retained legacy
  Dashboard through Review Details rather than expecting the removed top-level
  legacy Add Contractor link.
- Sixteen fixture-only Dashboard/Contractors unit/service checks pass.
- Frozen Login authentication/recovery/session/redirect/responsive regression passes.
- TypeScript, scoped ESLint and `git diff --check` pass.
- Isolated production build passes using `.next-shared-shell-check`; all 85 static
  pages generate. Temporary build configuration was restored afterward.
- The isolated production preview on port 3002 returned HTTP 200; shared-shell,
  Dashboard, Contractors identifier and Login browser regressions also passed
  against that production bundle. The temporary server was stopped afterward.

Browser fixture commands (PowerShell):

```powershell
$env:TEST_APP_URL='http://localhost:3000'
node scripts\test-style3-shell-ui.mjs
node scripts\test-style3-dashboard-ui.mjs
node scripts\test-contractor-fein-ui.mjs
node scripts\test-contractor-contacts-ui.mjs
node scripts\test-login-ui.mjs
```

For review captures, set `SHELL_SCREENSHOT_DIR` to an absolute existing/writable
directory. `DASHBOARD_VISUAL_DIR` captures the eight Dashboard baseline images;
`DASHBOARD_COMPARE_BASELINE=1` compares against those existing captures instead
of overwriting them. Do not recapture a baseline during comparison.

The VS Code shared-browser connection timed out. Actual localhost screenshots
and checks were produced through the repository's existing headless Playwright
setup; this is not production live-data validation.

## Review boundary

Stop here. No Contractors workspace redesign, Reports relocation, route fan-out,
SQL changes, worker changes, commit, push or deployment is included.
Unrelated local work is preserved.
