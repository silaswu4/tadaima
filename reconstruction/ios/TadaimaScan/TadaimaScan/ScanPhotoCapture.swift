import Foundation

/// Pure math shared with the host-side executable tests. Matrices are column major.
enum ScanPhotoMath {
    static func rescaledIntrinsics(_ values: [Float], sourceWidth: Int, sourceHeight: Int,
                                   width: Int, height: Int) -> [Float]? {
        guard values.count == 9, values.allSatisfy(\.isFinite),
              sourceWidth > 0, sourceHeight > 0, width > 0, height > 0 else { return nil }
        let sx = Float(width) / Float(sourceWidth)
        let sy = Float(height) / Float(sourceHeight)
        return values.enumerated().map { index, value in
            index % 3 == 0 ? value * sx : (index % 3 == 1 ? value * sy : value)
        }
    }

    static func displacement(_ first: [Float], _ second: [Float]) -> (distance: Float, angle: Float)? {
        guard first.count == 16, second.count == 16,
              first.allSatisfy(\.isFinite), second.allSatisfy(\.isFinite) else { return nil }
        let dx = first[12] - second[12], dy = first[13] - second[13], dz = first[14] - second[14]
        // trace(Ra^T Rb) includes roll as well as the viewing direction.
        var trace: Float = 0
        for column in 0..<3 {
            for row in 0..<3 { trace += first[column * 4 + row] * second[column * 4 + row] }
        }
        return (sqrt(dx * dx + dy * dy + dz * dz), acos(min(1, max(-1, (trace - 1) / 2))))
    }
}

#if canImport(ARKit) && canImport(UIKit)
import ARKit
import CoreImage
import CryptoKit
import ImageIO
import UIKit

/// The only unchecked payload is one retained CVPixelBuffer. Its owner never mutates it;
/// retaining the buffer keeps its storage alive until the serial encoder returns.
private struct ScanPhotoFrame: @unchecked Sendable {
    let buffer: CVPixelBuffer
    let cameraToWorld: [Float]
    let intrinsics: [Float]
    let arTimestamp: Double
    let capturedAt: String
}

private enum ScanPhotoEncoding: Sendable {
    case photo(CapturedScanPhoto)
    case retry(String)
}

