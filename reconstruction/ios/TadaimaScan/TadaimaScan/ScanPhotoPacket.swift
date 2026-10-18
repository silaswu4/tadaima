import Foundation

enum ScanPhotoLimits {
    static let maximumPhotos = 32
    static let maximumPhotoBytes = 2 * 1024 * 1024
    static let maximumTotalBytes = 32 * 1024 * 1024
    static let maximumImageDimension = 1600
}

/// JPEGs retain raw sensor orientation (no EXIF rotation). Intrinsics are scaled
/// to these exact saved pixel dimensions. Neither matrix is floor-normalized.
struct ScanPhotoMetadata: Codable, Sendable {
    let id: String
    let path: String
    let sha256: String
    let byteLength: Int
    let width: Int
    let height: Int
    let capturedAt: String
    let arTimestamp: Double
    /// Native ARKit camera-to-world, column-major, right-handed meters/Y up.
    /// Camera axes: +X right, +Y up, looking toward -Z.
    let cameraToWorld: [Float]
    /// Column-major 3x3 calibration; image pixels originate at top left.
    let intrinsics: [Float]
    let trackingState: String
}

struct CapturedScanPhoto: Sendable {
    let metadata: ScanPhotoMetadata
    let jpeg: Data
}

/// Export availability depends on retained data, never on whether a mesh was requested.
enum ScanPhotoExportKind: Equatable {
    case photos, photosWithoutDetailedMesh, detailed

    static func available(photoCount: Int, hasMesh: Bool, requestedMesh: Bool) -> Self? {
        guard photoCount > 0 else { return nil }
        if hasMesh { return .detailed }
        return requestedMesh ? .photosWithoutDetailedMesh : .photos
    }

    var label: String {
        switch self {
        case .photos: "Share scan + photos"
        case .photosWithoutDetailedMesh: "Share photos + layout (no detailed mesh)"
        case .detailed: "Share detailed scan + photos"
        }
    }
}

/// A share retry may clear transient messages, but must retain the capture failure.
struct ScanReviewMessages {
    var transient: String?
    var captureWarning: String?

    mutating func beginExport() { transient = nil }
}
