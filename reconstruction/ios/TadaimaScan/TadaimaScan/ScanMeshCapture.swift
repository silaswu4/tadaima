import ARKit
import Foundation
import Metal

/// Copies a paused ARSession's current mesh into owned values. No Metal buffer is exported.
enum ScanMeshCapture {
    struct Result: Sendable {
        let packet: ScanMeshPacket
        let discardedFaces: Int
    }

    static func snapshot(anchors: [ARMeshAnchor], projectId: String, jobId: String,
                         inputRevision: Int) throws -> Result {
        guard anchors.count <= ScanMeshWire.maximumAnchors else {
            throw ScanMeshError.invalid("more than 128 mesh anchors; scan a smaller area")
        }
        var packets: [ScanMeshAnchorPacket] = []
        var totalVertices = 0; var totalFaces = 0; var discarded = 0
        for anchor in anchors {
            let geometry = anchor.geometry
            let source = geometry.vertices
            let faces = geometry.faces
            guard source.format == .float3, source.componentsPerVector == 3,
                  source.count >= 0, source.stride >= 12, source.offset >= 0,
                  faces.primitiveType == .triangle, faces.indexCountPerPrimitive == 3,
                  faces.bytesPerIndex == 2 || faces.bytesPerIndex == 4 else {
                throw ScanMeshError.invalid("unsupported mesh buffer layout")
            }
            guard source.count > 0, faces.count > 0 else { continue }
            totalVertices += source.count; totalFaces += faces.count
            guard totalVertices <= ScanMeshWire.maximumVertices, totalFaces <= ScanMeshWire.maximumFaces,
                  source.offset + (source.count - 1) * source.stride + 12 <= source.buffer.length,
                  faces.count * 3 * faces.bytesPerIndex <= faces.buffer.length else {
                throw ScanMeshError.invalid("mesh buffer or geometry limit exceeded; scan a smaller area")
            }
            let vertexPointer = source.buffer.contents()
            let vertices: [[Float]] = try (0..<source.count).map { index in
                let p = vertexPointer.advanced(by: source.offset + index * source.stride)
                let vertex = (0..<3).map { p.loadUnaligned(fromByteOffset: $0 * 4, as: Float.self) }
                guard vertex.allSatisfy({ $0.isFinite && abs($0) <= 10_000 }) else {
                    throw ScanMeshError.invalid("nonfinite or out-of-bounds vertex")
                }
                return vertex
            }
            var copiedFaces: [[Int]] = []; var classifications: [Int] = []
            var faceKeys = Set<[Int]>()
            let facePointer = faces.buffer.contents()
            let classification = geometry.classification
            if let classification {
                guard classification.format == .uchar, classification.componentsPerVector == 1,
                      classification.count == faces.count, classification.offset >= 0, classification.stride >= 1,
                      classification.offset + (classification.count - 1) * classification.stride + 1 <= classification.buffer.length else {
                    throw ScanMeshError.invalid("invalid mesh classifications")
                }
            }
            for index in 0..<faces.count {
                let face = (0..<3).map { corner -> Int in
                    let offset = (index * 3 + corner) * faces.bytesPerIndex
                    if faces.bytesPerIndex == 2 {
                        return Int(facePointer.loadUnaligned(fromByteOffset: offset, as: UInt16.self))
                    }
                    return Int(facePointer.loadUnaligned(fromByteOffset: offset, as: UInt32.self))
                }
                guard face.allSatisfy({ $0 >= 0 && $0 < vertices.count }) else {
                    throw ScanMeshError.invalid("mesh index is outside the vertex array")
                }
                if ScanMeshWire.degenerate(face: face, vertices: vertices)
                    || !faceKeys.insert(face.sorted()).inserted { discarded += 1; continue }
                copiedFaces.append(face)
                let raw = classification.map { Int($0.buffer.contents().loadUnaligned(
                    fromByteOffset: $0.offset + index * $0.stride, as: UInt8.self)) } ?? 0
                classifications.append((0...7).contains(raw) ? raw : 0)
            }
            guard !copiedFaces.isEmpty else { continue }
            let matrix = anchor.transform
            let transform = [matrix.columns.0, matrix.columns.1, matrix.columns.2, matrix.columns.3]
                .flatMap { [$0.x, $0.y, $0.z, $0.w] }
            packets.append(ScanMeshAnchorPacket(id: "mesh-" + anchor.identifier.uuidString.lowercased(),
                transform: transform, vertices: vertices, faces: copiedFaces, classifications: classifications))
        }
        let packet = ScanMeshPacket(projectId: projectId, jobId: jobId,
            inputRevision: inputRevision, anchors: packets)
        try ScanMeshWire.validate(packet)
        return Result(packet: packet, discardedFaces: discarded)
    }
}
