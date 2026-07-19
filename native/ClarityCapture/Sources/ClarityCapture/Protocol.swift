import Foundation

struct CaptureCommand: Codable {
    let protocolVersion: Int
    let requestId: String
    let command: String
    let microphone: Bool?
    let systemAudio: Bool?
}

struct CaptureReply: Codable {
    let protocolVersion: Int
    let requestId: String?
    let type: String
    let ok: Bool
    let error: String?
    let capabilities: [String]?
    let epoch: String?
    let sequence: Int?
    let source: String?
    let sampleRate: Double?
    let channels: Int?
    let pcm: String?

    static func acknowledgement(_ command: CaptureCommand, type: String, capabilities: [String]? = nil) -> CaptureReply {
        CaptureReply(protocolVersion: 1, requestId: command.requestId, type: type, ok: true, error: nil, capabilities: capabilities, epoch: nil, sequence: nil, source: nil, sampleRate: nil, channels: nil, pcm: nil)
    }

    static func failure(_ command: CaptureCommand, _ message: String) -> CaptureReply {
        CaptureReply(protocolVersion: 1, requestId: command.requestId, type: "error", ok: false, error: message, capabilities: nil, epoch: nil, sequence: nil, source: nil, sampleRate: nil, channels: nil, pcm: nil)
    }
}

final class JSONLineEmitter: @unchecked Sendable {
    private let lock = NSLock()
    private let encoder = JSONEncoder()

    func send(_ reply: CaptureReply) {
        lock.lock()
        defer { lock.unlock() }
        guard let encoded = try? encoder.encode(reply) else { return }
        FileHandle.standardOutput.write(encoded)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
}
