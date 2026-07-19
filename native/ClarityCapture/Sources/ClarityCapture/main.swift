import Foundation

let emitter = JSONLineEmitter()
let coordinator = CaptureCoordinator(emitter: emitter)
let decoder = JSONDecoder()

while let line = readLine() {
    guard let data = line.data(using: .utf8), let command = try? decoder.decode(CaptureCommand.self, from: data) else {
        fputs("ignored malformed control message\n", stderr)
        continue
    }
    guard command.protocolVersion == 1 else {
        emitter.send(.failure(command, "Unsupported protocol version"))
        continue
    }
    switch command.command {
    case "hello":
        emitter.send(.acknowledgement(command, type: "hello", capabilities: ["microphone", "system-audio", "pcm-base64-v1"]))
    case "start":
        Task {
            do {
                try await coordinator.start(microphone: command.microphone ?? true, systemAudio: command.systemAudio ?? true)
                emitter.send(.acknowledgement(command, type: "started"))
            } catch {
                emitter.send(.failure(command, error.localizedDescription))
            }
        }
    case "stop":
        Task {
            await coordinator.stop()
            emitter.send(.acknowledgement(command, type: "stopped"))
        }
    default:
        emitter.send(.failure(command, "Unsupported command"))
    }
}

Task { await coordinator.stop() }
