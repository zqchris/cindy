#!/usr/bin/env bash
set -euo pipefail
MODULE_DIR="$(cd "$(dirname "$0")" && pwd)"
CRATE_DIR="$(cd "$MODULE_DIR/../../../../packages/mobile-harness" && pwd)"
CARGO_BIN="${CARGO:-$HOME/.cargo/bin/cargo}"
case "${PLATFORM_NAME:-iphonesimulator}" in
  iphonesimulator) TARGET=aarch64-apple-ios-sim ;;
  iphoneos) TARGET=aarch64-apple-ios ;;
  *) echo 'Unsupported Apple build target' >&2; exit 1 ;;
esac
"$CARGO_BIN" build --manifest-path "$CRATE_DIR/Cargo.toml" --locked --release --target "$TARGET" -j 4
mkdir -p "$MODULE_DIR/ios/lib"
cp "$CRATE_DIR/target/$TARGET/release/libcindy_mobile_harness.a" "$MODULE_DIR/ios/lib/libcindy_mobile_harness.a"