private actor ScanPhotoEncoder {
    private let context = CIContext(options: [.cacheIntermediates: false])

    func encode(_ frame: ScanPhotoFrame) -> ScanPhotoEncoding {
        guard !Task.isCancelled else { return .retry("Photo capture cancelled.") }
        let buffer = frame.buffer
        let sourceWidth = CVPixelBufferGetWidth(buffer), sourceHeight = CVPixelBufferGetHeight(buffer)
        guard CVPixelBufferGetPlaneCount(buffer) >= 2,
              CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
              sourceWidth > 0, sourceHeight > 0 else {
            return .retry("This camera frame could not be saved. Try another photo.")
        }
        guard Self.hasUsableExposure(buffer) else {
            return .retry("Aim at a well-lit wall or furniture; avoid glare and very dark views.")
        }
        let scale = min(1, Double(ScanPhotoLimits.maximumImageDimension) / Double(max(sourceWidth, sourceHeight)))
        let width = max(1, Int((Double(sourceWidth) * scale).rounded()))
        let height = max(1, Int((Double(sourceHeight) * scale).rounded()))
        guard let intrinsics = ScanPhotoMath.rescaledIntrinsics(frame.intrinsics,
            sourceWidth: sourceWidth, sourceHeight: sourceHeight, width: width, height: height),
              let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else {
            return .retry("This camera calibration could not be saved. Try another photo.")
        }
        // Core Image reads ARKit's full-range YCbCr attachments. Do not rotate or mirror:
        // the saved JPEG and scaled intrinsics must describe the same sensor pixels.
        let image = CIImage(cvPixelBuffer: buffer, options: [.applyOrientationProperty: false])
            .settingProperties([:])
            .transformed(by: CGAffineTransform(scaleX: Double(width) / Double(sourceWidth),
                                              y: Double(height) / Double(sourceHeight)))
            .cropped(to: CGRect(x: 0, y: 0, width: width, height: height))
        let qualityKey = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
        var jpeg: Data?
        for quality in [0.84, 0.70, 0.55] {
            guard !Task.isCancelled else { return .retry("Photo capture cancelled.") }
            if let candidate = context.jpegRepresentation(of: image, colorSpace: colorSpace,
                                                           options: [qualityKey: quality]),
               candidate.count <= ScanPhotoLimits.maximumPhotoBytes {
                jpeg = candidate
                break
            }
        }
        guard let jpeg else { return .retry("This photo exceeded the size limit. Try another view.") }
        let id = "photo-" + UUID().uuidString.lowercased()
        let metadata = ScanPhotoMetadata(id: id, path: "photos/" + id + ".jpg",
            sha256: SHA256.hash(data: jpeg).map { String(format: "%02x", $0) }.joined(),
            byteLength: jpeg.count, width: width, height: height, capturedAt: frame.capturedAt,
            arTimestamp: frame.arTimestamp, cameraToWorld: frame.cameraToWorld,
            intrinsics: intrinsics, trackingState: "normal")
        return .photo(CapturedScanPhoto(metadata: metadata, jpeg: jpeg))
    }

    private static func hasUsableExposure(_ buffer: CVPixelBuffer) -> Bool {
        guard CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess else { return false }
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let pointer = CVPixelBufferGetBaseAddressOfPlane(buffer, 0) else { return false }
        let width = CVPixelBufferGetWidthOfPlane(buffer, 0), height = CVPixelBufferGetHeightOfPlane(buffer, 0)
        let rowBytes = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
        let pixels = pointer.assumingMemoryBound(to: UInt8.self)
        var sum = 0, dark = 0, bright = 0, count = 0
        for y in stride(from: 0, to: height, by: max(1, height / 60)) {
            for x in stride(from: 0, to: width, by: max(1, width / 80)) {
                let value = Int(pixels[y * rowBytes + x])
                sum += value; count += 1
                if value < 12 { dark += 1 }
                if value > 248 { bright += 1 }
            }
        }
        guard count > 0 else { return false }
        let mean = Double(sum) / Double(count)
        return mean >= 25 && mean <= 235 && Double(dark) / Double(count) < 0.75
            && Double(bright) / Double(count) < 0.70
    }
}

/// Samples RoomPlan's existing session. Never installs an ARSession delegate or camera session.
@MainActor
final class ScanPhotoCapture {
    private let encoder = ScanPhotoEncoder()
    private weak var session: ARSession?
    private var sampler: Task<Void, Never>?
    private var processing: Task<Void, Never>?
    private var processingGeneration: UUID?
    private var generation = UUID()
    private var accepting = false
    private var photos: [CapturedScanPhoto] = []
    private var totalBytes = 0
    private var lastSample: (pose: [Float], time: Double)?
    private var lastSaved: (pose: [Float], time: Double)?
    private var onUpdate: (@MainActor (Int, String?) -> Void)?

    func start(session: ARSession, onUpdate: @escaping @MainActor (Int, String?) -> Void) {
        cancel()
        self.session = session
        self.onUpdate = onUpdate
        accepting = true
        onUpdate(0, "Move slowly and pause to capture room finishes and furniture.")
        sampler = Task { [weak self] in
            while !Task.isCancelled {
                guard self != nil else { break }
                self?.sample(manual: false)
                do { try await Task.sleep(for: .milliseconds(800)) } catch { break }
            }
        }
    }

    func captureNow() { sample(manual: true) }

    /// Stop accepting frames, but let the single encoder finish before publishing its result.
    func stop() async -> [CapturedScanPhoto] {
        let token = generation
        accepting = false
        sampler?.cancel(); sampler = nil
        session = nil
        let pending = processing
        await pending?.value
        guard generation == token else { return [] }
        return photos
    }

    func cancel() {
        generation = UUID()
        accepting = false
        sampler?.cancel(); sampler = nil
        // Keep a cancelled encoder slot occupied until it returns. A rapid rescan
        // must not queue a second retained camera buffer behind it.
        processing?.cancel()
        session = nil; photos = []; totalBytes = 0
        lastSample = nil; lastSaved = nil; onUpdate = nil
    }

