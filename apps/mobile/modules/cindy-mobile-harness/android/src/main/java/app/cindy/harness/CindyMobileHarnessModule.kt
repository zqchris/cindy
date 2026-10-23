package app.cindy.harness

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import java.io.File
import java.security.MessageDigest

class CindyMobileHarnessModule : Module() {
  companion object { init { System.loadLibrary("cindy_mobile_harness") } }
  private val oauth = OAuthCallback()
  private external fun nativeCall(root: String, input: String): String
  override fun definition() = ModuleDefinition {
    Name("CindyMobileHarness")
    OnDestroy { oauth.dispose() }
    AsyncFunction("startOAuthCallback") { state: String -> oauth.start(state) }
    AsyncFunction("waitOAuthCallback") { promise: Promise -> oauth.wait(promise) }
    AsyncFunction("cancelOAuthCallback") { oauth.cancel() }
    AsyncFunction("verifyRS256") { input: String, signature: String, modulus: String, exponent: String -> verifyRS256(input, signature, modulus, exponent) }
    AsyncFunction("call") { owner: String, input: String ->
      require(owner.isNotEmpty() && owner.toByteArray().size < 512) { "INVALID_OWNER" }
      val context = requireNotNull(appContext.reactContext) { "CONTEXT_UNAVAILABLE" }
      val digest = MessageDigest.getInstance("SHA-256").digest(owner.toByteArray()).joinToString("") { "%02x".format(it) }
      val root = File(context.noBackupFilesDir, "CindyMobileHarness/$digest")
      check(root.isDirectory || root.mkdirs()) { "STORAGE_UNAVAILABLE" }
      nativeCall(root.absolutePath, input)
    }
    AsyncFunction("localModelAvailability") { "unsupported_os" }
    AsyncFunction("generateLocal") { _: String, _: String -> throw IllegalStateException("LOCAL_MODEL_UNAVAILABLE") }
    AsyncFunction("cancelLocal") { _: String -> Unit }
  }
}
