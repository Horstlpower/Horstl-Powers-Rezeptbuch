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
  `#/bearbeiten/<id>`, `#/favoriten`, `#/einkauf`, `#/mehr`), Ansichten, Mengen-Umrechnung,
  Export/Import, Beispielrezept
- `styles.css` – Gestaltung, heller und dunkler Modus
- `sw.js` – Service Worker für Offline-Betrieb
- `manifest.webmanifest`, `icons/` – Installation als App

## Datenformat eines Rezepts
`{ id, title, category, servings, time, ingredients: [string], steps: [string], notes, source,
photo (data:image/jpeg;base64,…), favorite, createdAt, updatedAt }` – siehe `normalize()` in `app.js`.
Einkaufsliste: IndexedDB-Store `kv`, Schlüssel `shopping`, Liste von `{ id, text, from, done }`.

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