    private func sample(manual: Bool) {
        guard accepting, let frame = session?.currentFrame, frame.timestamp.isFinite else { return }
        guard case .normal = frame.camera.trackingState else {
            onUpdate?(photos.count, "Keep moving slowly until camera tracking is ready.")
            lastSample = nil
            return
        }
        let matrix = frame.camera.transform
        let pose = [matrix.columns.0, matrix.columns.1, matrix.columns.2, matrix.columns.3]
            .flatMap { [$0.x, $0.y, $0.z, $0.w] }
        let previous = lastSample
        lastSample = (pose, frame.timestamp)
        guard processing == nil else {
            if manual { onUpdate?(photos.count, "Saving the previous photo. Hold still for a moment.") }
            return
        }
        guard photos.count < ScanPhotoLimits.maximumPhotos,
              totalBytes < ScanPhotoLimits.maximumTotalBytes else {
            onUpdate?(photos.count, "Photo limit reached. Your saved photos are ready to share with this scan.")
            return
        }
        guard let previous, let motion = ScanPhotoMath.displacement(previous.pose, pose) else {
            if manual { onUpdate?(photos.count, "Hold still briefly, then capture the photo.") }
            return
        }
        let elapsed = frame.timestamp - previous.time
        guard elapsed > 0.05, elapsed < 3,
              Double(motion.distance) / elapsed <= 0.28,
              Double(motion.angle) / elapsed <= 0.45 else {
            if manual { onUpdate?(photos.count, "Hold the phone steady for a sharper photo.") }
            return
        }
        if !manual, let saved = lastSaved {
            guard frame.timestamp - saved.time >= 1.5,
                  let change = ScanPhotoMath.displacement(saved.pose, pose),
                  change.distance >= 0.25 || change.angle >= Float.pi / 15 else { return }
        }
        let imageResolution = frame.camera.imageResolution
        guard imageResolution.width == Double(CVPixelBufferGetWidth(frame.capturedImage)),
              imageResolution.height == Double(CVPixelBufferGetHeight(frame.capturedImage)) else {
            onUpdate?(photos.count, "The camera image and calibration sizes did not match. Try another photo.")
            return
        }
        let intrinsics = frame.camera.intrinsics
        let snapshot = ScanPhotoFrame(buffer: frame.capturedImage, cameraToWorld: pose,
            intrinsics: [intrinsics.columns.0, intrinsics.columns.1, intrinsics.columns.2]
                .flatMap { [$0.x, $0.y, $0.z] },
            arTimestamp: frame.timestamp,
            capturedAt: ISO8601DateFormatter().string(from:
                Date().addingTimeInterval(frame.timestamp - ProcessInfo.processInfo.systemUptime)))
        let token = generation
        processingGeneration = token
        processing = Task { [weak self, encoder] in
            let result = await encoder.encode(snapshot)
            guard let self else { return }
            if self.processingGeneration == token {
                self.processing = nil
                self.processingGeneration = nil
            }
            guard self.generation == token, !Task.isCancelled else { return }
            switch result {
            case .retry(let reason): self.onUpdate?(self.photos.count, reason)
            case .photo(let photo):
                guard !self.photos.contains(where: { $0.metadata.sha256 == photo.metadata.sha256 }) else {
                    self.onUpdate?(self.photos.count, "This view is already saved. Capture another angle.")
                    return
                }
                guard self.totalBytes + photo.jpeg.count <= ScanPhotoLimits.maximumTotalBytes else {
                    self.onUpdate?(self.photos.count, "Photo storage limit reached. Existing photos are saved.")
                    return
                }
                self.photos.append(photo)
                self.totalBytes += photo.jpeg.count
                self.lastSaved = (photo.metadata.cameraToWorld, photo.metadata.arTimestamp)
                self.onUpdate?(self.photos.count, "Photo saved. Include walls, floor and furniture from several angles.")
            }
        }
    }
}
#endif
