import Foundation

// MARK: - Argument parsing

let args = CommandLine.arguments
let mode: String

if args.contains("--system") {
    mode = "system"
} else if args.contains("--mic") {
    mode = "mic"
} else {
    FileHandle.standardError.write(
        Data("Usage: AudioCapture --system | --mic\n".utf8))
    exit(1)
}

// MARK: - Signal handling

var captureInstance: Any?

func handleSignal(_ signal: Int32) {
    log("Received signal \(signal), stopping...")
    if let sys = captureInstance as? SystemAudioCapture {
        sys.stop()
    } else if let mic = captureInstance as? MicCapture {
        mic.stop()
    }
}

signal(SIGINT, handleSignal)
signal(SIGTERM, handleSignal)

// MARK: - Run

log("Mode: \(mode)")

if mode == "system" {
    if #available(macOS 14.0, *) {
        let capture = SystemAudioCapture()
        captureInstance = capture
        Task {
            do {
                try await capture.start()
            } catch {
                log("Error: \(error)")
                exit(1)
            }
            exit(0)
        }
        // Keep main thread alive
        dispatchMain()
    } else {
        log("Error: macOS 14.0+ required for system audio capture")
        exit(1)
    }
} else {
    let capture = MicCapture()
    captureInstance = capture
    do {
        try capture.start()
    } catch {
        log("Error: \(error)")
        exit(1)
    }
}
