#!/usr/bin/env bash
# Build the macOS universal bundle in CI with Developer ID signing + Apple notarization.
#
# Gatekeeper blocks downloaded apps that are only ad-hoc signed (signingIdentity "-").
# A downloaded app opens normally only if it is
#   1) signed with a "Developer ID Application" certificate, and
#   2) notarized by Apple (and the ticket stapled).
#
# Required GitHub secrets (Settings > Secrets and variables > Actions):
#   APPLE_CERTIFICATE           base64 of the exported "Developer ID Application" .p12
#   APPLE_CERTIFICATE_PASSWORD  password used when exporting the .p12
# Notarization, option A (Apple ID):
#   APPLE_ID                    Apple ID email of the developer account
#   APPLE_PASSWORD              app-specific password (appleid.apple.com > Sign-In and Security)
#   APPLE_TEAM_ID               Team ID (e.g. GMXNVH8YU9)
# Notarization, option B (App Store Connect API key):
#   APPLE_API_ISSUER            Issuer ID
#   APPLE_API_KEY               Key ID
#   APPLE_API_KEY_P8            full contents of the AuthKey_XXXX.p8 file
# Optional:
#   APPLE_SIGNING_IDENTITY      e.g. "Developer ID Application: Name (GMXNVH8YU9)" (auto-detected otherwise)
#   REQUIRE_MAC_SIGNING=1       fail instead of falling back to an ad-hoc (unsigned) build
set -euo pipefail

BUNDLE_DIR="src-tauri/target/universal-apple-darwin/release/bundle"
WORK_DIR="${RUNNER_TEMP:-/tmp}/easyviewer-macos-signing"
KEYCHAIN_PATH="$WORK_DIR/signing.keychain-db"
KEYCHAIN_PASSWORD="$(uuidgen)"
mkdir -p "$WORK_DIR"

cleanup() {
  if [ -f "$KEYCHAIN_PATH" ]; then
    security delete-keychain "$KEYCHAIN_PATH" >/dev/null 2>&1 || true
  fi
  rm -f "$WORK_DIR/certificate.p12" "$WORK_DIR"/AuthKey_*.p8
}
trap cleanup EXIT

fail_or_warn() {
  if [ "${REQUIRE_MAC_SIGNING:-0}" = "1" ]; then
    echo "::error::$1"
    exit 1
  fi
  echo "::warning::$1"
}

SIGNED=0
NOTARIZE=0
SIGNING_IDENTITY="-"

# ---------------------------------------------------------------- 1. certificate
if [ -n "${APPLE_CERTIFICATE:-}" ]; then
  echo "$APPLE_CERTIFICATE" | base64 --decode > "$WORK_DIR/certificate.p12"

  security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
  security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
  security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
  security import "$WORK_DIR/certificate.p12" -k "$KEYCHAIN_PATH" \
    -P "${APPLE_CERTIFICATE_PASSWORD:-}" -f pkcs12 \
    -T /usr/bin/codesign -T /usr/bin/security -T /usr/bin/productbuild
  security set-key-partition-list -S apple-tool:,apple:,codesign: \
    -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH" >/dev/null
  # Put the CI keychain first in the search list so codesign can find the identity.
  EXISTING_KEYCHAINS=$(security list-keychains -d user | sed -e 's/^[[:space:]]*"//' -e 's/"$//')
  # shellcheck disable=SC2086
  security list-keychains -d user -s "$KEYCHAIN_PATH" $EXISTING_KEYCHAINS

  echo "Available code signing identities:"
  security find-identity -v -p codesigning "$KEYCHAIN_PATH"

  if [ -n "${APPLE_SIGNING_IDENTITY:-}" ] && [ "${APPLE_SIGNING_IDENTITY}" != "-" ]; then
    SIGNING_IDENTITY="$APPLE_SIGNING_IDENTITY"
  else
    SIGNING_IDENTITY=$(security find-identity -v -p codesigning "$KEYCHAIN_PATH" \
      | grep '"Developer ID Application' | head -n 1 | sed -E 's/.*"(.*)"/\1/' || true)
  fi

  if [ -z "$SIGNING_IDENTITY" ] || [ "$SIGNING_IDENTITY" = "-" ]; then
    echo "::error::APPLE_CERTIFICATE does not contain a 'Developer ID Application' identity. 'Apple Development' / 'Apple Distribution' certificates cannot be used for apps distributed outside the App Store."
    exit 1
  fi
  case "$SIGNING_IDENTITY" in
    "Developer ID Application"*) ;;
    *) echo "::warning::Signing identity '$SIGNING_IDENTITY' is not a Developer ID Application certificate; Gatekeeper will still block downloaded builds." ;;
  esac
  echo "Using signing identity: $SIGNING_IDENTITY"
  SIGNED=1
