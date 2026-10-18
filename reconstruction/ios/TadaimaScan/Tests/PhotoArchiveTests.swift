import Foundation
import CryptoKit
import ImageIO
import CoreGraphics

@main
struct PhotoArchiveTests {
    static func main() throws {
        let scan = Data(#"{"schemaVersion":"roomplan-scan/1.1","projectId":"synthetic-test","jobId":"synthetic-scan","inputRevision":0}"#.utf8)
        let first = try photo(id: "photo-9907e544-5a73-461c-8cf9-8c6d4aa6a82c", shade: 32)
        let second = try photo(id: "photo-e062e27f-c497-48d8-99e0-42aff626b1dc", shade: 192)
        func encode(_ photos: [CapturedScanPhoto], scanData: Data? = nil,
                    projectId: String = "synthetic-test", revision: Int = 0) throws -> Data {
            try ScanPhotoArchive.encode(scanData: scanData ?? scan, projectId: projectId,
                jobId: "synthetic-scan", inputRevision: revision, photos: photos)
        }
        let archive = try encode([first, second])
        precondition(archive.starts(with: [0x50, 0x4B, 0x03, 0x04]))
        precondition(archive.suffix(22).starts(with: [0x50, 0x4B, 0x05, 0x06]))
        let repeatedArchive = try encode([first, second])
        precondition(archive == repeatedArchive, "Export must be deterministic")
        if CommandLine.arguments.count == 2 {
            try archive.write(to: URL(fileURLWithPath: CommandLine.arguments[1]), options: .atomic)
        }
        let arguments = CommandLine.arguments
        if let scanIndex = arguments.firstIndex(of: "--scan"), scanIndex + 1 < arguments.count,
           let outputIndex = arguments.firstIndex(of: "--emit-bundle"), outputIndex + 1 < arguments.count {
            let source = try Data(contentsOf: URL(fileURLWithPath: arguments[scanIndex + 1]))
            let identity = try JSONSerialization.jsonObject(with: source) as! [String: Any]
            let bundle = try ScanPhotoArchive.encode(scanData: source,
                projectId: identity["projectId"] as! String, jobId: identity["jobId"] as! String,
                inputRevision: identity["inputRevision"] as! Int, photos: [first, second],
                mesh: arguments.contains("--with-mesh") ? syntheticMesh(projectId: identity["projectId"] as! String,
                    jobId: identity["jobId"] as! String) : nil)
            try bundle.write(to: URL(fileURLWithPath: arguments[outputIndex + 1]), options: .atomic)
        }

        let mesh = syntheticMesh(projectId: "synthetic-test", jobId: "synthetic-scan")
        let meshArchive = try ScanPhotoArchive.encode(scanData: scan, projectId: "synthetic-test",
            jobId: "synthetic-scan", inputRevision: 0, photos: [first], mesh: mesh)
        precondition(meshArchive.range(of: Data("roomplan-photo-bundle/1.1".utf8)) != nil)
        precondition(meshArchive.range(of: Data("mesh.json".utf8)) != nil)
        precondition(archive.range(of: Data("roomplan-photo-bundle/1.0".utf8)) != nil)
        precondition(archive.range(of: Data("mesh.json".utf8)) == nil)
        try rejects("mesh identity mismatch") {
            try ScanPhotoArchive.encode(scanData: scan, projectId: "synthetic-test",
                jobId: "synthetic-scan", inputRevision: 0, photos: [first],
                mesh: syntheticMesh(projectId: "wrong-project", jobId: "synthetic-scan"))
        }
        try rejects("no photos") { try encode([]) }
        try rejects("too many photos") { try encode(Array(repeating: first, count: ScanPhotoLimits.maximumPhotos + 1)) }
        try rejects("duplicate identifiers") { try encode([first, first]) }
        let duplicateBytes = try replacing(first, fields: ["id": second.metadata.id, "path": second.metadata.path])
        try rejects("duplicate images") { try encode([first, duplicateBytes]) }
        try rejects("traversal path") { try encode([replacing(first, fields: ["path": "../photo.jpg"])]) }
        try rejects("unbound id") { try encode([replacing(first, fields: ["id": "../unsafe"])]) }
        try rejects("upper-case id") { try encode([replacing(first, fields: ["id": first.metadata.id.uppercased()])]) }
        try rejects("incorrect SHA") { try encode([replacing(first, fields: ["sha256": String(repeating: "0", count: 64)])]) }
        try rejects("incorrect byte length") { try encode([replacing(first, fields: ["byteLength": first.jpeg.count + 1])]) }
        try rejects("wrong dimensions") { try encode([replacing(first, fields: ["width": 23])]) }
        try rejects("oversized dimensions") { try encode([replacing(first, fields: ["height": 1601])]) }
        try rejects("tracking not normal") { try encode([replacing(first, fields: ["trackingState": "limited"])]) }
        try rejects("missing timestamp") { try encode([replacing(first, fields: ["capturedAt": "yesterday"])]) }
        try rejects("negative AR timestamp") { try encode([replacing(first, fields: ["arTimestamp": -1])]) }
        try rejects("wrong pose length") { try encode([replacing(first, fields: ["cameraToWorld": [1, 2, 3]])]) }
        var reflected = first.metadata.cameraToWorld
        reflected[0] = -1
        try rejects("reflected camera pose") { try encode([replacing(first, fields: ["cameraToWorld": reflected])]) }
        var distorted = first.metadata.cameraToWorld
        distorted[4] = 0.3
        try rejects("non-rigid camera pose") { try encode([replacing(first, fields: ["cameraToWorld": distorted])]) }
        var calibration = first.metadata.intrinsics
        calibration[6] = 999
        try rejects("principal point outside image") { try encode([replacing(first, fields: ["intrinsics": calibration])]) }
        try rejects("truncated JPEG") {
            try encode([photo(id: first.metadata.id, jpeg: Data(first.jpeg.dropLast(2)))])
        }
        try rejects("arbitrary bytes with JPEG markers") {
            try encode([photo(id: first.metadata.id, jpeg: Data([0xFF, 0xD8, 0xFF, 0x00, 0xFF, 0xD9]))])
        }
        try rejects("photo over byte limit") {
            try encode([photo(id: first.metadata.id, jpeg: Data(repeating: 1, count: ScanPhotoLimits.maximumPhotoBytes + 1))])
        }
        let largePhotos = try (0..<17).map { index in
            try photo(id: "photo-00000000-0000-4000-8000-" + String(format: "%012x", index),
                jpeg: padding(first.jpeg, to: ScanPhotoLimits.maximumPhotoBytes, value: UInt8(index)))
        }
        try rejects("photos over total byte limit") { try encode(largePhotos) }
        try rejects("invalid scan JSON") { try encode([first], scanData: Data("not JSON".utf8)) }
        try rejects("scan identity mismatch") { try encode([first], projectId: "another-project") }
        try rejects("scan revision mismatch") { try encode([first], revision: 1) }
        try rejects("boolean revision") {
            try encode([first], scanData: Data(#"{"projectId":"synthetic-test","jobId":"synthetic-scan","inputRevision":false}"#.utf8))
        }
        print("PASS: deterministic bounded ZIP export, actual image hashes and dimensions, private paths, tracking, camera matrices, calibration, scan identity and malformed JPEG rejection")
    }

    private static func syntheticMesh(projectId: String, jobId: String) -> ScanMeshPacket {
        ScanMeshPacket(projectId: projectId, jobId: jobId, inputRevision: 0, anchors: [
            ScanMeshAnchorPacket(id: "mesh-00000000-0000-4000-8000-000000000001",
                transform: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],
                vertices: [[0,0,0], [1,0,0], [0,1,0]], faces: [[0,1,2]], classifications: [0])
        ])
    }

    private static func rejects(_ label: String, _ action: () throws -> Data) throws {
        do { _ = try action() }
        catch { return }
        fatalError("Expected rejection: \(label)")
    }

    private static func replacing(_ photo: CapturedScanPhoto, fields: [String: Any]) throws -> CapturedScanPhoto {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(photo.metadata)) as! [String: Any]
        for (key, value) in fields { object[key] = value }
        let metadata = try JSONDecoder().decode(ScanPhotoMetadata.self, from: JSONSerialization.data(withJSONObject: object))
        return CapturedScanPhoto(metadata: metadata, jpeg: photo.jpeg)
    }

    /// Legal JPEG comment segments exercise byte caps without allocating huge images.
    private static func padding(_ jpeg: Data, to size: Int, value: UInt8) -> Data {
        var result = Data(jpeg.prefix(2))
        var remaining = size - jpeg.count
        while remaining > 0 {
            var payload = min(remaining - 4, 65_500)
            if (1...3).contains(remaining - payload - 4) { payload -= 4 }
            precondition(payload >= 0)
            let segmentLength = payload + 2
            result.append(contentsOf: [0xFF, 0xFE, UInt8(segmentLength >> 8), UInt8(segmentLength & 0xFF)])
            result.append(Data(repeating: value, count: payload))
            remaining -= payload + 4
        }
        result.append(jpeg.dropFirst(2))
        precondition(result.count == size)
        return result
    }

    private static func photo(id: String, shade: UInt8 = 32, jpeg supplied: Data? = nil) throws -> CapturedScanPhoto {
        let jpeg: Data
        if let supplied { jpeg = supplied }
        else {
            var pixels = [UInt8](repeating: 255, count: 24 * 16 * 4)
            for y in 0..<16 {
                for x in 0..<24 {
                    let offset = (y * 24 + x) * 4
                    pixels[offset] = UInt8(x * 10)
                    pixels[offset + 1] = UInt8(y * 15)
                    pixels[offset + 2] = shade
                }
            }
            let context = CGContext(data: &pixels, width: 24, height: 16, bitsPerComponent: 8,
                bytesPerRow: 24 * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
            let image = context.makeImage()!
            let data = NSMutableData()
            let destination = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil)!
            CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary)
            precondition(CGImageDestinationFinalize(destination))
            jpeg = data as Data
        }
        let metadata = ScanPhotoMetadata(id: id, path: "photos/\(id).jpg",
            sha256: SHA256.hash(data: jpeg).map { String(format: "%02x", $0) }.joined(),
            byteLength: jpeg.count, width: 24, height: 16, capturedAt: "2026-10-18T10:05:41.123Z",
            arTimestamp: 100.25,
            cameraToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 1.2, -2.0, 1],
            intrinsics: [20, 0, 0, 0, 20, 0, 12, 8, 1], trackingState: "normal")
        return CapturedScanPhoto(metadata: metadata, jpeg: jpeg)
    }
}
