import Foundation
import RoomPlan

/// The SDK's delegate requirements are nonisolated. Only this lock-protected gate
/// is accessed on callback threads; observable/UI state moves to the main actor.
final class ScanGate: @unchecked Sendable {
    private let lock = NSLock()
    private var active = true
    private var finalizing = false

    func allowFinalization() { lock.lock(); defer { lock.unlock() }; finalizing = active }
    func invalidate() { lock.lock(); defer { lock.unlock() }; active = false; finalizing = false }
    var shouldPresent: Bool { lock.lock(); defer { lock.unlock() }; return active && finalizing }
}

final class ScanCoordinator: NSObject, RoomCaptureViewDelegate, RoomCaptureSessionDelegate, @unchecked Sendable {
    let scanID: UUID
    let gate: ScanGate
    private let processed: @MainActor @Sendable (CapturedRoom, UUID) -> Void
    private let failure: @MainActor @Sendable (String, UUID) -> Void
    private let stopped: @MainActor @Sendable (UUID) -> Void

    init(scanID: UUID, gate: ScanGate,
         processed: @escaping @MainActor @Sendable (CapturedRoom, UUID) -> Void,
         failure: @escaping @MainActor @Sendable (String, UUID) -> Void,
         stopped: @escaping @MainActor @Sendable (UUID) -> Void) {
        self.scanID = scanID; self.gate = gate
        self.processed = processed; self.failure = failure; self.stopped = stopped
        super.init()
    }

    required init?(coder: NSCoder) { return nil }
    func encode(with coder: NSCoder) { /* Delegates are never archived. */ }

    func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool {
        if let error {
            report(error.localizedDescription)
            return false
        }
        return gate.shouldPresent
    }

    func captureView(didPresent processedResult: CapturedRoom, error: Error?) {
        if let error { report(error.localizedDescription); return }
        guard gate.shouldPresent else { return }
        let callback = processed, id = scanID
        Task { @MainActor in callback(processedResult, id) }
    }

    func captureSession(_ session: RoomCaptureSession, didEndWith data: CapturedRoomData, error: Error?) {
        if let error { report(error.localizedDescription); return }
        let callback = stopped, id = scanID
        Task { @MainActor in callback(id) }
    }

    private func report(_ message: String) {
        let callback = failure, id = scanID
        Task { @MainActor in callback(message, id) }
    }
}
