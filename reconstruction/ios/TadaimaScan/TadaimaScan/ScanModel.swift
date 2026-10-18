import AVFoundation
import Combine
import Foundation
import RoomPlan
import UIKit

@MainActor
final class ScanModel: ObservableObject {
    enum Phase { case idle, requestingPermission, scanning, processing, review, exporting, failed }
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var captureView: RoomCaptureView?
    @Published private(set) var scanID = UUID()
    @Published private(set) var message: String?
    @Published private(set) var cameraDenied = false
    @Published var roomLabel = "Living room"
    @Published var recordAppearancePhotos = true
    @Published private(set) var photoCount = 0
    @Published private(set) var photoMessage: String?
    @Published private(set) var photos: [CapturedScanPhoto] = []
    private(set) var room: CapturedRoom?
    private var capturedAt: Date?
    private var capturedTimeZone = TimeZone.current
    private var gate: ScanGate?
    private var coordinator: ScanCoordinator?
    private let exports = ScanExportStore()
    private let photoCapture = ScanPhotoCapture()

    var supported: Bool {
        #if targetEnvironment(simulator)
        return false
        #else
        return RoomCaptureSession.isSupported
        #endif
    }
    var isBusy: Bool { [.requestingPermission, .processing, .exporting].contains(phase) }
    var surfaceCount: Int { room.map { $0.walls.count + $0.doors.count + $0.windows.count + $0.openings.count } ?? 0 }
    var objectCount: Int { room?.objects.count ?? 0 }
    var scanName: String? {
        guard let capturedAt else { return nil }
        return ScanNames(roomLabel: roomLabel, capturedAt: capturedAt, scanID: scanID,
                         timeZone: capturedTimeZone).displayName
    }

    func start() async {
        guard supported, !isBusy, phase != .scanning else { return }
        clearCurrentScan()
        let token = scanID
        phase = .requestingPermission
        message = nil
        let allowed: Bool
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: allowed = true
        case .notDetermined: allowed = await AVCaptureDevice.requestAccess(for: .video)
        default: allowed = false
        }
        guard scanID == token, phase == .requestingPermission else { return }
        cameraDenied = !allowed
        guard allowed else {
            phase = .failed
            message = "Camera access is required for RoomPlan. Allow access in Settings, then start again."
            return
        }
        let gate = ScanGate()
        let delegate = ScanCoordinator(scanID: token, gate: gate,
            processed: { [weak self] room, id in self?.didProcess(room, id: id) },
            failure: { [weak self] message, id in self?.fail(message, id: id) },
            stopped: { [weak self] id in self?.didStop(id: id) })
        let view = RoomCaptureView(frame: .zero)
        view.delegate = delegate
        view.captureSession.delegate = delegate
        view.isModelEnabled = true
        self.gate = gate
        coordinator = delegate // Framework delegate references are weak.
        captureView = view
        phase = .scanning
        var configuration = RoomCaptureSession.Configuration()
        configuration.isCoachingEnabled = true
        view.captureSession.run(configuration: configuration)
        if recordAppearancePhotos {
            photoCapture.start(session: view.captureSession.arSession) { [weak self] count, detail in
                guard let self, self.scanID == token else { return }
                self.photoCount = count
                self.photoMessage = detail
            }
        }
    }

    func capturePhoto() {
        guard phase == .scanning else { return }
        photoCapture.captureNow()
    }

    func finish() async {
        guard phase == .scanning, let captureView else { return }
        let token = scanID
        phase = .processing
        gate?.allowFinalization()
        message = nil
        // Drain the one pending JPEG before the room is stopped/exportable.
        let captured = await photoCapture.stop()
        guard scanID == token, phase == .processing else { return }
        photos = captured
        photoCount = captured.count
        captureView.captureSession.stop(pauseARSession: true)
    }

    func rescan() {
        guard phase != .exporting else { return }
        clearCurrentScan()
        phase = .idle
        message = nil
    }

    func backgrounded() {
        guard [.requestingPermission, .scanning, .processing, .exporting].contains(phase) else { return }
        clearCurrentScan()
        phase = .idle
        message = "The scan was cancelled when the app went into the background. Start a new scan when you return."
    }

    func shareFile(includeUSDZ: Bool, includePhotos: Bool = false) async -> URL? {
        guard phase == .review, let room, let capturedAt else { return nil }
        guard !includePhotos || !photos.isEmpty else {
            message = "No photos were saved. Share the geometry JSON or scan again with photo capture enabled."
            return nil
        }
        let token = scanID
        phase = .exporting
        message = nil
        let names = ScanNames(roomLabel: roomLabel, capturedAt: capturedAt, scanID: token,
                              timeZone: capturedTimeZone)
        let packet = ScanWire.packet(room: room, scanID: token,
            capturedAt: ISO8601DateFormatter().string(from: capturedAt), label: names.displayName,
            device: ScanDevice(model: UIDevice.current.model, systemVersion: UIDevice.current.systemVersion))
        do {
            let url = try await exports.export(room: room, packet: packet,
                fileStem: names.fileStem, includeUSDZ: includeUSDZ,
                photos: includePhotos ? photos : nil)
            guard scanID == token, phase == .exporting else {
                await exports.remove(scanID: token)
                return nil
            }
            phase = .review
            return url
        } catch {
            guard scanID == token, phase == .exporting else { return nil }
            phase = .review
            message = "Export failed. Your current scan is still available; try sharing again."
            return nil
        }
    }

    private func didProcess(_ result: CapturedRoom, id: UUID) {
        guard scanID == id, phase == .processing else { return }
        guard !result.walls.isEmpty else { fail("RoomPlan did not identify any walls. Try a slower scan with better lighting.", id: id); return }
        guard result.objects.count <= ScanWire.maximumObjects else {
            fail("This scan exceeds the 256-object export limit. Scan a smaller room.", id: id)
            return
        }
        room = result
        capturedAt = Date()
        capturedTimeZone = .current
        phase = .review
        message = recordAppearancePhotos && photos.isEmpty
            ? "No appearance photos were saved. Share geometry only, or scan again and pause briefly facing the room."
            : nil
    }

    private func didStop(id: UUID) {
        guard scanID == id else { return }
        if phase == .scanning { fail("The scanning session ended before completion. Start a new scan.", id: id) }
    }

    private func fail(_ detail: String, id: UUID) {
        guard scanID == id, phase == .scanning || phase == .processing else { return }
        gate?.invalidate()
        photoCapture.cancel()
        captureView?.captureSession.arSession.pause()
        room = nil; capturedAt = nil
        phase = .failed
        message = "RoomPlan could not finish this scan. " + String(detail.prefix(300))
    }

    private func clearCurrentScan() {
        let previousID = scanID
        gate?.invalidate()
        // Invalidate identity before stop can deliver a late framework callback.
        scanID = UUID()
        photoCapture.cancel()
        captureView?.captureSession.stop(pauseARSession: true)
        captureView?.delegate = nil
        captureView?.captureSession.delegate = nil
        captureView = nil; coordinator = nil; gate = nil
        room = nil; capturedAt = nil
        photos = []; photoCount = 0; photoMessage = nil
        Task { await exports.remove(scanID: previousID) }
    }
}
