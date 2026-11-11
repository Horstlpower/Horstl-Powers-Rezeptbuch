# Horstl Powers Rezeptbuch – Projektnotizen für Claude

Persönliches Rezeptbuch als **Web-App (PWA)** für iPhone und Android. Der Nutzer spricht Deutsch –
alle Texte in der App und alle Antworten auf Deutsch.

## Entscheidungen (mit dem Nutzer abgestimmt)
- PWA statt nativer App: kein Mac vorhanden (Windows), kein App Store nötig, kostenlos.
- Reines HTML/CSS/JavaScript, **kein Build-Schritt, keine Abhängigkeiten**.
- Rezepte liegen **nur lokal** auf dem Gerät (IndexedDB). Keine Cloud, kein Server.
- Übertragung zwischen Geräten per **Export/Import einer JSON-Datei** (Mehr-Tab). Import führt
  zusammen: neue Rezepte kommen dazu, vorhandene (gleiche `id`) nur bei neuerem `updatedAt`.
- Repository ist **öffentlich**, damit GitHub Pages kostenlos funktioniert.
- Veröffentlichung über GitHub Pages aus dem Branch `main`, Ordner `/` (Wurzel).

## Dateien
- `index.html` – Grundgerüst, Kopfzeile, Tableiste
- `app.js` – gesamte Logik: Datenbank, Router (Hash-Routen `#/`, `#/rezept/<id>`, `#/neu`,
  `#/bearbeiten/<id>`, `#/favoriten`, `#/einkauf`, `#/einkauf/auswahl`,
  `#/einkauf/rezept/<id>?p=<portionen>&von=rezept`, `#/vorrat`, `#/vorrat/kochen`, `#/tiefkuehl`, `#/tiefkuehl/<id>`, `#/mehr`), Ansichten, Mengen-Umrechnung,
  Export/Import, Beispielrezept
- `styles.css` – Gestaltung, heller und dunkler Modus
- `sw.js` – Service Worker für Offline-Betrieb
- `manifest.webmanifest`, `icons/` – Installation als App

## Datenformat eines Rezepts
`{ id, title, category, servings, time, ingredients: [string], spices: [string], steps: [string], notes, source,
photo (data:image/jpeg;base64,…), favorite, createdAt, updatedAt }` – siehe `normalize()` in `app.js`.
Gewürze (`spices`, fehlt bei alten Rezepten): Formular bietet die eigene Gewürzliste als Knöpfe + Freitext.
Eigene Listen (`LISTS`, `getList`/`setList`): kv `spiceList` (Gewürze) und `opList` (Arbeitsschritte fürs
Zubereitungsfeld), bearbeitbar unter `#/mehr/liste/gewuerze|schritte`; ohne gespeicherten Wert gelten
`STANDARD_SPICES`/`STANDARD_OPS`. Export enthält `lists`, Import führt sie zusammen (nur ergänzen). Anzeige über
`ingListHtml()` – Zutaten oben, Gewürze unten; Index ≥ `ingredients.length` = Gewürz (`allIngs()`).
Vorrat/„Was kann ich kochen?“ prüfen bewusst nur `ingredients`, nicht die Gewürze.
Einkaufsliste: IndexedDB-Store `kv`, Schlüssel `shopping`, Liste von `{ id, text, from, done, addedAt }`
(`addedAt` = Datumsstempel, fehlt bei alten Einträgen), Schlüssel `shoppingChangedAt` = „Stand“ der Liste.
Hintergrundfoto der Startseite: Store `kv`, Schlüssel `bgPhoto` (data-URL, leer = Standard-Verlauf).
„Was koche ich heute?“ (Startseite): Grobauswahl `MOODS` in `app.js`, erkannt über Stichwörter
(`MOOD_WORDS`) in Titel und Zutaten – kein eigenes Rezeptfeld. Neue Stichwörter dort ergänzen.
Vorrat: Store `kv`, Schlüssel `pantry` = `{ have: [Wortstamm], extra: [Name], removed: [Stamm gelöschter
Grundliste-Einträge], names: { Stamm: Anzeige-Name }, changedAt }`. Bearbeiten-Modus: umbenennen/entfernen. Zutatenliste wird aus allen
Rezepten erzeugt plus feste Grundliste `BASE_PANTRY` (vom Nutzer vorgegeben). `ingNames()` entfernt Menge/Einheit,
`ingStem()` macht Ei/Eier gleich und führt gleichbedeutende Namen über `ING_ALIASES` zusammen
(österreichisch: Rahm=Sahne, Germ=Hefe, Faschiertes=Hackfleisch, Gurkerl=Essiggurken). Abgleich in `pantryMatches()`.
Tiefkühl (im Vorrat-Reiter umschaltbar): Store `kv`, Schlüssel `freezer` = Liste von
`{ id, name, amount, cat, date: 'JJJJ-MM-TT', plan: { kind: 'recipe'|'idea', id?, text } | null, addedAt }`.
Arten + empfohlene Lagermonate in `FREEZER_CATS`, Ideen in `FREEZER_IDEAS`. Tiefkühl-Produkte zählen beim
„Was kann ich kochen?“ automatisch als vorhanden.
Hintergrundfoto: nicht Teil des Exports. Auswahl nur im Mehr-Tab (nicht auf der Startseite, damit sie aufgeräumt bleibt).
Ablauf Einkauf: Rezept wählen → abhaken, was zuhause ist → Rest kommt auf die Liste (keine Doppelten).

