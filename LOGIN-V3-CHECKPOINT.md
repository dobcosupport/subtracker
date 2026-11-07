# Login V3 checkpoint

## Approved visual scope

- Full-viewport [V9 background](public/subtracker-app-background-v9.png), using cover with top-centered desktop cropping and the approved mobile crop.
- Welcome/features and right-side decorative branding are contained in V9; no duplicate HTML branding overlay.
- Centered functional sign-in form with unchanged dimensions, spacing, typography, and responsive geometry.
- Transparent outer container with no visible border or conventional shadow; a feathered 15% white, 10px-blur layer provides subtle grouping without a rectangular panel.
- The real [Dobco logo](public/Logo.png), 93% white input surfaces, solid-blue Sign In, and 80% white Initial Setup remain independent of the glass layer.
- [Login V3 reference](public/subtracker-login-v3-reference.png) is reference-only and is not rendered.

## Behavior preserved

Supabase sign-in, session persistence, successful-login redirect, denied protected-route redirect, password visibility, error handling, Forgot Password/recovery, and Initial Setup navigation are unchanged. Dashboard and other pages are outside this checkpoint.

## Validation

- Intercepted successful/rejected sign-in, persistence, protected-route denial/redirect, recovery success/failure, return-to-login, password visibility, keyboard focus, and Initial Setup navigation. No real recovery email is sent.
- Responsive coverage: 2560x1440, 1920x1080, 1536x864, 1440x900, 1366x768, 1280x800, 1024x768, tablet, 390x844, 320x640, and 125%/150% zoom.
- Actual localhost 2560x1440 and 1366x768 captures visually approved.
- TypeScript, scoped ESLint, isolated production build, and `git diff --check`.

Run the intercepted regression with PowerShell:

```powershell
$env:TEST_APP_URL = 'http://localhost:3000'
node scripts\test-login-ui.mjs
```

Deployment is through the exact checkpoint commit on `origin/main`, not a dirty-worktree upload.
