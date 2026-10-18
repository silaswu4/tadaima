import ARKit
import AVFoundation
import Combine
import Foundation
import RoomPlan
import UIKit

@MainActor
final class ScanModel: ObservableObject {
    enum Phase { case idle, requestingPermission, scanning, processing, detailing, finishingDetail, review, exporting, failed }
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var captureView: RoomCaptureView?
    @Published private(set) var scanID = UUID()
    @Published private(set) var message: String?
    @Published private(set) var cameraDenied = false
    @Published var roomLabel = "Living room"
    @Published var recordAppearancePhotos = true
    @Published var recordDetailedSurfaces = true
    @Published private(set) var detailView: ARSCNView?
    @Published private(set) var meshFaceCount = 0
    private(set) var mesh: ScanMeshPacket?
    private var detailSession: ARSession?
    private var meshSampler: Task<Void, Never>?
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
    var isBusy: Bool { [.requestingPermission, .processing, .finishingDetail, .exporting].contains(phase) }
    var surfaceCount: Int { room.map { $0.walls.count + $0.doors.count + $0.windows.count + $0.openings.count } ?? 0 }
    var objectCount: Int { room?.objects.count ?? 0 }
    var scanName: String? {
        guard let capturedAt else { return nil }
        return ScanNames(roomLabel: roomLabel, capturedAt: capturedAt, scanID: scanID,
                         timeZone: capturedTimeZone).displayName
    }

    func start() async {
        guard supported, !isBusy, phase != .scanning, phase != .detailing else { return }
        clearCurrentScan()
        if recordDetailedSurfaces { recordAppearancePhotos = true }
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
        if recordAppearancePhotos && !recordDetailedSurfaces {
            photoCapture.start(session: view.captureSession.arSession) { [weak self] count, detail in
                guard let self, self.scanID == token else { return }
                self.photoCount = count
                self.photoMessage = detail
            }
        }
    }

    func capturePhoto() {
        guard phase == .detailing || (phase == .scanning && !recordDetailedSurfaces) else { return }
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
        captureView.captureSession.stop(pauseARSession: !recordDetailedSurfaces)
    }

    func rescan() {
        guard phase != .exporting else { return }
        clearCurrentScan()
        phase = .idle
        message = nil
    }

    func backgrounded() {
        guard [.requestingPermission, .scanning, .processing, .detailing, .finishingDetail, .exporting].contains(phase) else { return }
        clearCurrentScan()
        phase = .idle
        message = "The scan was cancelled when the app went into the background. Start a new scan when you return."
    }

