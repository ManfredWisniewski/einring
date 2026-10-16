# einring × biti — component gaps (TODO)

UI ported from biti (`P:\git\arr\biti`, `src/components/ui/`) on 2026-10-16:
button, card, input, label, select, textarea, checkbox, pagination + `cn()` in
`apps/app/src/utilities/ui.ts`. Styling resolves via the `@theme inline` bridge
in `apps/app/src/styles/global.css` onto `@einring/tokens` vars. Target biti
theme: **wuttke** (exists in biti since 2026-10-16; resolved values ship in
`apps/bff/themes/wuttke.json`, selected via `INSTANCE_THEME=wuttke` at deploy time).

## Components einring needs that biti does not have

Do not implement these locally — they belong in biti so all consumers share them.
Current fallbacks stay in place until biti provides them.

| Component | Needed for | Current fallback |
|---|---|---|
| Tabs | Monitor page: Server / Talk switching | `react-aria-components` Tabs |
| Popover + Dialog | App info popover (A06: close button, Escape, outside interaction, focus return) | RAC `DialogTrigger` / `Popover` / `Dialog` |
| Table / DataTable | Nextcloud Tables grid (columns + rows, sticky header, scrollable) | `src/components/DataTable.tsx` (`.data-table`) |
| Alert / Banner | Error and success banners: login config errors, gates, retry rows, sync errors | `.alert` / `.alert--danger` / `.alert--success` (biti `Banner` is a Lexical rich-text block, not a standalone component) |
| Meter / Progress | Server memory, swap and storage-quota bars | native `<meter>` (`.meter`) |
| Badge / StatusDot | Talk user presence (online / away / dnd / offline) | `.status-list` + `.status-dot` |
| DefinitionList | Server facts grid (version, webserver, PHP, DB, CPU, space, users, apps) | `.defs` |
| TreeView | Wiki navigation: collective → folder → page hierarchy | `.wiki-tree` + ghost buttons |
| NavigationMenu | App-level module nav bar | `.app-nav` NavLinks |
| Spinner | Loading states (currently muted text) | `<p className="muted">` |
| `wuttke` theme components | theme-specific UI variants | values done (`apps/bff/themes/wuttke.json` + `INSTANCE_THEME`); theme components still open |
