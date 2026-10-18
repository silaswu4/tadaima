import Foundation
import CryptoKit
import ImageIO
import CoreGraphics

enum ScanPhotoArchiveError: LocalizedError {
    case invalid(String)

    var errorDescription: String? {
        switch self {
        case .invalid(let reason): "Cannot export scan photos: \(reason)"
        }
    }
}

/// A bounded ZIP STORE archive. Fixed paths and no compression make the bundle
/// portable without introducing an archive dependency or changing image bytes.
enum ScanPhotoArchive {
    private struct ScanReference: Encodable {
        let path: String
        let sha256: String
    }

    private struct Manifest: Encodable {
        let schemaVersion: String
        let projectId: String
        let jobId: String
        let inputRevision: Int
        let coordinateSystem = "arkit-gravity-y-up-metres"
        let imageConvention = "raw-sensor-top-left"
        let scan: ScanReference
        let photos: [ScanPhotoMetadata]
        let mesh: MeshReference?
    }

    private struct MeshReference: Encodable {
        let path: String
        let sha256: String
        let byteLength: Int
    }

    static func encode(scanData: Data, projectId: String, jobId: String,
                       inputRevision: Int, photos: [CapturedScanPhoto], mesh: ScanMeshPacket? = nil) throws -> Data {
        guard !scanData.isEmpty, scanData.count <= 2 * 1024 * 1024,
              !projectId.isEmpty, projectId.utf8.count <= 200,
              !jobId.isEmpty, jobId.utf8.count <= 200, inputRevision >= 0,
              let scan = try JSONSerialization.jsonObject(with: scanData) as? [String: Any],
              scan["projectId"] as? String == projectId,
              scan["jobId"] as? String == jobId,
              let revision = scan["inputRevision"] as? NSNumber,
              CFGetTypeID(revision) != CFBooleanGetTypeID(),
              revision.doubleValue == Double(inputRevision) else {
            throw ScanPhotoArchiveError.invalid("scan identity or JSON is invalid")
        }
        guard !photos.isEmpty, photos.count <= ScanPhotoLimits.maximumPhotos else {
            throw ScanPhotoArchiveError.invalid("capture between 1 and \(ScanPhotoLimits.maximumPhotos) photos")
        }
        var ids = Set<String>()
        var hashes = Set<String>()
        var totalBytes = 0
        for photo in photos {
            let metadata = photo.metadata
            guard metadata.id.hasPrefix("photo-"),
                  let uuid = UUID(uuidString: String(metadata.id.dropFirst(6))),
                  "photo-" + uuid.uuidString.lowercased() == metadata.id,
                  metadata.path == "photos/\(metadata.id).jpg",
                  ids.insert(metadata.id).inserted else {
                throw ScanPhotoArchiveError.invalid("photo paths or identifiers are invalid or repeated")
            }
            guard !photo.jpeg.isEmpty, photo.jpeg.count <= ScanPhotoLimits.maximumPhotoBytes,
                  metadata.byteLength == photo.jpeg.count,
                  metadata.sha256 == digest(photo.jpeg), hashes.insert(metadata.sha256).inserted else {
                throw ScanPhotoArchiveError.invalid("photo size, hash, or duplicate image is invalid")
            }
            totalBytes += photo.jpeg.count
            guard totalBytes <= ScanPhotoLimits.maximumTotalBytes else {
                throw ScanPhotoArchiveError.invalid("photos exceed the total size limit")
            }
            try validate(metadata: metadata, jpeg: photo.jpeg)
        }
        let meshData: Data?
        if let mesh {
            guard mesh.projectId == projectId, mesh.jobId == jobId, mesh.inputRevision == inputRevision else {
                throw ScanPhotoArchiveError.invalid("mesh and scan identities do not match")
            }
            meshData = try ScanMeshWire.encode(mesh)
        } else { meshData = nil }
        let manifest = Manifest(schemaVersion: mesh == nil ? "roomplan-photo-bundle/1.0" : "roomplan-photo-bundle/1.1",
            projectId: projectId, jobId: jobId, inputRevision: inputRevision,
            scan: ScanReference(path: "roomplan.json", sha256: digest(scanData)), photos: photos.map(\.metadata),
            mesh: meshData.map { MeshReference(path: "mesh.json", sha256: digest($0), byteLength: $0.count) })
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let manifestData = try encoder.encode(manifest)
        guard manifestData.count <= 256 * 1024 else {
            throw ScanPhotoArchiveError.invalid("photo metadata exceeds the size limit")
        }
        var entries = [("manifest.json", manifestData), ("roomplan.json", scanData)]
        if let meshData { entries.append(("mesh.json", meshData)) }
        entries += photos.map { ($0.metadata.path, $0.jpeg) }
        let archive = zip(entries: entries)
        guard archive.count <= 96 * 1024 * 1024 else {
            throw ScanPhotoArchiveError.invalid("archive exceeds 96 MiB")
        }
        return archive
    }

