import AVFoundation
import Foundation

/// Target output format: 16kHz, mono, 16-bit signed integer PCM
let kTargetSampleRate: Double = 16000
let kTargetChannels: AVAudioChannelCount = 1

let targetFormat = AVAudioFormat(
    commonFormat: .pcmFormatInt16,
    sampleRate: kTargetSampleRate,
    channels: kTargetChannels,
    interleaved: true
)!

/// Write PCM Int16 samples from an AVAudioPCMBuffer to stdout
func writePCMToStdout(_ buffer: AVAudioPCMBuffer) {
    guard let int16Data = buffer.int16ChannelData else { return }
    let frameCount = Int(buffer.frameLength)
    guard frameCount > 0 else { return }

    let ptr = int16Data[0]
    let byteCount = frameCount * MemoryLayout<Int16>.size
    let data = Data(bytes: ptr, count: byteCount)

    FileHandle.standardOutput.write(data)
}

/// Create an AVAudioConverter from source format to target 16kHz/mono/Int16
func makeConverter(from sourceFormat: AVAudioFormat) -> AVAudioConverter? {
    return AVAudioConverter(from: sourceFormat, to: targetFormat)
}

/// Convert a buffer from source format to target format using the given converter
func convertBuffer(
    _ inputBuffer: AVAudioPCMBuffer,
    converter: AVAudioConverter
) -> AVAudioPCMBuffer? {
    let ratio = kTargetSampleRate / converter.inputFormat.sampleRate
    let outputFrameCount = AVAudioFrameCount(
        Double(inputBuffer.frameLength) * ratio
    )
    guard outputFrameCount > 0 else { return nil }

    guard
        let outputBuffer = AVAudioPCMBuffer(
            pcmFormat: targetFormat,
            frameCapacity: outputFrameCount
        )
    else { return nil }

    var error: NSError?
    var consumed = false
    converter.convert(to: outputBuffer, error: &error) { _, outStatus in
        if consumed {
            outStatus.pointee = .noDataNow
            return nil
        }
        consumed = true
        outStatus.pointee = .haveData
        return inputBuffer
    }

    if let error = error {
        log("Conversion error: \(error)")
        return nil
    }

    return outputBuffer
}

/// Log to stderr
func log(_ message: String) {
    FileHandle.standardError.write(
        Data("[AudioCapture] \(message)\n".utf8))
}
