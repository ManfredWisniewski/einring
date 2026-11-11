# Aufmass-Modul

Kundenlösung **digitales Aufmaß** (Wuttke Klimatechnik). Maßgebliche Spezifikation — einzige Anforderungsquelle:

`P:\clients\client-wuttkeklimatechnik\+wit\specs\wuttkeklimatechnik\aufmass\001-mvp\`
(`spec.md` Anforderungen · `plan.md` Umsetzungsplan inkl. einring-Ist-Aufnahme · `tasks.md` Tasks mit FR-Bezug)

## Scope in diesem Repo

- Tasks `T013–T018` (`apps/app/src/modules/aufmass/`, `apps/bff/src/modules/aufmass.ts`, `apps/bff/src/nextcloud/client.ts`), später `T019–T020` (Freigabe/PDF)
- Das Modul bindet einen dedizierten Nextcloud-Tables-Context (`MODULE_AUFMASS_APPLICATION_ID`); Fachlogik (Restmenge, Statusmodell, wer/wann, Summen) baut auf dem vorhandenen generischen Tables-Grid auf
- Konverter/Import liegen in `witnctools` (eigener Pointer dort); Tables-Schema ist als JSON im Spec-Prozess definiert

## Konventionen

- Akzeptanzkriterien für neue Features vor Implementierung in `+intent/tests.md` (A42-Reihe erweitern) — Task T018
- Spec-Status-Updates werden im Spec-Repo gepflegt, nicht hier
