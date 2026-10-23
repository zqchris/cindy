# Cindy Mobile Harness

## Work-in-progress checkpoint — 2026-10-23

This branch preserves the implementation based on `d6f58ffe90` for continued
development. It is not release-ready or rebased onto the current upstream main.
The harness is integrated into Cindy Mobile's existing new-task device selector
as **本机**, with the existing task, file and plugin screens. The earlier standalone
four-tab prototype was removed.

Implemented: Rust session/tool core, native iOS/Android bridges, guest local access,
account-scoped storage, configurable model providers, independent ChatGPT OAuth,
Cindy AI credentials/catalog integration, and the portable extension subset below.
Implemented adapters do not imply successful live-model acceptance.

Verified in the integrated iOS simulator on 2026-10-18: skip login, retain local
access after restart, configure a deterministic model fixture, create a task,
approve a write, complete the response and list the saved `index.html`.
The integrated file-preview and recovery acceptance matrix remains incomplete.

Cindy AI live acceptance is blocked by an enterprise sign-in callback returning
`SSO_ERROR`. The client error message was clarified; the login failure was not
fixed. Its underlying cause requires authentication-server diagnostics. Independent
ChatGPT OAuth, Apple inference on a physical iPhone, Android Gradle/UI, desktop
compatibility of the shared agent-kind changes, and release/offline startup remain
unverified. No desktop credentials were imported.

Checkpoint checks: 50 targeted mobile tests and 10 Rust integration tests; mobile
TypeScript checking. See the commit/checkpoint notes for execution results. Native
build outputs, simulator data, credentials and local screenshots are not included.

A small, host-driven Rust agent kernel for Cindy Mobile. It runs inside the app
sandbox; cloud models are called directly by the phone. It does not require a
connected desktop, Node.js, Pi, Bash, a Linux emulator or a WASM runtime.

## Boundaries

| Layer | Responsibility |
| --- | --- |
| Rust (`src/`) | Durable sessions, context compaction, provider message codecs, tool approvals, core workspace tools, interruption recovery |
| Expo native module (`apps/mobile/modules/cindy-mobile-harness`) | App-private storage root, C ABI/JNI, Apple Foundation Models |
| Mobile host (`apps/mobile/src/local-harness`) | Credential storage, HTTP, cancellation, UI, extension sandbox |
| `.cindy` extensions | Optional tools through Cindy's existing manifest and message protocol |

The kernel returns a persisted **effect** rather than performing network calls.
The host fulfills that effect and returns its result with the matching effect ID.
This keeps OS permissions, transport, credentials and UI outside the session core.

This implementation is independent of Pi. It does not modify or bundle Pi's
runtime and is not compatible with arbitrary Pi extensions.

## Sessions and files

Each task has a UUID, a complete JSON history and its own workspace directory.
The host chooses the root; model and plugin arguments cannot choose another root.
Writes use a temporary file, fsync and rename. `cap-std` confines workspace access,
including parent paths and symlink traversal. Text files are limited to 2 MiB.
The five built-in tools are `read`, `write`, `edit`, `list`, and `search`.

Every write/edit and every extension invocation requires approval. Execution is
recorded before side effects. Repeated execution claims and stale callbacks are
rejected. Recovery never automatically replays an uncertain operation. Backgrounding
stops active work; reopening offers continuation. Files and history survive process
termination, but uninstalling the app removes app-owned data.

Task data stays on the device, partitioned by Cindy account; guest data has its own
scope. It does not sync through Cindy. OS backup policies still apply. Provider keys live
in SecureStore, not session files, logs or plugins. iOS keys use
`WHEN_UNLOCKED_THIS_DEVICE_ONLY`; the workspace uses iOS data protection.

Context is budgeted conservatively in serialized UTF-8 bytes, including instructions
and schemas. Older completed turns are summarized as quoted data. Full history stays
on disk. An indivisible oversized turn is retained and reports `CONTEXT_FULL`; it is
not silently discarded. The budget is not a provider tokenizer or token guarantee.

## Models

- OpenAI-compatible Chat Completions, Responses, Anthropic Messages and Google GenerateContent
  have explicit codecs and user-configurable HTTPS endpoints. Loopback HTTP is
  allowed for local engines/testing. Responses event streams are decoded into a
  completed response; incremental token presentation is not implemented yet.
- Cindy AI uses the existing authenticated credentials and V5 model catalog APIs.
  Gateway credentials remain in memory and are not copied from another device.
- Google signed parts are preserved across tool continuations.
- On eligible iOS 26+ devices with Apple Intelligence ready, the Swift adapter calls
  `FoundationModels.LanguageModelSession` and uses structured generation for tools.
  It reports availability before use. The simulator cannot prove actual inference.