    private static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func validate(metadata: ScanPhotoMetadata, jpeg: Data) throws {
        let dateParser = ISO8601DateFormatter()
        dateParser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fractionalDate = dateParser.date(from: metadata.capturedAt)
        dateParser.formatOptions = [.withInternetDateTime]
        guard metadata.capturedAt.utf8.count <= 40,
              fractionalDate != nil || dateParser.date(from: metadata.capturedAt) != nil,
              metadata.arTimestamp.isFinite, metadata.arTimestamp > 0,
              metadata.trackingState == "normal",
              (1...ScanPhotoLimits.maximumImageDimension).contains(metadata.width),
              (1...ScanPhotoLimits.maximumImageDimension).contains(metadata.height) else {
            throw ScanPhotoArchiveError.invalid("photo timing, tracking, or dimensions are invalid")
        }
        let matrix = metadata.cameraToWorld
        let calibration = metadata.intrinsics
        guard matrix.count == 16, calibration.count == 9,
              matrix.allSatisfy({ $0.isFinite && abs($0) <= 10_000 }),
              calibration.allSatisfy({ $0.isFinite }),
              abs(matrix[3]) < 0.0001, abs(matrix[7]) < 0.0001,
              abs(matrix[11]) < 0.0001, abs(matrix[15] - 1) < 0.0001,
              calibration[0] > 0, calibration[4] > 0,
              calibration[0] <= 100_000, calibration[4] <= 100_000,
              abs(calibration[1]) < 0.0001, abs(calibration[2]) < 0.0001,
              abs(calibration[3]) < 0.0001, abs(calibration[5]) < 0.0001,
              abs(calibration[8] - 1) < 0.0001,
              calibration[6] >= 0, calibration[6] <= Float(metadata.width),
              calibration[7] >= 0, calibration[7] <= Float(metadata.height) else {
            throw ScanPhotoArchiveError.invalid("camera pose or calibration is invalid")
        }
        let axes = (0..<3).map { column in (0..<3).map { row in matrix[column * 4 + row] } }
        for first in 0..<3 {
            for second in first..<3 {
                let dot = (0..<3).reduce(Float(0)) { $0 + axes[first][$1] * axes[second][$1] }
                guard abs(dot - (first == second ? 1 : 0)) < 0.01 else {
                    throw ScanPhotoArchiveError.invalid("camera pose must have orthonormal axes")
                }
            }
        }
        let determinant = axes[0][0] * (axes[1][1] * axes[2][2] - axes[1][2] * axes[2][1])
            - axes[1][0] * (axes[0][1] * axes[2][2] - axes[0][2] * axes[2][1])
            + axes[2][0] * (axes[0][1] * axes[1][2] - axes[0][2] * axes[1][1])
        guard abs(determinant - 1) < 0.01 else {
            throw ScanPhotoArchiveError.invalid("camera pose must be right-handed")
        }
        guard jpeg.starts(with: [0xFF, 0xD8, 0xFF]), jpeg.suffix(2).elementsEqual([0xFF, 0xD9]),
              let source = CGImageSourceCreateWithData(jpeg as CFData, nil),
              CGImageSourceGetStatus(source) == .statusComplete,
              CGImageSourceGetCount(source) == 1,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue == metadata.width,
              (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue == metadata.height,
              (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1 == 1,
              let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary),
              image.width == metadata.width, image.height == metadata.height else {
            throw ScanPhotoArchiveError.invalid("photo must be a complete JPEG matching its saved dimensions and raw orientation")
        }
    }

    private struct CentralEntry {
        let name: Data
        let crc: UInt32
        let size: UInt32
        let offset: UInt32
    }

    private static let crcTable: [UInt32] = (0..<256).map { index in
        var value = UInt32(index)
        for _ in 0..<8 { value = (value >> 1) ^ ((value & 1) == 1 ? 0xEDB88320 : 0) }
        return value
    }

    private static func crc32(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xFFFFFFFF
        for byte in data { crc = crcTable[Int((crc ^ UInt32(byte)) & 0xFF)] ^ (crc >> 8) }
        return crc ^ 0xFFFFFFFF
    }

    private static func zip(entries: [(String, Data)]) -> Data {
        // All sizes/counts are bounded far below classic ZIP's UInt16/UInt32 limits.
        var output = Data()
        var directory: [CentralEntry] = []
        for (path, data) in entries {
            let name = Data(path.utf8)
            let entry = CentralEntry(name: name, crc: crc32(data), size: UInt32(data.count), offset: UInt32(output.count))
            output.appendLE(UInt32(0x04034B50))
            output.appendLE(UInt16(20)) // ZIP 2.0, no flags, STORE, 1980-01-01.
            output.appendLE(UInt16(0)); output.appendLE(UInt16(0))
            output.appendLE(UInt16(0)); output.appendLE(UInt16(33))
            output.appendLE(entry.crc); output.appendLE(entry.size); output.appendLE(entry.size)
            output.appendLE(UInt16(name.count)); output.appendLE(UInt16(0))
            output.append(name); output.append(data)
            directory.append(entry)
        }
        let directoryOffset = UInt32(output.count)
        for entry in directory {
            output.appendLE(UInt32(0x02014B50))
            output.appendLE(UInt16(0x0314)) // Unix creator, ZIP 2.0.
            output.appendLE(UInt16(20)); output.appendLE(UInt16(0)); output.appendLE(UInt16(0))
            output.appendLE(UInt16(0)); output.appendLE(UInt16(33))
            output.appendLE(entry.crc); output.appendLE(entry.size); output.appendLE(entry.size)
            output.appendLE(UInt16(entry.name.count)); output.appendLE(UInt16(0)); output.appendLE(UInt16(0))
            output.appendLE(UInt16(0)); output.appendLE(UInt16(0))
            output.appendLE(UInt32(0o100600) << 16)
            output.appendLE(entry.offset); output.append(entry.name)
        }
        let directorySize = UInt32(output.count) - directoryOffset
        output.appendLE(UInt32(0x06054B50))
        output.appendLE(UInt16(0)); output.appendLE(UInt16(0))
        output.appendLE(UInt16(directory.count)); output.appendLE(UInt16(directory.count))
        output.appendLE(directorySize); output.appendLE(directoryOffset); output.appendLE(UInt16(0))
        return output
    }
}

private extension Data {
    mutating func appendLE<T: FixedWidthInteger>(_ value: T) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { append(contentsOf: $0) }
    }
}
