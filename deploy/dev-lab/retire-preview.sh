#!/usr/bin/env bash
# Retire an old preview route (Sprint 10, owner decision: development builds go to dev-lab `/`
# only). The route keeps answering, behind the same gate, but with a small static page that says
# the preview has ended and links to the current app — never an old build that looks like the app.
# Nothing else changes: no Caddy edit, `/` is not redirected, the old preview builds stay on disk.
#
#   deploy/dev-lab/retire-preview.sh s9-preview      (or s10-preview)
#
# Projects created in a preview were stored in that preview's own browser storage namespace;
# they stay in the browser. To export them, re-open the preview temporarily (printed below).
set -euo pipefail
name="${1:?usage: retire-preview.sh s9-preview|s10-preview}"
case "$name" in s9-preview | s10-preview) ;; *) echo "unknown preview: $name" >&2; exit 2 ;; esac
root="/srv/tbi-lab/$name"
sudo test -L "$root/current"
previous="$(readlink -f "$root/current")"
page="$root/retired-$(date -u +%Y%m%d)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/index.html" <<'HTML'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Preview retired · TBI Lab</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; background: #f4f6f8; color: #14181f; }
  main { max-width: 38rem; margin: 12vh auto; padding: 2rem; background: #fff; border: 1px solid #d5dbe1; border-radius: 8px; }
  h1 { font-size: 1.3rem; margin-top: 0; }
  a.button { display: inline-block; margin-top: 0.5rem; padding: 0.55rem 1rem; background: #1f4e8c; color: #fff; border-radius: 6px; text-decoration: none; font-weight: 600; }
  .he { margin-top: 2rem; padding-top: 1.2rem; border-top: 1px solid #e3e7eb; }
  .muted { color: #5b6470; font-size: 0.9rem; }
</style>
</head>
<body>
<main>
  <h1>This preview has been retired</h1>
  <p>Development builds of TBI Lab are now published only to the main address. Open the current
  app there; its version is shown at the bottom of every screen.</p>
  <a class="button" href="/">Open the current TBI Lab</a>
  <p class="muted">Projects you created in this preview are still stored in this browser. If you
  need one of them, ask for the preview to be re-opened temporarily so you can export it.</p>
  <div class="he" dir="rtl" lang="he">
    <h1>תצוגה מקדימה זו הסתיימה</h1>
    <p>גרסאות הפיתוח של TBI Lab מתפרסמות כעת רק בכתובת הראשית. הגרסה מוצגת בתחתית כל מסך.</p>
    <a class="button" href="/">פתיחת TBI Lab העדכני</a>
    <p class="muted">פרויקטים שנוצרו בתצוגה המקדימה עדיין שמורים בדפדפן זה. אם נדרש אחד מהם,
    ניתן לבקש לפתוח שוב את התצוגה המקדימה זמנית כדי לייצא אותו.</p>
  </div>
</main>
</body>
</html>
HTML
sudo install -d -m 0755 "$page"
sudo install -m 0644 "$tmp/index.html" "$page/index.html"
sudo ln -sfn "$page" "$root/current.tmp"
sudo mv -T "$root/current.tmp" "$root/current"
echo "retired /$name/ -> $page (previous build kept: $previous)"
echo "to re-open it: sudo ln -sfn $previous $root/current.tmp && sudo mv -T $root/current.tmp $root/current"
