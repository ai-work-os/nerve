import AVFoundation
import Foundation

class MicCapture {
    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private let semaphore = DispatchSemaphore(value: 0)
    private var running = false

    func start() throws {
        let inputNode = engine.inputNode
        let inputFormat = inputNode.outputFormat(forBus: 0)

        guard inputFormat.sampleRate > 0 else {
            throw MicError.noMicrophone
        }

        log(
            "Mic format: \(inputFormat.sampleRate)Hz, \(inputFormat.channelCount)ch → 16kHz/mono/Int16"
        )

        converter = makeConverter(from: inputFormat)
        guard converter != nil else {
            throw MicError.converterFailed
        }

        inputNode.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) {
            [weak self] buffer, _ in
            guard let self = self, self.running else { return }
            if let converted = convertBuffer(buffer, converter: self.converter!) {
                writePCMToStdout(converted)
            }
        }

        engine.prepare()
        try engine.start()
        running = true
        log("Microphone capture started")

        // Wait until stopped
        semaphore.wait()
    }

    func stop() {
        guard running else { return }
        running = false
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        log("Microphone capture stopped")
        semaphore.signal()
    }
}

enum MicError: Error, CustomStringConvertible {
    case noMicrophone
    case converterFailed

    var description: String {
        switch self {
        case .noMicrophone:
            return "No microphone found or microphone access denied"
        case .converterFailed:
            return "Failed to create audio format converter"
        }
    }
}
