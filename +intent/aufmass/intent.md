# Aufmass-Modul

Kundenlösung **digitales Aufmaß** (Wuttke Klimatechnik). Maßgebliche Spezifikation — einzige Anforderungsquelle:

`P:\clients\client-wuttkeklimatechnik\+wit\specs\wuttkeklimatechnik\aufmass\001-mvp\`
(`spec.md` Anforderungen · `plan.md` Umsetzungsplan inkl. einring-Ist-Aufnahme · `tasks.md` Tasks mit FR-Bezug)

## Scope in diesem Repo

- Tasks `T013–T018` (`apps/app/src/modules/aufmass/`, `apps/bff/src/modules/aufmass.ts`, `apps/bff/src/nextcloud/client.ts`), später `T019–T020` (Freigabe/PDF)
- **Struktur (FR-016/FR-017, Owner-Entscheidung 2026-11-12):** je Aufmaß genau ein Tables-Context („Anwendung") `AUF <Projekt-ID> <Slug>` mit Tabellen `AUF_<Projekt-ID>_<Slug>_<Typ>`; Typen `bauelemente`, `kanal.summen`, `rohr.summen` (je ein projektübergreifendes Scheme-JSON, `title` pro Projekt/Etage). Einring listet die für den Nutzer freigegebenen Contexts als Projektliste (nicht die `Projekte`-Tabelle) und löst die darin enthaltenen Tabellen/Views auf. Rechtesteuerung liegt vollständig in Nextcloud Tables — Views je Nutzergruppe (Monteur, Buchhaltung, Planung), gesammelt im Context; Einring zeigt die freigegebene View und implementiert kein eigenes Zugriffs-Handling (NFR-004). `MODULE_AUFMASS_APPLICATION_ID` bleibt als Single-Context-Fallback für Dev/Pilot.
- **Mengenmodell je Typ (FR-008):** Bauelemente werden stückweise abgehakt (`Verbaut` +1 je Klick); Kanal/Rohr werden mengenbezogen verbraucht — die eingegebene Menge wird von der zugehörigen Summen-`Wert`-Zeile abgezogen; die Summen-Tabellen tragen deshalb ebenfalls eine `Verbaut`-Spalte (Restmenge = Summen-`Wert` − verbaute Menge).
- **Projekt-Index (FR-017):** die bestehende Tables-Tabelle `Projekte` (table_id 3, `Projekt-ID`/`Label`/Ablageort) ist die ID↔Label-Referenz für andere Lösungen und später die Quelle für Context-/Tabellen-Bezeichnungen bei der Import-Automatisierung — nicht der Anker der Projektliste im Modul.
- Fachlogik (Restmenge, Statusmodell, wer/wann, Summen) baut auf dem vorhandenen generischen Tables-Grid auf
- Konverter/Import liegen in `witnctools` (eigener Pointer dort); das Tables-Schema wird je Typ als Scheme-JSON im Spec-Prozess definiert

## Konventionen

- Akzeptanzkriterien für neue Features vor Implementierung in `+intent/tests.md` (A42-Reihe erweitern) — Task T018
- Spec-Status-Updates werden im Spec-Repo gepflegt, nicht hier