## Bei Änderungen beachten
- **`CACHE`-Version in `sw.js` erhöhen** (z. B. `rezeptbuch-v2`) und `APP_VERSION` in `app.js`
  anpassen, sonst bekommen installierte Apps die Änderung nicht mit.
- Das Datenformat abwärtskompatibel halten – alte Export-Dateien müssen weiter importierbar sein.
- Nutzerdaten immer mit `esc()` ausgeben, Bilder nur über `safeImg()`, Links nur über `safeUrl()`.
- Nur relative Pfade verwenden (die App läuft unter `/Horstl-Powers-Rezeptbuch/`).
- Element-IDs müssen eindeutig sein – `index.html` belegt bereits `title`, `view`, `toast`,
  `backBtn`, `topActions` (eine doppelte `title`-ID hat in 1.0.0 das Speichern kaputt gemacht).
  Beim Testen Formularfelder über das Formular ansprechen, nicht nur über `getElementById`.
- In Event-Handlern nach einem `await` nie `e.currentTarget` benutzen – Safari setzt es auf `null`
  (Favoriten-Fehler in 1.0.2). Element vorher in einer Variablen merken.
- Fehler nie still schlucken: `showError()` nutzen (Hinweis + Dialog, sichtbar trotz iPhone-Tastatur).
- Service Worker lädt zuerst aus dem Netz, offline aus dem Cache.

## Lokal testen
Im Projektordner einen einfachen Webserver starten (z. B. `python -m http.server 8080`) und
`http://localhost:8080` öffnen. Direktes Öffnen der `index.html` geht auch, dann aber ohne Offline-Modus.

## Veröffentlichen
`git add -A`, `git commit`, `git push` – GitHub Pages aktualisiert sich nach ca. 1 Minute.

## Ideen für später
- Mehrere Fotos pro Rezept, Tags, Bewertung
- Rezept aus Website-Link importieren
- Kochmodus (Bildschirm bleibt an, große Schrift, Schritt für Schritt)

Rezepttext einfügen: `parseRecipeText(text, spiceList)` (vor `viewEdit`) zerlegt kopierten Text (z. B. iPhone
Live Text) heuristisch in Titel/Portionen/Zeit/Zutaten/Gewürze/Schritte/Notizen; Formular: Einfügen je Feld (`data-paste`, paste-Event auf Titel/Zutaten/Zubereitung, force = ing|step).
Layout: `.cards` braucht `grid-template-columns: minmax(0,1fr)`, sonst machen lange Namen die Seite breiter als das Display.