else
  fail_or_warn "APPLE_CERTIFICATE secret is not set. Building with an ad-hoc signature; macOS Gatekeeper will block the downloaded app."
fi

# Tauri imports APPLE_CERTIFICATE itself when present; we already did it, so hide it.
unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD
export APPLE_SIGNING_IDENTITY="$SIGNING_IDENTITY"

# ---------------------------------------------------------------- 2. notarization credentials
NOTARY_ARGS=()
if [ "$SIGNED" = "1" ]; then
  if [ -n "${APPLE_API_ISSUER:-}" ] && [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_KEY_P8:-}" ]; then
    export APPLE_API_KEY_PATH="$WORK_DIR/AuthKey_${APPLE_API_KEY}.p8"
    printf '%s\n' "$APPLE_API_KEY_P8" > "$APPLE_API_KEY_PATH"
    unset APPLE_ID APPLE_PASSWORD
    NOTARY_ARGS=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER")
    NOTARIZE=1
  elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
    unset APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH
    NOTARY_ARGS=(--apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID")
    NOTARIZE=1
  else
    unset APPLE_ID APPLE_PASSWORD APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH
    fail_or_warn "Notarization credentials are missing (APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID or APPLE_API_ISSUER/APPLE_API_KEY/APPLE_API_KEY_P8). The app will be signed but not notarized, so Gatekeeper will still block it."
  fi
fi

# ---------------------------------------------------------------- 3. build (Tauri signs + notarizes + staples the .app)
OVERRIDE_CONFIG="$WORK_DIR/tauri.signing.conf.json"
node -e '
  const fs = require("fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({
    bundle: { macOS: { signingIdentity: process.argv[2], hardenedRuntime: true } }
  }));
' "$OVERRIDE_CONFIG" "$SIGNING_IDENTITY"

npx tauri build --target universal-apple-darwin --bundles app,dmg --config "$OVERRIDE_CONFIG"

APP_PATH=$(find "$BUNDLE_DIR/macos" -maxdepth 1 -name '*.app' -print -quit)
DMG_PATH=$(find "$BUNDLE_DIR/dmg" -maxdepth 1 -name '*.dmg' -print -quit)
echo "App: $APP_PATH"
echo "DMG: $DMG_PATH"

# ---------------------------------------------------------------- 4. sign + notarize + staple the DMG itself
if [ "$SIGNED" = "1" ]; then
  codesign --force --timestamp --sign "$SIGNING_IDENTITY" "$DMG_PATH"
fi
if [ "$NOTARIZE" = "1" ]; then
  xcrun notarytool submit "$DMG_PATH" "${NOTARY_ARGS[@]}" --wait --timeout 30m
  xcrun stapler staple "$DMG_PATH"
  xcrun stapler validate "$APP_PATH"
  xcrun stapler validate "$DMG_PATH"
fi

# ---------------------------------------------------------------- 5. verification
codesign --verify --deep --strict -vvv "$APP_PATH"
codesign -dv --verbose=2 "$APP_PATH" 2>&1 | grep -E 'Authority|TeamIdentifier|flags' || true
hdiutil verify "$DMG_PATH"
if [ "$NOTARIZE" = "1" ]; then
  spctl --assess --type execute --verbose=4 "$APP_PATH"
  spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG_PATH"
fi

# Zip the .app with ditto: upload-artifact drops executable bits and symlinks,
# which breaks a raw .app directory after download.
APP_ZIP="$BUNDLE_DIR/macos/$(basename "$DMG_PATH" .dmg).app.zip"
ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$APP_ZIP"
echo "App zip: $APP_ZIP"

echo "signed=$SIGNED notarized=$NOTARIZE"