- `registerModelAdapter(providerId, adapter)` supports an additional **bundled native**
  model engine without changing session persistence. It must return the configured
  protocol's result shape. There is no GGUF download/import UI or bundled llama.cpp
  engine in this implementation. Native modules require a new app binary.

HTTP redirects and ambient cookies are disabled. HTTP bodies, prompts and keys are
not logged. Responses are bounded. Network calls and native generation are cancelled
when the user stops or the app enters the background.

## Extensions

Install a `.cindy` ZIP from Files. The shared `@cindy/plugin-protocol` validator is
used; desktop installations and approval records are untouched. The executable entry
must be bundled JavaScript. A small working example is in `examples/mobile-note/`.

The sandbox runs in an isolated WebView with no direct network, native filesystem,
shared cookies, navigation or eval. It uses the existing `cindy.onHostMessage` /
`cindy.send` tool-call protocol. Only an active, approved invocation can request:

- `cindy.fs({ root: 'workdir', callId, path, content })`: write in the current task.
- `cindy.fetch({ callId, url, method, headers, body, as: 'text' })`: bounded HTTPS
  request through the host. Allowed headers are Accept and Content-Type. Credentials
  and redirects are not forwarded.

The installed content revision is bound to each task's tool snapshot. Disabled,
removed or changed tools cannot execute an old approval. Plugin enable/disable
updates commit a new generation before reclaiming older snapshots.

This is a portable JavaScript tool subset, **not full desktop plugin parity**.
Node/process plugins and plugins declaring OAuth/secret adapters are identified as
unsupported at installation. Panels, schedules, skill loading, separate imported JS
files and credential adapters are not implemented here. Ordinary authorized HTTPS
requests follow the existing plugin protocol; an extension can contact a service
only during an approved call. Plugin descriptions are not a security authority.

## Build and test

Prerequisites: workspace dependencies, Rust (edition 2024), Xcode and the existing
Cindy Mobile development environment. Rust is an additional native build dependency.

```sh
pnpm install
rustup target add aarch64-apple-ios-sim aarch64-apple-ios
# Prepare the vendored archive before the first CocoaPods/prebuild evaluation.
bash apps/mobile/modules/cindy-mobile-harness/build-ios.sh
pnpm mobile:sim:rebuild -- --build-only --udid <task-simulator>
pnpm mobile:sim:start -- --port <task-port>
```

The Xcode build phase rebuilds the archive for simulator/device as appropriate.
The current script supports Apple Silicon simulators and ARM64 devices. The archive
is generated and ignored by Git. Do not share one checkout between simultaneous
device and simulator builds. Rust source, Cargo manifest and lockfile participate in
the mobile native fingerprint. These changes require a **cold update**; an OTA JS
update cannot install the kernel.

Android uses an Expo JNI module and NDK cross-compilation. Install
`aarch64-linux-android` and `x86_64-linux-android` Rust targets. The Gradle pre-build
step invokes `build-android.mjs`; `ANDROID_NDK_HOME` can be set for standalone builds.
Android currently has the cloud-model path, not the Apple on-device model adapter.

```sh
cargo test --manifest-path packages/mobile-harness/Cargo.toml --locked
cargo clippy --manifest-path packages/mobile-harness/Cargo.toml --locked --all-targets -- -D warnings
pnpm --filter mobile run typecheck
```

`tests/session.rs` is tier 1: actual public commands, disk persistence and workspace
side effects, with fake model responses. Ten tests cover approved/rejected writes,
late results, crash recovery, path escapes, protocol tools, Google signatures and
context compaction. Execution measured 0.56 seconds on the development Mac.

## Reproducible simulator fixture

```sh
python3 packages/mobile-harness/examples/fixture-server.py
```

Add an OpenAI-compatible provider with endpoint `http://127.0.0.1:8987/v1`, model
`fixture`, empty API key. This is a **deterministic test server**, not an AI model.
A normal prompt proposes `index.html`; `plugin` calls the sample extension; `slow`
waits 12 seconds to exercise cancellation. Download `/mobile-note.cindy` from the
same server or zip the example directory with `ghost.json` at the archive root.

Historical standalone-prototype acceptance on 2026-10-18: native build, unauthenticated local entry,
provider creation, approved file write and HTML preview, `.cindy` installation and
actual file output, extension toggles, cancellation, interrupted-request recovery,
approval persistence across restart, and both appearance modes. Rust tests and mobile
typecheck passed. Android ARM64/x86_64 native libraries compile; Android Gradle/UI,
live cloud inference and Apple inference on a physical device remain unverified.
These prototype results do not establish acceptance of the replacement integrated
UI; use the checkpoint status above for the current implementation.
