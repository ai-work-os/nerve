import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

@available(macOS 14.0, *)
class SystemAudioCapture: NSObject, SCStreamDelegate, SCStreamOutput {
    private var stream: SCStream?
    private var continuation: CheckedContinuation<Void, Never>?
    private var running = false
    private var loggedFormat = false

    func start() async throws {
        // Check screen capture permission
        let hasAccess = CGPreflightScreenCaptureAccess()
        if !hasAccess {
            log("Requesting Screen Recording permission...")
            let granted = CGRequestScreenCaptureAccess()
            if !granted {
                throw CaptureError.noPermission
            }
        }

        // Get shareable content
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: false)

        guard let display = content.displays.first else {
            throw CaptureError.noDisplay
        }

        // Create filter — capture display audio only
        let filter = SCContentFilter(display: display, excludingWindows: [])

        // Configure stream — minimal video, audio enabled
        let config = SCStreamConfiguration()
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1) // 1 fps
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = Int(kTargetSampleRate)
        config.channelCount = Int(kTargetChannels)

        // Create and start stream
        let stream = SCStream(
            filter: filter, configuration: config, delegate: self)

        try stream.addStreamOutput(
            self, type: .audio, sampleHandlerQueue: .global(qos: .userInteractive))

        try await stream.startCapture()
        self.stream = stream
        running = true
        log("System audio capture started")

        // Wait until stopped
        await withCheckedContinuation { cont in
            self.continuation = cont
        }
    }

    func stop() {
        guard running else { return }
        running = false
        Task {
            try? await stream?.stopCapture()
            stream = nil
            log("System audio capture stopped")
            continuation?.resume()
            continuation = nil
        }
    }

    // MARK: - SCStreamOutput

    func stream(
        _ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .audio, running else { return }
        guard sampleBuffer.isValid, sampleBuffer.numSamples > 0 else { return }

        // Log format once
        if !loggedFormat {
            loggedFormat = true
            if let formatDesc = sampleBuffer.formatDescription,
                let asbd = formatDesc.audioStreamBasicDescription
            {
                log(
                    "Audio format: \(asbd.mSampleRate)Hz, \(asbd.mChannelsPerFrame)ch, "
                        + "\(asbd.mBitsPerChannel)bit, flags=0x\(String(asbd.mFormatFlags, radix: 16)) → 16kHz/mono/Int16"
                )
            }
        }

        // Extract raw Float32 samples from CMSampleBuffer
        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }

        let frameCount = CMSampleBufferGetNumSamples(sampleBuffer)
        var totalLength = 0
        var dataPointer: UnsafeMutablePointer<Int8>?

        let status = CMBlockBufferGetDataPointer(
            blockBuffer, atOffset: 0, lengthAtOffsetOut: nil,
            totalLengthOut: &totalLength, dataPointerOut: &dataPointer)

        guard status == kCMBlockBufferNoErr, let ptr = dataPointer else { return }

        // SC delivers Float32 at configured 16kHz/mono — convert directly to Int16
        let floatPtr = UnsafeRawPointer(ptr).bindMemory(to: Float32.self, capacity: frameCount)
        var int16Samples = [Int16](repeating: 0, count: frameCount)
        for i in 0..<frameCount {
            let clamped = max(-1.0, min(1.0, floatPtr[i]))
            int16Samples[i] = Int16(clamped * 32767.0)
        }

        int16Samples.withUnsafeBufferPointer { buffer in
            let data = Data(bytes: buffer.baseAddress!, count: frameCount * MemoryLayout<Int16>.size)
            FileHandle.standardOutput.write(data)
        }
    }

    // MARK: - SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        log("Stream stopped with error: \(error.localizedDescription)")
        running = false
        continuation?.resume()
        continuation = nil
    }
}

enum CaptureError: Error, CustomStringConvertible {
    case noPermission
    case noDisplay

    var description: String {
        switch self {
        case .noPermission:
            return
                "Screen Recording permission denied. Go to System Settings > Privacy & Security > Screen Recording and enable this app."
        case .noDisplay:
            return "No display found"
        }
    }
}
