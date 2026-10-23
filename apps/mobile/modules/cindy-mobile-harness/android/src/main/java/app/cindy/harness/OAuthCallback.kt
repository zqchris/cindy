package app.cindy.harness

import expo.modules.kotlin.Promise
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.net.URLDecoder
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import android.util.Base64
import java.math.BigInteger
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.RSAPublicKeySpec

internal class OAuthCallback {
  private val executor = Executors.newSingleThreadExecutor()
  private var socket: ServerSocket? = null
  private var client: Socket? = null
  private var result: CompletableFuture<String>? = null
  @Synchronized fun start(state: String): String {
    check(socket == null && state.length in 32..256) { "OAUTH_BUSY" }
    val server = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
    server.soTimeout = 300_000
    val origin = "http://127.0.0.1:${server.localPort}"
    val future = CompletableFuture<String>()
    socket = server; result = future
    executor.execute {
      val deadline = System.nanoTime() + TimeUnit.MINUTES.toNanos(5)
      try {
        while (!future.isDone && System.nanoTime() < deadline) {
          val connection = server.accept(); synchronized(this) { client = connection }
          connection.use {
            connection.soTimeout = 10_000
            val input = connection.getInputStream(); val bytes = ArrayList<Byte>()
            while (bytes.size < 16_384) {
              val b = input.read(); if (b < 0) break; bytes.add(b.toByte())
              if (bytes.takeLast(4) == listOf<Byte>(13, 10, 13, 10)) break
            }
            val lines = bytes.toByteArray().toString(Charsets.UTF_8).split("\r\n")
            val first = lines.firstOrNull()?.split(' ') ?: emptyList()
            val target = if (first.size == 3) runCatching { URI(origin + first[1]) }.getOrNull() else null
            val query = target?.rawQuery?.split('&')?.map { part ->
              val pair = part.split('=', limit = 2)
              URLDecoder.decode(pair[0], "UTF-8") to URLDecoder.decode(pair.getOrElse(1) { "" }, "UTF-8")
            } ?: emptyList()
            val host = lines.firstOrNull { it.startsWith("Host:", ignoreCase = true) }?.substringAfter(':')?.trim()
            val valid = first.firstOrNull() == "GET" && target?.path == "/auth/callback" && host == "127.0.0.1:${server.localPort}"
              && query.count { it.first == "state" } == 1 && query.firstOrNull { it.first == "state" }?.second == state
            val body = if (valid) "You can return to Cindy." else "Invalid callback."
            connection.getOutputStream().write(("HTTP/1.1 ${if (valid) "200 OK" else "400 Bad Request"}\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n$body").toByteArray())
            if (valid) future.complete(target.toString())
          }
        }
      } catch (_: Exception) { future.completeExceptionally(IllegalStateException("OAUTH_CANCELLED")) }
      finally { future.completeExceptionally(IllegalStateException("OAUTH_CANCELLED")); synchronized(this) { if (socket === server) { socket = null; client = null } }; runCatching { server.close() } }
    }
    return "$origin/auth/callback"
  }
  @Synchronized fun wait(promise: Promise) {
    val future = result
    if (future == null) { promise.reject("OAUTH_CANCELLED", "OAUTH_CANCELLED", null); return }
    future.whenComplete { value, error -> if (error == null) promise.resolve(value) else promise.reject("OAUTH_CANCELLED", "OAUTH_CANCELLED", null) }
  }
  @Synchronized fun cancel() {
    result?.completeExceptionally(IllegalStateException("OAUTH_CANCELLED")); result = null
    runCatching { client?.close() }; client = null
    runCatching { socket?.close() }; socket = null
  }
  fun dispose() { cancel(); executor.shutdownNow() }
}
internal fun verifyRS256(input: String, signature: String, modulus: String, exponent: String): Boolean = runCatching {
  fun decode(s: String) = Base64.decode(s, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
  val n = decode(modulus); val e = decode(exponent)
  require(n.size in 256..1024 && e.size <= 8)
  val key = KeyFactory.getInstance("RSA").generatePublic(RSAPublicKeySpec(BigInteger(1, n), BigInteger(1, e)))
  Signature.getInstance("SHA256withRSA").run { initVerify(key); update(input.toByteArray()); verify(decode(signature)) }
}.getOrDefault(false)
