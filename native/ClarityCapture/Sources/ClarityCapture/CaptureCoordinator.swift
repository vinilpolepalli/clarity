import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

final class CaptureCoordinator: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let emitter: JSONLineEmitter
    private let audioEngine = AVAudioEngine()
    private let sampleQueue = DispatchQueue(label: "app.clarity.capture.samples", qos: .userInitiated)
    private var stream: SCStream?
    private var epoch = UUID().uuidString
    private var sequence = 0
    private var microphoneRunning = false

    init(emitter: JSONLineEmitter) { self.emitter = emitter }

    func start(microphone: Bool, systemAudio: Bool) async throws {
        epoch = UUID().uuidString
        sequence = 0
        if microphone { try startMicrophone() }
        if systemAudio { try await startSystemAudio() }
    }

    func stop() async {
        if microphoneRunning {
            audioEngine.inputNode.removeTap(onBus: 0)
            audioEngine.stop()
            microphoneRunning = false
        }
        if let stream {
            try? await stream.stopCapture()
            self.stream = nil
        }
    }

    private func startMicrophone() throws {
        guard !microphoneRunning else { return }
        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw NSError(domain: "ClarityCapture", code: 10, userInfo: [NSLocalizedDescriptionKey: "No microphone format is available"]) }
        guard let normalizedFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false) else {
            throw NSError(domain: "ClarityCapture", code: 12, userInfo: [NSLocalizedDescriptionKey: "Unable to create the live-notes microphone format"])
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: normalizedFormat) { [weak self] buffer, _ in
            self?.emit(buffer: buffer, source: "microphone")
        }
        audioEngine.prepare()
        try audioEngine.start()
        microphoneRunning = true
    }

    private func startSystemAudio() async throws {
        guard stream == nil else { return }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else { throw NSError(domain: "ClarityCapture", code: 11, userInfo: [NSLocalizedDescriptionKey: "No display is available for system audio capture"]) }
        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.width = 2
        configuration.height = 2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        configuration.showsCursor = false
        configuration.capturesAudio = true
        configuration.excludesCurrentProcessAudio = true
        configuration.sampleRate = 16_000
        configuration.channelCount = 1
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleQueue)
        try await stream.startCapture()
        self.stream = stream
    }

    private func emit(buffer: AVAudioPCMBuffer, source: String) {
        guard let samples = buffer.floatChannelData else { return }
        let count = Int(buffer.frameLength)
        var output = Data(capacity: count * 2)
        for index in 0..<count {
            let clipped = max(-1, min(1, samples[0][index]))
            var value = UInt16(bitPattern: Int16(clipped * Float(Int16.max))).littleEndian
            withUnsafeBytes(of: &value) { output.append(contentsOf: $0) }
        }
        emitPCM16(data: output, source: source, sampleRate: 16_000)
    }

    private func emitPCM16(data: Data, source: String, sampleRate: Double = 16_000) {
        let reply = CaptureReply(protocolVersion: 1, requestId: nil, type: "audio", ok: true, error: nil, capabilities: nil, epoch: epoch, sequence: sequence, source: source, sampleRate: sampleRate, channels: 1, pcm: data.base64EncodedString())
        sequence += 1
        emitter.send(reply)
    }

    private func pcm16(fromFloat32 data: Data) -> Data {
        var output = Data(capacity: (data.count / 4) * 2)
        data.withUnsafeBytes { raw in
            let count = raw.count / MemoryLayout<Float32>.size
            for index in 0..<count {
                let input = raw.loadUnaligned(fromByteOffset: index * MemoryLayout<Float32>.size, as: Float32.self)
                let clipped = max(-1, min(1, input))
                var value = UInt16(bitPattern: Int16(clipped * Float(Int16.max))).littleEndian
                withUnsafeBytes(of: &value) { output.append(contentsOf: $0) }
            }
        }
        return output
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .audio,
              sampleBuffer.isValid,
              let blockBuffer = sampleBuffer.dataBuffer else { return }
        var length = 0
        var pointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(blockBuffer, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == kCMBlockBufferNoErr,
              let pointer else { return }
        let raw = Data(bytes: pointer, count: length)
        guard let description = CMSampleBufferGetFormatDescription(sampleBuffer),
              let streamDescription = CMAudioFormatDescriptionGetStreamBasicDescription(description) else { return }
        if streamDescription.pointee.mBitsPerChannel == 16 {
            emitPCM16(data: raw, source: "system")
        } else if streamDescription.pointee.mBitsPerChannel == 32 {
            emitPCM16(data: pcm16(fromFloat32: raw), source: "system")
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fputs("system audio stopped: \(error.localizedDescription)\n", stderr)
    }
}
