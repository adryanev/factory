#!/usr/bin/env bash
# register-app.sh — the GitHub App manifest flow (spec "Packaging self-host",
# decision 8). Our manifest dictates the permissions: deploy/github-app/
# manifest.json is the only file that says what the App may do, and this
# script POSTs it verbatim — there is no permission checkbox for an operator
# to get wrong.
#
# What the operator does, and what never happens:
#
#   1. Script renders manifest.json into a local HTML form and opens it.
#      The form POSTs the manifest to github.com — the operator only
#      presses "Create GitHub App".
#   2. GitHub redirects the browser to the script's local callback
#      (http://localhost:9999/redirect?code=...). The one-hour clock for
#      completing the flow starts here.
#   3. The script POSTs the code to /app-manifests/{code}/conversions and
#      writes the response: the private key goes STRAIGHT to
#      deploy/keys/github-app-private-key.pem (0600) — it is never printed,
#      never copied, never crosses the clipboard. Only the code does.
#      The webhook secret, app id, and OAuth client id/secret go into .env.
#
# The webhook is the one thing this flow cannot always carry: GitHub refuses
# a manifest whose hook URL is not reachable from the public internet, which
# every localhost install is. When the hook URL is local, the script registers
# the App WITHOUT a hook and prints the post-registration steps instead — the
# App's permissions, which are the part that must not be got wrong, are
# unaffected.
#
# Usage: deploy/github-app/register-app.sh
# Env overrides: FACTORY_WEB_URL (default http://localhost:3000), and the
# hook URL may be given explicitly as FACTORY_WEBHOOK_URL (default
# <FACTORY_WEB_URL>/webhook/github). For a local install, point
# FACTORY_WEBHOOK_URL at a public tunnel (smee.io, ngrok, cloudflared) to
# have the hook registered with the App directly.
#
# Requires: bash, python3 (for the local callback listener), curl, jq, openssl.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname -- "$0")/../.." && pwd)"
MANIFEST_FILE="$ROOT_DIR/deploy/github-app/manifest.json"
KEYS_DIR="$ROOT_DIR/deploy/keys"
ENV_FILE="$ROOT_DIR/.env"
PRIVATE_KEY_FILE="$KEYS_DIR/github-app-private-key.pem"

FACTORY_WEB_URL="${FACTORY_WEB_URL:-http://localhost:3000}"
FACTORY_WEBHOOK_URL="${FACTORY_WEBHOOK_URL:-$FACTORY_WEB_URL/webhook/github}"
REDIRECT_PORT="${FACTORY_MANIFEST_REDIRECT_PORT:-9999}"
REDIRECT_URL="http://localhost:$REDIRECT_PORT/redirect"
OAUTH_CALLBACK_URL="$FACTORY_WEB_URL/auth/github/callback"

for tool in curl jq openssl python3; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "register-app: $tool is required" >&2
    exit 1
  fi
done

mkdir -p "$KEYS_DIR"
chmod 700 "$KEYS_DIR"

if [ -f "$PRIVATE_KEY_FILE" ]; then
  echo "register-app: $PRIVATE_KEY_FILE already exists — refusing to overwrite the App's private key." >&2
  exit 1
fi

case "$FACTORY_WEBHOOK_URL" in
  http://*|https://*) ;;
  *)
    echo "register-app: FACTORY_WEBHOOK_URL must be an http:// or https:// URL, got '$FACTORY_WEBHOOK_URL'" >&2
    exit 1
    ;;
esac

# GitHub validates the hook URL at registration time: anything it cannot
# reach over the public internet is rejected outright ("Hook url is not
# supported because it isn't reachable over the public Internet"), so a
# manifest carrying one can never be created. Decide here, before the
# operator has filled in a form, and register hookless if it is local.
HOOK_IS_PUBLIC=yes
case "$FACTORY_WEBHOOK_URL" in
  *"://localhost"*|*"://127."*|*"://[::1]"*|*"://0.0.0.0"*|*"://10."*|*"://192.168."*|*".local/"*)
    HOOK_IS_PUBLIC=no
    ;;
esac

# Render the manifest with jq: the hookless variant has to DELETE keys, which
# a placeholder substitution cannot express. `default_events` goes with the
# hook — GitHub has no events to deliver without one.
MANIFEST_TMP_FILE="$(mktemp)"
trap 'rm -f "$MANIFEST_TMP_FILE"' EXIT
jq \
  --arg web "$FACTORY_WEB_URL" \
  --arg hook "$FACTORY_WEBHOOK_URL" \
  --arg redirect "$REDIRECT_URL" \
  --arg callback "$OAUTH_CALLBACK_URL" \
  --arg hookIsPublic "$HOOK_IS_PUBLIC" \
  '.url = $web
   | .redirect_url = $redirect
   | .callback_urls = [$callback]
   | if $hookIsPublic == "yes" then .hook_attributes.url = $hook
     else del(.hook_attributes, .default_events) end' \
  "$MANIFEST_FILE" > "$MANIFEST_TMP_FILE"

# The manifest rides in an HTML attribute, so every `"` in it must be an
# entity — unescaped, the browser ends the attribute at the first quote and
# GitHub receives a single `{`.
MANIFEST_ATTR_VALUE="$(jq -Rs -r '@html' < "$MANIFEST_TMP_FILE")"

# The callback listener: catches the redirect from GitHub and extracts the
# code from the query string. python3's http.server logs the full request
# line, which is all we need.
CALLBACK_LOG="$(mktemp)"
python3 -m http.server "$REDIRECT_PORT" > "$CALLBACK_LOG" 2>&1 &
LISTENER_PID=$!
trap 'kill $LISTENER_PID 2>/dev/null || true; rm -f "$CALLBACK_LOG" "$MANIFEST_TMP_FILE"' EXIT

