import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
const root = dirname(fileURLToPath(import.meta.url));
const crate = resolve(root, "../../../../packages/mobile-harness");
const ndk = process.env.ANDROID_NDK_HOME;
if (!ndk) throw new Error("ANDROID_NDK_HOME is required");
const platform =
  process.platform === "darwin"
    ? "darwin-x86_64"
    : process.platform === "win32"
      ? "windows-x86_64"
      : "linux-x86_64";
const bin = join(ndk, "toolchains/llvm/prebuilt", platform, "bin");
const cargo =
  process.env.CARGO ??
  join(
    homedir(),
    ".cargo/bin",
    process.platform === "win32" ? "cargo.exe" : "cargo",
  );
for (const [target, abi, clang] of [
  ["aarch64-linux-android", "arm64-v8a", "aarch64-linux-android24"],
  ["x86_64-linux-android", "x86_64", "x86_64-linux-android24"],
]) {
  const compiler = join(
    bin,
    `${clang}-clang${process.platform === "win32" ? ".cmd" : ""}`,
  );
  execFileSync(
    cargo,
    [
      "build",
      "--locked",
      "--release",
      "--target",
      target,
      "--manifest-path",
      join(crate, "Cargo.toml"),
      "-j",
      "4",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        [`CARGO_TARGET_${target.toUpperCase().replaceAll("-", "_")}_LINKER`]:
          compiler,
        [`CC_${target.replaceAll("-", "_")}`]: compiler,
      },
    },
  );
  const out = join(root, "android/src/main/jniLibs", abi);
  mkdirSync(out, { recursive: true });
  cpSync(
    join(crate, "target", target, "release/libcindy_mobile_harness.so"),
    join(out, "libcindy_mobile_harness.so"),
  );
}
