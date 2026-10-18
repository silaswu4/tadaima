import Foundation

struct ScanMeshAnchorPacket: Codable, Sendable {
    let id: String
    let transform: [Float]
    let vertices: [[Float]]
    let faces: [[Int]]
    let classifications: [Int]
}

struct ScanMeshPacket: Encodable, Sendable {
    let schemaVersion = "roomplan-mesh/1.0"
    let projectId: String
    let jobId: String
    let inputRevision: Int
    let coordinateSystem = "arkit-gravity-y-up-metres"
    let captureMethod = "arkit-scene-reconstruction"
    let anchors: [ScanMeshAnchorPacket]
}

enum ScanMeshError: LocalizedError {
    case invalid(String)
    var errorDescription: String? {
        switch self { case .invalid(let reason): "Detailed surface scan: \(reason)" }
    }
}

enum ScanMeshWire {
    static let maximumAnchors = 128
    static let maximumVertices = 400_000
    static let maximumFaces = 600_000
    static let maximumJSONBytes = 96 * 1024 * 1024

    static func validate(_ packet: ScanMeshPacket) throws {
        guard !packet.projectId.isEmpty, packet.projectId.utf8.count <= 200,
              !packet.jobId.isEmpty, packet.jobId.utf8.count <= 200, packet.inputRevision >= 0,
              !packet.anchors.isEmpty, packet.anchors.count <= maximumAnchors else {
            throw ScanMeshError.invalid("missing geometry or identity, or too many mesh anchors")
        }
        var ids = Set<String>(); var vertexCount = 0; var faceCount = 0
        for anchor in packet.anchors {
            guard anchor.id.hasPrefix("mesh-"),
                  let uuid = UUID(uuidString: String(anchor.id.dropFirst(5))),
                  anchor.id == "mesh-" + uuid.uuidString.lowercased(), ids.insert(anchor.id).inserted else {
                throw ScanMeshError.invalid("invalid or repeated anchor identifier")
            }
            try validateTransform(anchor.transform)
            vertexCount += anchor.vertices.count; faceCount += anchor.faces.count
            guard !anchor.vertices.isEmpty, !anchor.faces.isEmpty,
                  vertexCount <= maximumVertices, faceCount <= maximumFaces,
                  anchor.classifications.count == anchor.faces.count else {
                throw ScanMeshError.invalid("empty mesh, mismatched classifications, or geometry limit exceeded; scan a smaller area")
            }
            for vertex in anchor.vertices {
                guard vertex.count == 3, vertex.allSatisfy({ $0.isFinite && abs($0) <= 10_000 }) else {
                    throw ScanMeshError.invalid("invalid vertex")
                }
            }
            var faceKeys = Set<[Int]>()
            for (index, face) in anchor.faces.enumerated() {
                guard face.count == 3, face.allSatisfy({ $0 >= 0 && $0 < anchor.vertices.count }),
                      (0...7).contains(anchor.classifications[index]),
                      !degenerate(face: face, vertices: anchor.vertices),
                      faceKeys.insert(face.sorted()).inserted else {
                    throw ScanMeshError.invalid("invalid, duplicate or degenerate triangle")
                }
            }
        }
    }

    static func validateTransform(_ m: [Float]) throws {
        guard m.count == 16, m.allSatisfy({ $0.isFinite && abs($0) <= 10_000 }),
              abs(m[3]) < 0.0001, abs(m[7]) < 0.0001, abs(m[11]) < 0.0001,
              abs(m[15] - 1) < 0.0001 else { throw ScanMeshError.invalid("invalid anchor transform") }
        for a in 0..<3 {
            for b in a..<3 {
                let dot = (0..<3).reduce(Float(0)) { $0 + m[a * 4 + $1] * m[b * 4 + $1] }
                guard abs(dot - (a == b ? 1 : 0)) < 0.01 else {
                    throw ScanMeshError.invalid("anchor transform must be rigid")
                }
            }
        }
        let det = m[0] * (m[5] * m[10] - m[9] * m[6])
            - m[4] * (m[1] * m[10] - m[9] * m[2])
            + m[8] * (m[1] * m[6] - m[5] * m[2])
        guard abs(det - 1) < 0.01 else { throw ScanMeshError.invalid("anchor transform must be right-handed") }
    }

    static func degenerate(face: [Int], vertices: [[Float]]) -> Bool {
        guard Set(face).count == 3 else { return true }
        let a = vertices[face[0]], b = vertices[face[1]], c = vertices[face[2]]
        let u = (Double(b[0] - a[0]), Double(b[1] - a[1]), Double(b[2] - a[2]))
        let v = (Double(c[0] - a[0]), Double(c[1] - a[1]), Double(c[2] - a[2]))
        let cross = (u.1 * v.2 - u.2 * v.1, u.2 * v.0 - u.0 * v.2, u.0 * v.1 - u.1 * v.0)
        return cross.0 * cross.0 + cross.1 * cross.1 + cross.2 * cross.2 <= 1e-20
    }

    static func encode(_ packet: ScanMeshPacket) throws -> Data {
        try validate(packet)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(packet)
        guard data.count <= maximumJSONBytes else { throw ScanMeshError.invalid("mesh JSON exceeds 96 MiB; scan a smaller area") }
        return data
    }
}
