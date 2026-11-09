# Login visual direction

The layout uses the supplied reference's two-panel composition: a school-community illustration on the left and a compact, centred form on the right. The product name is **SMS**, presented as a bold uppercase wordmark without a graduation-cap badge. Blue/navy remain the brand colors. The reference's university logo, Christmas scene and green palette are not copied.

## Theme behavior

Login follows the device's color preference automatically: light by default, dark when the device requests dark. It has no theme switcher. Its System scope is isolated from the workspace's saved manual choice, so returning to login does not overwrite dashboard preferences. The existing theme engine resolves the device theme in its bootstrap script and listens for live system changes.

Inside the dashboard, a compact icon-and-label selector offers **System (device setting), Light, Dark**. System is the default; manual selections persist across refresh. Desktop uses the sidebar footer, while mobile puts the same control in the Workspace menu footer, with the role on a separate line. The native select provides keyboard and screen-reader behavior, a visible focus outline and a 48px labelled touch area.

## Palette review

The existing text and muted neutrals are usable: text/card contrast is 16.33:1 in light mode and 16.21:1 in dark mode; muted/card contrast is 5.84:1 and 6.76:1. Keep those tokens.

The current global `.gradient` uses white text on theme-dependent blue/purple. White contrast falls to 4.48:1 at the light purple endpoint, and 3.07/2.90:1 at the two dark endpoints. Normal text needs at least 4.5:1 under [WCAG's contrast criterion](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html). The brand can stay blue; its controls need a separate contrast-safe treatment.

| Use | Color | Contrast note |
|---|---|---|
| Login action gradient | `#3157E8` → `#6147E8` | Full white text: 5.74–5.87:1 |
| Existing light text/muted | `#152033` / `#57667C` | Retained |
| Existing dark text/muted | `#F5F7FF` / `#94A3B8` | Retained |
| Illustration | Ink navy, royal blue, periwinkle, small sage accents | Decorative asset; no embedded text |
| Form surfaces | Existing `--surface` / `--surface-2` | Follow the selected theme |

Login-specific styles keep this change scoped. Other dashboards still use their existing global tokens and need a separate UI contrast pass before claiming site-wide compliance.

## Illustration asset and exact prompt

Final application asset: `public/images/login-school-illustration.webp`, 1200 × 1200, 217,446 bytes, with its transparency retained. Generated using the built-in image generation tool; converted to WebP for the application. The source image remains in the Codex generated-image folder. The exact generation prompt below predates the SMS wordmark rename; the image itself contains no text or logo and remains suitable.

```text
Create a premium editorial illustration for the left panel of SMS, a modern Indian school management web app. A cohesive contemporary school campus scene: a small elegant school building with a blue pitched roof and arched entrance, a friendly adult teacher holding a tablet, an Indian parent and two school-age students with simple backpacks, a small tree and subtle floating calendar/checkmark cards representing attendance and connected school work. Sophisticated flat vector-like cut-paper illustration with soft dimensional shading, crisp clean contours, restrained fine grain, carefully balanced architectural shapes, warm human character, no photorealism and no shiny plastic 3D. Palette: deep ink navy #183253, saturated royal blue #3157E8, lavender #A8B7F2, pale periwinkle #E6ECFF, muted sage #7DA99A as a very small accent, warm sand skin tones. Centered landscape grouping inside an approximately square canvas; all objects form one balanced connected composition, with generous clear margins on all sides. Slightly elevated front-facing perspective, gentle contact shadows beneath the scene. Transparent background, clean alpha cutout, no rectangular backdrop, no large background blob. The app will place this illustration on a pale blue-white panel, so make the subject remain clearly visible there. Absolutely no words, letters, numbers, logos, watermarks, interface screenshots, login form, decorative sparkle clutter or unreadable fake text. Not a UI mockup: deliver only the standalone school/community illustration at high quality.
```

## Layout checks

Desktop outer padding and frame height must use the same value; the former `48px` padding plus `100vh - 32px` minimum frame caused at least 16px of extra page height. The illustration must shrink inside the frame, rather than establish another fixed minimum height. Keep the form narrow enough for clear reading and vertically centred at normal laptop sizes.

On phones hide the illustration and prioritise the form. On very short screens or at enlarged text/zoom, allow vertical scrolling rather than cutting off inputs or buttons. Email/password and Google still use the existing Supabase handlers and callback route. Password visibility, loading/error feedback and the existing password-recovery link should remain accessible by keyboard.

## Initial visual checkpoint — 5 November 2026

Headless installed Chrome checked the running development app in both light and dark mode. The generated image loaded in both themes; no browser page errors were observed.

| Viewport | Result in both themes |
|---|---|
| 1440 × 900, 1366 × 768, 1280 × 720, 1024 × 768 | No document overflow on either axis; illustration visible and form contained |
| 390 × 844 | Form only, no document overflow on either axis |
| 375 × 667, 320 × 568 | Form only; vertical scrolling keeps the full form reachable; no horizontal overflow |
| 1280 × 600, 683 × 384 | Short-screen fallback scrolls vertically without horizontal overflow or clipped form content |
| Invalid-password state at 1280 × 720 | Error readable; document and form panel fit without scrolling |

Password reveal/hide retained the value. The invalid-password request was intercepted in the local browser and answered with a synthetic HTTP 400; no real login or account mutation was performed. Successful password navigation, Google callback configuration, mutually exclusive pending actions, provider/network error recovery and the password-recovery link have automated coverage: all 65 focused login/auth/recovery/shell tests passed across five files. Whole-project lint, TypeScript and diff checks also passed after the UI changes. The separate full audit's 847-test run predates this redesign; these are distinct verification checkpoints. No fresh production build or deployment was run for the redesign.

The 683 × 384 check represents a smaller effective viewport; browser zoom itself and real provider sign-in remain manual checklist cases. See [founder login checks](../implementation/POST-DEPLOY-QA.md#login-screen-redesign).

## SMS wordmark and automatic-theme follow-up

The follow-up passed 69 focused theme/login/auth/recovery/shell tests across six files and 23 invitation regressions across three further files, plus whole-project lint and TypeScript. Tests use the actual installed theme engine for saved/manual/System preferences and route changes. Tailwind's dark variant now follows the same `.dark` class as the theme provider, so a manual selection also updates navigation and other dark utilities when the device preference differs.

Installed Chrome verified both device themes at 1366 × 768, 1280 × 720, 1024 × 768, 390 × 844 and 320 × 568. Normal laptop frames fit, no horizontal overflow appeared and the smallest viewport retained vertical scrolling. The SMS wordmark, removed cap badge/control and updated document title were checked. With external application JavaScript blocked, the inline bootstrap still selected the device theme despite an opposite saved dashboard preference; hydrated login also responded to live device changes.

An existing hosted-demo QA teacher login verified: login uses device Dark despite a saved Light choice → dashboard restores Light → choose Dark → hard reload retains Dark → choose System → a live device change updates the dashboard → mobile Workspace menu can choose Dark → Logout returns to the device's Light login while retaining the dashboard's saved Dark choice. Both the dashboard and login had no monitored page errors. The mobile theme control's native hit area was 110 × 46px within its 112 × 48px label, with visible keyboard focus and no horizontal page overflow. The QA account was signed out. No school records were edited, and no commit, push, fresh production build or deployment was made.

No backend permission or financial audit fix is part of this visual change.