    func shareFile(includeUSDZ: Bool, includePhotos: Bool = false) async -> URL? {
        guard phase == .review, let room, let capturedAt else { return nil }
        guard !includePhotos || !recordDetailedSurfaces || mesh != nil else {
            message = "No detailed mesh was saved. Share the RoomPlan geometry or scan again."
            return nil
        }
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
                photos: includePhotos ? photos : nil, mesh: includePhotos ? mesh : nil)
            guard scanID == token, phase == .exporting else {
                await exports.remove(scanID: token)
                return nil
            }
            phase = .review
            return url
        } catch {
            guard scanID == token, phase == .exporting else { return nil }
            phase = .review
            message = "Export failed: " + error.localizedDescription + ". Your current scan is still available."
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
        if recordDetailedSurfaces {
            beginDetailPass()
            return
        }
        phase = .review
        message = recordAppearancePhotos && photos.isEmpty
            ? "No appearance photos were saved. Share geometry only, or scan again and pause briefly facing the room."
            : nil
    }

    private func beginDetailPass() {
        guard let session = captureView?.captureSession.arSession else {
            phase = .review
            message = "The detailed session was unavailable. RoomPlan geometry remains available; scan again for detailed surfaces."
            return
        }
        let configuration = ARWorldTrackingConfiguration()
        if ARWorldTrackingConfiguration.supportsSceneReconstruction(.meshWithClassification) {
            configuration.sceneReconstruction = .meshWithClassification
        } else if ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) {
            configuration.sceneReconstruction = .mesh
        } else {
            session.pause()
            phase = .review
            message = "Detailed surface capture is not supported on this device. RoomPlan geometry remains available."
            return
        }
        configuration.worldAlignment = .gravity
        configuration.planeDetection = []
        let view = ARSCNView(frame: .zero)
        view.session = session
        detailSession = session
        detailView = view
        phase = .detailing
        message = "Walk around furniture and capture its front, sides and back. Pause for sharp photos. Unseen surfaces cannot be recovered."
        // No reset: detailed surfaces, semantic room and RGB poses share one origin.
        session.run(configuration, options: [])
        let token = scanID
        if recordAppearancePhotos {
            photoCapture.start(session: session) { [weak self] count, detail in
                guard let self, self.scanID == token else { return }
                self.photoCount = count; self.photoMessage = detail
            }
        }
        meshSampler = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.scanID == token, self.phase == .detailing else { return }
                self.meshFaceCount = self.detailSession?.currentFrame?.anchors
                    .compactMap { $0 as? ARMeshAnchor }.reduce(0) { $0 + $1.geometry.faces.count } ?? 0
                do { try await Task.sleep(for: .milliseconds(750)) } catch { return }
            }
        }
    }

    func finishDetail() async {
        guard phase == .detailing, let session = detailSession else { return }
        guard let frame = session.currentFrame, case .normal = frame.camera.trackingState else {
            message = "Tracking is not ready. Move slowly back toward an area already scanned, then finish."
            return
        }
        let token = scanID
        phase = .finishingDetail
        meshSampler?.cancel(); meshSampler = nil
        let captured = await photoCapture.stop()
        guard scanID == token, phase == .finishingDetail else { return }
        session.pause()
        // Read the current anchor set after pausing, not an accumulated set with removed anchors.
        let anchors = session.currentFrame?.anchors.compactMap { $0 as? ARMeshAnchor } ?? []
        do {
            let result = try await Task.detached(priority: .userInitiated) {
                try ScanMeshCapture.snapshot(anchors: anchors, projectId: "local-roomplan",
                    jobId: "scan-" + token.uuidString.lowercased(), inputRevision: 0)
            }.value
            guard scanID == token, phase == .finishingDetail else { return }
            mesh = result.packet
            meshFaceCount = result.packet.anchors.reduce(0) { $0 + $1.faces.count }
            photos = captured; photoCount = captured.count
            detailView = nil
            capturedAt = Date(); capturedTimeZone = .current
            phase = .review
            var notes = ["Captured real surface geometry. Hidden or reflective details can still be incomplete."]
            if result.discardedFaces > 0 { notes.append("Removed \(result.discardedFaces) degenerate or duplicate triangles.") }
            if photos.isEmpty { notes.append("No photos were saved; a textured surface bundle cannot be exported. Scan again with appearance photos enabled.") }
            message = notes.joined(separator: " ")
        } catch {
            guard scanID == token else { return }
            // Keep the semantic result available, but never imply an empty or truncated mesh succeeded.
            mesh = nil; photos = captured; photoCount = captured.count; detailView = nil
            capturedAt = Date(); capturedTimeZone = .current
            phase = .review
            message = error.localizedDescription + ". Detailed geometry was not saved. You can export the RoomPlan geometry or scan again."
        }
    }

    private func didStop(id: UUID) {
        guard scanID == id else { return }
        if phase == .scanning { fail("The scanning session ended before completion. Start a new scan.", id: id) }
    }

    private func fail(_ detail: String, id: UUID) {
        guard scanID == id, phase == .scanning || phase == .processing || phase == .detailing || phase == .finishingDetail else { return }
        gate?.invalidate()
        photoCapture.cancel()
        meshSampler?.cancel(); meshSampler = nil
        detailSession?.pause()
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
        meshSampler?.cancel(); meshSampler = nil
        detailSession?.pause(); detailSession = nil; detailView = nil; mesh = nil; meshFaceCount = 0
        captureView?.captureSession.stop(pauseARSession: true)
        captureView?.delegate = nil
        captureView?.captureSession.delegate = nil
        captureView = nil; coordinator = nil; gate = nil
        room = nil; capturedAt = nil
        photos = []; photoCount = 0; photoMessage = nil
        Task { await exports.remove(scanID: previousID) }
    }
}