FORM_FILE="$(mktemp)"
cat > "$FORM_FILE" <<EOF
<!doctype html><meta charset="utf-8">
<title>Register the factory GitHub App</title>
<h1>Register the factory GitHub App</h1>
<p>Press the button. GitHub shows a review page where you may edit the app
name; everything else is fixed by our manifest. After you press
<strong>Create GitHub App</strong>, GitHub redirects back to this script's
local callback.</p>
<form action="https://github.com/settings/apps/new" method="post">
  <input type="hidden" name="manifest" value="$MANIFEST_ATTR_VALUE">
  <button type="submit">Create GitHub App from manifest</button>
</form>
EOF

echo "register-app: opening the registration form in your browser..."
echo "  (form also saved at $FORM_FILE; re-run this script to re-open it)"
if command -v open >/dev/null 2>&1; then
  open "$FORM_FILE"
else
  echo "register-app: open $FORM_FILE manually"
fi

echo "register-app: waiting for GitHub to redirect back to $REDIRECT_URL (one-hour window)..."
CODE=""
for _ in $(seq 1 3600); do
  if grep -q "/redirect?code=" "$CALLBACK_LOG" 2>/dev/null; then
    CODE="$(grep -o 'code=[^& ]*' "$CALLBACK_LOG" | head -n1 | cut -d= -f2)"
    break
  fi
  sleep 1
done

if [ -z "$CODE" ]; then
  echo "register-app: no callback within an hour. If your browser showed a"
  echo "  connection-refused page, paste the code from its address bar:"
  echo "  $REDIRECT_URL?code=<CODE>"
  read -r -p "code: " CODE
fi

echo "register-app: exchanging the code for app credentials..."
CONVERSION="$(curl -fsS -X POST \
  -H "accept: application/vnd.github+json" \
  "https://api.github.com/app-manifests/$CODE/conversions")"

# Key material -> FILE, written straight from the response, never printed.
umask 077
printf '%s\n' "$(printf '%s' "$CONVERSION" | jq -r .pem)" > "$PRIVATE_KEY_FILE"
chmod 600 "$PRIVATE_KEY_FILE"

APP_ID="$(printf '%s' "$CONVERSION" | jq -r .id)"
CLIENT_ID="$(printf '%s' "$CONVERSION" | jq -r .client_id)"
CLIENT_SECRET="$(printf '%s' "$CONVERSION" | jq -r .client_secret)"
WEBHOOK_SECRET="$(printf '%s' "$CONVERSION" | jq -r .webhook_secret)"
APP_SLUG="$(printf '%s' "$CONVERSION" | jq -r .slug)"

# A hookless registration mints no webhook secret. Generate it here so .env
# holds the value the control plane verifies HMAC with, and the operator
# pastes the same one into the App's webhook settings.
if [ -z "$WEBHOOK_SECRET" ] || [ "$WEBHOOK_SECRET" = "null" ]; then
  WEBHOOK_SECRET="$(openssl rand -hex 32)"
fi

# .env needs to exist (factory-init creates it); append the App fields if
# they are not there yet.
if [ ! -f "$ENV_FILE" ]; then
  echo "register-app: $ENV_FILE missing — run deploy/init/factory-init.sh first." >&2
  exit 1
fi
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
for pair in \
  "GITHUB_APP_ID=$APP_ID" \
  "GITHUB_OAUTH_CLIENT_ID=$CLIENT_ID" \
  "GITHUB_OAUTH_CLIENT_SECRET=$CLIENT_SECRET" \
  "GITHUB_WEBHOOK_SECRET=$WEBHOOK_SECRET"; do
  key="${pair%%=*}"
  if grep -q "^$key=" "$ENV_FILE" 2>/dev/null; then
    sed -i.bak "s|^$key=.*|$pair|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else
    printf '\n%s\n' "$pair" >> "$ENV_FILE"
  fi
done

echo ""
echo "register-app: done."
echo "  App:       https://github.com/settings/apps/$APP_SLUG"
echo "  App id:    $APP_ID (written to .env)"
echo "  OAuth + webhook secrets: written to .env, shown nowhere"
echo "  Private key: $PRIVATE_KEY_FILE (0600, never printed, never on the clipboard)"
echo ""
if [ "$HOOK_IS_PUBLIC" = "no" ]; then
  echo "The App was registered WITHOUT a webhook: GitHub only accepts a hook URL"
  echo "it can reach over the public internet, and $FACTORY_WEBHOOK_URL is local."
  echo "Finish the webhook by hand — factory receives no events until you do:"
  echo ""
  echo "  1. Open a public channel to your local control plane, e.g."
  echo "       npx smee-client --url https://smee.io/<your-channel> \\"
  echo "         --target $FACTORY_WEBHOOK_URL"
  echo "  2. At https://github.com/settings/apps/$APP_SLUG/advanced set"
  echo "       Webhook URL:    https://smee.io/<your-channel>"
  echo "       Webhook secret: the GITHUB_WEBHOOK_SECRET value now in .env"
  echo "  3. Under Permissions & events, subscribe to: Push, Pull request."
  echo ""
fi
echo "Next: install the App on the repositories factory will touch, then:"
echo "  docker compose up -d"
echo "and log in with your GitHub account — the first user to log in is"
echo "promoted to org owner, after which the bootstrap door closes."
