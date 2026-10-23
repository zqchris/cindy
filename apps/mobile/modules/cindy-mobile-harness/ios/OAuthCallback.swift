import Foundation
import Network
import Security

/// One short-lived loopback listener per sign-in. It has no file or proxy routes.
final class OAuthCallback {
  private let queue = DispatchQueue(label: "app.cindy.oauth-callback")
  private var listener: NWListener?
  private var expectedState = ""
  private var result: String?
  private var waiter: CheckedContinuation<String, Error>?
  private var clients: [UUID: NWConnection] = [:]

  func start(state: String) async throws -> String {
    try await withCheckedThrowingContinuation { continuation in
      queue.async {
        guard self.listener == nil, state.utf8.count >= 32, state.utf8.count <= 256 else {
          continuation.resume(throwing: HarnessException("OAUTH_BUSY")); return
        }
        do {
          let params = NWParameters.tcp
          params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
          let listener = try NWListener(using: params)
          self.listener = listener; self.expectedState = state; self.result = nil
          var pending: CheckedContinuation<String, Error>? = continuation
          listener.stateUpdateHandler = { status in
            if case .ready = status, let port = listener.port {
              pending?.resume(returning: "http://127.0.0.1:\(port.rawValue)/auth/callback"); pending = nil
            } else if case .failed = status {
              pending?.resume(throwing: HarnessException("OAUTH_LISTENER_FAILED")); pending = nil; self.finish(nil)
            } else if case .cancelled = status {
              pending?.resume(throwing: HarnessException("OAUTH_CANCELLED")); pending = nil
            }
          }
          listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
          listener.start(queue: self.queue)
          self.queue.asyncAfter(deadline: .now() + 300) { [weak self, weak listener] in
            if let self, self.listener === listener { self.finish(nil) }
          }
        } catch { continuation.resume(throwing: HarnessException("OAUTH_LISTENER_FAILED")) }
      }
    }
  }
  func wait() async throws -> String {
    try await withCheckedThrowingContinuation { continuation in
      queue.async {
        if let result = self.result { self.result = nil; continuation.resume(returning: result) }
        else if self.listener != nil && self.waiter == nil { self.waiter = continuation }
        else { continuation.resume(throwing: HarnessException("OAUTH_CANCELLED")) }
      }
    }
  }
  func cancel() { queue.async { self.result = nil; self.finish(nil) } }
  private func finish(_ url: String?) {
    listener?.cancel(); listener = nil
    if let waiter { self.waiter = nil; if let url { waiter.resume(returning: url) } else { waiter.resume(throwing: HarnessException("OAUTH_CANCELLED")) } }
    else { result = url }
    clients.values.forEach { $0.cancel() }; clients.removeAll()
    expectedState = ""
  }
  private func accept(_ connection: NWConnection) {
    guard clients.count < 8 else { connection.cancel(); return }
    let id = UUID(); clients[id] = connection; connection.start(queue: queue)
    queue.asyncAfter(deadline: .now() + 10) { [weak self] in self?.clients.removeValue(forKey: id)?.cancel() }
    receive(id, Data())
  }
  private func receive(_ id: UUID, _ previous: Data) {
    clients[id]?.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, ended, error in
      guard let self, let connection = self.clients[id] else { return }
      var bytes = previous; if let data { bytes.append(data) }
      guard error == nil, bytes.count <= 16384 else { self.clients.removeValue(forKey: id)?.cancel(); return }
      guard bytes.range(of: Data("\r\n\r\n".utf8)) != nil else {
        if ended { self.clients.removeValue(forKey: id)?.cancel() } else { self.receive(id, bytes) }; return
      }
      let lines = String(decoding: bytes, as: UTF8.self).components(separatedBy: "\r\n")
      let first = (lines.first ?? "").components(separatedBy: " ")
      let origin = "http://127.0.0.1:\(self.listener?.port?.rawValue ?? 0)"
      let url = first.count == 3 ? URLComponents(string: origin + first[1]) : nil
      let items = url?.queryItems ?? []
      let host = lines.dropFirst().first { $0.lowercased().hasPrefix("host:") }?.dropFirst(5).trimmingCharacters(in: .whitespaces)
      let valid = first.first == "GET" && url?.path == "/auth/callback"
        && host == String(origin.dropFirst(7))
        && items.filter { $0.name == "state" }.count == 1
        && items.first { $0.name == "state" }?.value == self.expectedState
      let body = valid ? "You can return to Cindy." : "Invalid callback."
      let response = "HTTP/1.1 \(valid ? "200 OK" : "400 Bad Request")\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
      let activeListener = self.listener
      connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in
        self.clients.removeValue(forKey: id)?.cancel()
        if valid && self.listener === activeListener { self.finish(url?.string) }
      })
    }
  }
}

/// Only the signature primitive is native; issuer/audience/nonce policy stays in the shared adapter.
func verifyRSA(_ input: String, signature: String, modulus: String, exponent: String) -> Bool {
  func decode(_ value: String) -> Data? {
    let base = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    return Data(base64Encoded: base + String(repeating: "=", count: (4 - base.count % 4) % 4))
  }
  func length(_ n: Int) -> Data {
    if n < 128 { return Data([UInt8(n)]) }
    var value = n; var bytes = [UInt8]()
    while value > 0 { bytes.insert(UInt8(value & 255), at: 0); value >>= 8 }
    return Data([0x80 | UInt8(bytes.count)] + bytes)
  }
  func integer(_ data: Data) -> Data {
    let value = data.first.map { $0 >= 128 } == true ? Data([0]) + data : data
    return Data([2]) + length(value.count) + value
  }
  guard let n = decode(modulus), n.count >= 256, n.count <= 1024,
    let e = decode(exponent), e.count <= 8, let sig = decode(signature) else { return false }
  let parts = integer(n) + integer(e)
  let der = Data([0x30]) + length(parts.count) + parts
  let attrs: [CFString: Any] = [kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeyClass: kSecAttrKeyClassPublic]
  guard let key = SecKeyCreateWithData(der as CFData, attrs as CFDictionary, nil) else { return false }
  return SecKeyVerifySignature(key, .rsaSignatureMessagePKCS1v15SHA256, Data(input.utf8) as CFData, sig as CFData, nil)
}
