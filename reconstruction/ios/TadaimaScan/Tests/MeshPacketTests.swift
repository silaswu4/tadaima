import Foundation

@main
struct MeshPacketTests {
    static let identity: [Float] = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
    static let vertices: [[Float]] = [[0,0,0], [1,0,0], [0,1,0]]
    static func anchor(transform: [Float] = identity, vertices: [[Float]] = vertices,
                       faces: [[Int]] = [[0,1,2]], classifications: [Int] = [0]) -> ScanMeshAnchorPacket {
        ScanMeshAnchorPacket(id: "mesh-00000000-0000-4000-8000-000000000001", transform: transform,
            vertices: vertices, faces: faces, classifications: classifications)
    }
    static func packet(_ anchors: [ScanMeshAnchorPacket]) -> ScanMeshPacket {
        ScanMeshPacket(projectId: "synthetic-test", jobId: "synthetic-scan", inputRevision: 0, anchors: anchors)
    }
    static func rejects(_ label: String, _ action: () throws -> Void) {
        do { try action() } catch { return }
        fatalError("Expected rejection: \(label)")
    }
    /// Synthetic topology at the recovered room's counts, not a physical capture fixture.
    static func syntheticObservedSize() -> ScanMeshPacket {
        var anchors: [ScanMeshAnchorPacket] = []
        for index in 0..<72 {
            let vertexCount = 319_580 / 72 + (index < 319_580 % 72 ? 1 : 0)
            let faceCount = 579_341 / 72 + (index < 579_341 % 72 ? 1 : 0)
            let points: [[Float]] = (0..<vertexCount).map { [Float($0 % 64) * 0.025, Float($0 / 64) * 0.025, 0] }
            var faces: [[Int]] = []
            for start in 0..<vertexCount {
                guard start % 64 < 63, start + 65 < vertexCount else { continue }
                for triangle in [[start, start + 1, start + 64], [start + 1, start + 65, start + 64]] {
                    if faces.count < faceCount { faces.append(triangle) }
                }
                if faces.count == faceCount { break }
            }
            precondition(faces.count == faceCount)
            var transform = identity
            transform[12] = Float(index % 9) * 3; transform[14] = Float(index / 9) * 3
            anchors.append(ScanMeshAnchorPacket(id: "mesh-00000000-0000-4000-8000-" + String(format: "%012x", index + 1),
                transform: transform, vertices: points, faces: faces,
                classifications: Array(repeating: 0, count: faceCount)))
        }
        return packet(anchors)
    }

    static func main() throws {
        precondition(ScanMeshWire.maximumVertices == 400_000 && ScanMeshWire.maximumFaces == 600_000)
        precondition(ScanMeshWire.maximumJSONBytes == 96 * 1024 * 1024)
        let fullRoom = syntheticObservedSize()
        precondition(fullRoom.anchors.count == 72)
        precondition(fullRoom.anchors.reduce(0) { $0 + $1.vertices.count } == 319_580)
        precondition(fullRoom.anchors.reduce(0) { $0 + $1.faces.count } == 579_341)
        _ = try ScanMeshWire.encode(fullRoom)
        let data = try ScanMeshWire.encode(packet([anchor()]))
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        precondition(Set(json.keys) == ["schemaVersion", "projectId", "jobId", "inputRevision", "coordinateSystem", "captureMethod", "anchors"])
        precondition(json["schemaVersion"] as? String == "roomplan-mesh/1.0")
        var translated = identity; translated[12] = 12; translated[13] = -1.2
        try ScanMeshWire.validate(packet([anchor(transform: translated)]))
        rejects("empty scan") { try ScanMeshWire.validate(packet([])) }
        rejects("repeated anchors") { try ScanMeshWire.validate(packet([anchor(), anchor()])) }
        rejects("nonfinite vertex") { try ScanMeshWire.validate(packet([anchor(vertices: [[.nan,0,0], [1,0,0], [0,1,0]])])) }
        rejects("vertex bounds") { try ScanMeshWire.validate(packet([anchor(vertices: [[10_001,0,0], [1,0,0], [0,1,0]])])) }
        rejects("bad index") { try ScanMeshWire.validate(packet([anchor(faces: [[0,1,3]])])) }
        rejects("negative index") { try ScanMeshWire.validate(packet([anchor(faces: [[0,1,-1]])])) }
        rejects("repeated triangle index") { try ScanMeshWire.validate(packet([anchor(faces: [[0,1,1]])])) }
        rejects("zero area") { try ScanMeshWire.validate(packet([anchor(vertices: [[0,0,0], [1,0,0], [2,0,0]])])) }
        rejects("duplicate opposite-winding face") {
            try ScanMeshWire.validate(packet([anchor(faces: [[0,1,2], [2,1,0]], classifications: [0,0])]))
        }
        rejects("classification length") { try ScanMeshWire.validate(packet([anchor(classifications: [])])) }
        rejects("classification value") { try ScanMeshWire.validate(packet([anchor(classifications: [8])])) }
        var reflected = identity; reflected[0] = -1
        rejects("reflection") { try ScanMeshWire.validate(packet([anchor(transform: reflected)])) }
        var scaled = identity; scaled[0] = 2
        rejects("nonrigid") { try ScanMeshWire.validate(packet([anchor(transform: scaled)])) }
        var projective = identity; projective[3] = 0.2
        rejects("projective transform") { try ScanMeshWire.validate(packet([anchor(transform: projective)])) }
        rejects("face limit") { try ScanMeshWire.validate(packet([anchor(faces: Array(repeating: [0,1,2], count: ScanMeshWire.maximumFaces + 1), classifications: Array(repeating: 0, count: ScanMeshWire.maximumFaces + 1))])) }
        rejects("vertex limit") { try ScanMeshWire.validate(packet([anchor(vertices: Array(repeating: [0,0,0], count: ScanMeshWire.maximumVertices + 1))])) }
        print("PASS: synthetic observed-size room (72 anchors, 319580 vertices, 579341 faces), identity, rigid transforms, finite vertices, triangle indices, degeneracy, classification and geometry bounds")
    }
}
