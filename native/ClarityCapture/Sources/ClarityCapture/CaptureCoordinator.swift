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
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
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
        let buffers = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        guard let first = buffers.first, let raw = first.mData else { return }
        emit(data: Data(bytes: raw, count: Int(first.mDataByteSize)), source: source, sampleRate: buffer.format.sampleRate, channels: Int(buffer.format.channelCount))
    }

    private func emit(data: Data, source: String, sampleRate: Double, channels: Int) {
        let reply = CaptureReply(protocolVersion: 1, requestId: nil, type: "audio", ok: true, error: nil, capabilities: nil, epoch: epoch, sequence: sequence, source: source, sampleRate: sampleRate, channels: channels, pcm: data.base64EncodedString())
        sequence += 1
        emitter.send(reply)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .audio,
              sampleBuffer.isValid,
              let blockBuffer = sampleBuffer.dataBuffer else { return }
        var length = 0
        var pointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(blockBuffer, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == kCMBlockBufferNoErr,
              let pointer else { return }
        emit(data: Data(bytes: pointer, count: length), source: "system", sampleRate: 16_000, channels: 1)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fputs("system audio stopped: \(error.localizedDescription)\n", stderr)
    }
}
